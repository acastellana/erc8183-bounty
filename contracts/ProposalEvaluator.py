# v0.1.0
# { "Depends": "py-genlayer:latest" }
"""ProposalEvaluator — GenLayer AI Jury for ERC-8183 Bounty Proposals.

Evaluates submissions to the ERC-8183 Court-Aware Extension bounty.
The AI jury fetches the submitted proposal (URL) and evaluates it against
five mandatory criteria:

    1. Design memo — clear problem statement, proposed solution, rationale
    2. Architecture diagram — visual system overview (can be ASCII/Mermaid)
    3. Judgment model — how verdicts map to outcomes (partial payout, penalty, etc.)
    4. Concrete example flow — end-to-end walkthrough with specific values
    5. ERC-8183 preservation — extends (not replaces) the minimal primitive

Verdict codes:
    ACCEPT (1) — meets all five criteria sufficiently
    REJECT (2) — fails one or more criteria

Returns verdict to Base Sepolia via the InternetCourt bridge.

Guideline is frozen and versioned.
Current version: bounty-proposal-v1
"""

from genlayer import *
import json

genvm_eth = gl.evm

# ─── Frozen guideline versions ────────────────────────────────────────────────

GUIDELINES = {
    "bounty-proposal-v1": (
        "You are evaluating a proposal for extending ERC-8183, a minimal escrow and "
        "evaluator primitive for smart contracts. The goal of the bounty is to find "
        "proposals that preserve ERC-8183 as a minimal base layer while enabling richer "
        "commercial outcomes through GenLayer-style AI adjudication.\n\n"
        "Evaluate the submission against ALL FIVE mandatory criteria:\n\n"
        "1. DESIGN MEMO: Does the proposal contain a clear design document that:\n"
        "   - States the problem being solved\n"
        "   - Proposes a specific extension architecture\n"
        "   - Explains rationale and tradeoffs\n"
        "   - Is written at a professional engineering level\n\n"
        "2. ARCHITECTURE DIAGRAM: Does the proposal include a visual system overview that:\n"
        "   - Shows the relationship between ERC-8183 base and the extension\n"
        "   - Identifies key contracts/components\n"
        "   - Shows data/control flow between components\n"
        "   (ASCII art, Mermaid diagrams, or image links all count)\n\n"
        "3. JUDGMENT MODEL: Does the proposal define how evaluator verdicts map to outcomes:\n"
        "   - Supports at least: partial payout, full refund, penalty, or resubmission\n"
        "   - Defines verdict codes and their semantics\n"
        "   - Explains how the model extends beyond binary accept/reject\n\n"
        "4. CONCRETE EXAMPLE FLOW: Does the proposal include an end-to-end walkthrough:\n"
        "   - Uses specific values (amounts, addresses, timestamps)\n"
        "   - Shows each step from deposit through resolution\n"
        "   - Demonstrates at least one non-trivial outcome (not just accept/reject)\n\n"
        "5. ERC-8183 PRESERVATION: Does the proposal preserve the minimal primitive:\n"
        "   - Does NOT modify the IERC8183 interface itself\n"
        "   - Layers extensions on top (inheritance, composition, or wrapper)\n"
        "   - Existing ERC-8183 contracts remain valid without changes\n\n"
        "A proposal MUST meet ALL FIVE criteria to receive ACCEPT. "
        "If any single criterion is clearly unmet, return REJECT with specific feedback."
    )
}

# Verdict codes — must match BountyEscrow8183.sol
VERDICT_ACCEPT = 1
VERDICT_REJECT = 2


class ProposalEvaluator(gl.Contract):
    """Evaluates bounty proposals on construction; sends result via bridge."""

    submission_id:         str   # bytes32 hex from BountyEscrow8183
    bounty_contract:       str   # BountyEscrow8183 address on Base Sepolia
    proposal_url:          str
    guideline_version:     str
    bridge_sender:         str   # BridgeSender.py address on GenLayer
    target_chain_eid:      u256  # LayerZero EID for Base Sepolia (40245)
    verdict:               str
    verdict_reason:        str
    criteria_scores:       str   # JSON of per-criterion scores

    def __init__(
        self,
        submission_id: str,
        bounty_contract: str,
        proposal_url: str,
        guideline_version: str,
        bridge_sender: str,
        target_chain_eid: int,
        target_contract: str,  # InternetCourtFactory or direct bounty on Base Sepolia
    ):
        if guideline_version not in GUIDELINES:
            raise Exception(f"ProposalEvaluator: unknown guideline '{guideline_version}'")

        self.submission_id     = submission_id
        self.bounty_contract   = bounty_contract
        self.proposal_url      = proposal_url
        self.guideline_version = guideline_version
        self.bridge_sender     = bridge_sender
        self.target_chain_eid  = u256(target_chain_eid)

        guideline = GUIDELINES[guideline_version]

        # Copy to locals for non-det block
        url = proposal_url
        sub_id = submission_id

        def nondet():
            # Fetch the proposal content
            resp = gl.nondet.web.get(url)
            fetch_ok = resp and resp.status == 200 and resp.body

            if not fetch_ok:
                return json.dumps({
                    "verdict": "REJECT",
                    "reason": f"Could not fetch proposal from {url} (HTTP {resp.status if resp else 'no response'})",
                    "criteria": {
                        "design_memo": False,
                        "architecture_diagram": False,
                        "judgment_model": False,
                        "example_flow": False,
                        "erc8183_preservation": False
                    }
                })

            content = resp.body.decode("utf-8", errors="replace")

            # Truncate very long documents to avoid token limits
            if len(content) > 50000:
                content = content[:50000] + "\n\n[TRUNCATED — document exceeds 50KB]"

            prompt = f"""You are an AI juror evaluating a proposal submission for the ERC-8183 Court-Aware Extension bounty.

SUBMISSION URL: {url}
SUBMISSION ID: {sub_id}

PROPOSAL CONTENT:
{content}

EVALUATION GUIDELINE:
{guideline}

Evaluate the proposal against each of the five criteria. Be rigorous but fair.
A well-structured proposal with genuine technical depth should pass.
A superficial or template-like submission should fail.

Output ONLY valid JSON, no other text:
{{
  "verdict": "ACCEPT" | "REJECT",
  "reason": "Two to three sentences summarizing the overall evaluation.",
  "criteria": {{
    "design_memo": true | false,
    "architecture_diagram": true | false,
    "judgment_model": true | false,
    "example_flow": true | false,
    "erc8183_preservation": true | false
  }},
  "feedback": "Specific actionable feedback for the submitter (2-4 sentences)."
}}"""

            result = gl.nondet.exec_prompt(prompt)
            if isinstance(result, str):
                return result.strip()
            return str(result).strip()

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Evaluate an ERC-8183 extension proposal against five mandatory criteria",
            criteria=(
                "The verdict must be exactly 'ACCEPT' or 'REJECT'. "
                "All five criteria fields must be boolean. "
                "ACCEPT requires all five criteria to be true. "
                "REJECT requires at least one criterion to be false. "
                "The reason must reference specific criteria outcomes. "
                "The feedback must be actionable and specific to the proposal content."
            ),
        )

        # Parse result
        try:
            if isinstance(result_str, str):
                clean = result_str.replace("```json", "").replace("```", "").strip()
                parsed = json.loads(clean)
            elif isinstance(result_str, dict):
                parsed = result_str
            else:
                parsed = json.loads(str(result_str))

            v = parsed.get("verdict", "REJECT").strip().upper()
            r = parsed.get("reason", "").strip()
            criteria = parsed.get("criteria", {})
            feedback = parsed.get("feedback", "").strip()

            # Validate: ACCEPT requires all 5 true
            if v == "ACCEPT":
                all_pass = all(criteria.get(k, False) for k in [
                    "design_memo", "architecture_diagram", "judgment_model",
                    "example_flow", "erc8183_preservation"
                ])
                if not all_pass:
                    v = "REJECT"
                    r = f"Verdict overridden: not all criteria passed. {r}"

        except Exception as e:
            v = "REJECT"
            r = f"Failed to parse evaluation response: {str(e)}"
            criteria = {}
            feedback = ""

        if v not in ("ACCEPT", "REJECT"):
            v = "REJECT"
            r = f"Unexpected verdict value '{v}', defaulting to REJECT."

        self.verdict        = v
        self.verdict_reason = f"{r} | Feedback: {feedback}" if feedback else r
        self.criteria_scores = json.dumps(criteria)

        # Map to uint8
        verdict_uint8 = VERDICT_ACCEPT if v == "ACCEPT" else VERDICT_REJECT

        # ABI-encode the resolution payload for bridge delivery:
        # (bytes32 submissionId, uint8 verdict, string reason)
        resolution_encoder = genvm_eth.MethodEncoder("", [bytes32, u8, str], bool)
        resolution_data = resolution_encoder.encode_call(
            [bytes32(bytes.fromhex(submission_id.replace("0x", ""))),
             verdict_uint8,
             self.verdict_reason]
        )[4:]  # strip selector

        # Outer wrapper: (address agreementAddress, bytes resolutionData)
        wrapper_encoder = genvm_eth.MethodEncoder("", [Address, bytes], bool)
        message_bytes = wrapper_encoder.encode_call(
            [Address(bounty_contract), resolution_data]
        )[4:]  # strip selector

        # Send via bridge → Base Sepolia
        bridge = gl.get_contract_at(Address(bridge_sender))
        bridge.emit().send_message(
            int(self.target_chain_eid),
            target_contract,
            message_bytes
        )

    # ─── Views ───────────────────────────────────────────────────────────────

    @gl.public.view
    def get_verdict(self) -> str:
        return json.dumps({
            "submission_id":   self.submission_id,
            "verdict":         self.verdict,
            "verdict_reason":  self.verdict_reason,
            "criteria_scores": json.loads(self.criteria_scores) if self.criteria_scores else {},
            "proposal_url":    self.proposal_url,
            "guideline":       self.guideline_version,
        })

    @gl.public.view
    def get_status(self) -> str:
        return self.verdict
