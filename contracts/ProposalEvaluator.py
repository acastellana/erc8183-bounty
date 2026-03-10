# v0.2.0
# { "Depends": "py-genlayer:latest" }
"""ProposalEvaluator — GenLayer AI Jury for ERC-8183 Court-Aware Extension Bounty.

Evaluates proposals submitted to an ERC-8183 AgenticCommerce job.
The AI jury fetches the submitted proposal URL and evaluates it against
five mandatory criteria for court-aware extensions to the Agentic Commerce Protocol.

Context: ERC-8183 defines a job escrow with evaluator attestation:
  - Three roles: client (funds), provider (works), evaluator (attests)
  - Six states: Open → Funded → Submitted → Completed | Rejected | Expired
  - Extensible via IACPHook (beforeAction/afterAction callbacks)
  - No built-in dispute resolution — reject/expire is final

The bounty seeks extensions that add:
  - Partial payouts (not just all-or-nothing complete/reject)
  - Graduated penalties via hooks
  - Resubmission windows
  - Multi-round evaluation
  - Dispute escalation through GenLayer AI adjudication

Verdict codes (match GenLayerEvaluator.sol):
    ACCEPT (1) — meets all five criteria → triggers complete() on AgenticCommerce
    REJECT (2) — fails criteria → triggers reject() on AgenticCommerce

Guideline is frozen and versioned.
Current version: court-ext-v1
"""

from genlayer import *
import json

genvm_eth = gl.evm

# ─── Frozen guideline versions ────────────────────────────────────────────────

GUIDELINES = {
    "court-ext-v1": (
        "You are evaluating a proposal for extending ERC-8183 (Agentic Commerce Protocol) "
        "with court-aware dispute resolution powered by GenLayer AI adjudication.\n\n"
        "ERC-8183 CONTEXT (what the proposal must build on):\n"
        "- ERC-8183 is a job escrow with evaluator attestation for AI agent commerce\n"
        "- Three roles: client (funds escrow), provider (does work), evaluator (attests completion)\n"
        "- Six states: Open → Funded → Submitted → Completed | Rejected | Expired\n"
        "- Extensible via IACPHook interface: beforeAction/afterAction callbacks per job\n"
        "- Core limitation: 'No dispute resolution or arbitration; reject/expire is final'\n"
        "- The evaluator is a single address — can be a smart contract (e.g., GenLayer bridge)\n\n"
        "Evaluate the submission against ALL FIVE mandatory criteria:\n\n"
        "1. DESIGN MEMO: Does the proposal contain a clear design document that:\n"
        "   - Identifies the specific limitations of ERC-8183's binary complete/reject model\n"
        "   - Proposes a concrete extension using hooks and/or evaluator contracts\n"
        "   - Explains how GenLayer AI adjudication integrates with the ERC-8183 lifecycle\n"
        "   - Discusses tradeoffs (gas cost, complexity, trust assumptions)\n\n"
        "2. ARCHITECTURE DIAGRAM: Does the proposal include a visual system overview that:\n"
        "   - Shows the ERC-8183 AgenticCommerce contract as the base\n"
        "   - Shows how hooks (IACPHook) and/or evaluator contracts extend it\n"
        "   - Shows the GenLayer bridge path for AI jury evaluation\n"
        "   - Identifies which components live on which chain (L1/L2 vs GenLayer)\n\n"
        "3. JUDGMENT MODEL: Does the proposal define how evaluator verdicts map to outcomes:\n"
        "   - Goes beyond binary complete/reject to support graduated outcomes\n"
        "   - Supports at least TWO of: partial payout, penalty tiers, refund with deduction, resubmission\n"
        "   - Defines specific verdict codes and their fund distribution rules\n"
        "   - Explains how this works within ERC-8183's state machine constraints\n\n"
        "4. CONCRETE EXAMPLE FLOW: Does the proposal include an end-to-end walkthrough:\n"
        "   - Uses specific values (token amounts, job IDs, timestamps)\n"
        "   - Shows each ERC-8183 function call in sequence (createJob → fund → submit → ...)\n"
        "   - Demonstrates at least one non-trivial outcome (partial payout or penalty)\n"
        "   - Shows the GenLayer AI jury evaluation step with example verdict\n\n"
        "5. ERC-8183 COMPATIBILITY: Does the proposal preserve the standard:\n"
        "   - Does NOT modify AgenticCommerce core contract or IERC8183 interface\n"
        "   - Uses hooks (IACPHook) and/or custom evaluator contracts as extension points\n"
        "   - Existing ERC-8183 jobs without hooks continue to work unchanged\n"
        "   - The extension is opt-in per job (via hook address at createJob)\n\n"
        "A proposal MUST meet ALL FIVE criteria to receive ACCEPT. "
        "If any single criterion is clearly unmet, return REJECT with specific feedback "
        "explaining what is missing and how to improve."
    )
}

VERDICT_ACCEPT = 1
VERDICT_REJECT = 2


class ProposalEvaluator(gl.Contract):
    """Evaluates ERC-8183 extension proposals; sends verdict via bridge."""

    job_id:                str   # ERC-8183 job ID
    bounty_contract:       str   # AgenticCommerce address on Base Sepolia
    evaluator_contract:    str   # GenLayerEvaluator address on Base Sepolia
    proposal_url:          str
    guideline_version:     str
    bridge_sender:         str
    target_chain_eid:      u256
    verdict:               str
    verdict_reason:        str
    criteria_scores:       str

    def __init__(
        self,
        job_id: str,
        bounty_contract: str,
        evaluator_contract: str,
        proposal_url: str,
        guideline_version: str,
        bridge_sender: str,
        target_chain_eid: int,
        target_contract: str,
    ):
        if guideline_version not in GUIDELINES:
            raise Exception(f"Unknown guideline '{guideline_version}'")

        self.job_id             = job_id
        self.bounty_contract    = bounty_contract
        self.evaluator_contract = evaluator_contract
        self.proposal_url       = proposal_url
        self.guideline_version  = guideline_version
        self.bridge_sender      = bridge_sender
        self.target_chain_eid   = u256(target_chain_eid)

        guideline = GUIDELINES[guideline_version]
        url = proposal_url
        jid = job_id

        def nondet():
            resp = gl.nondet.web.get(url)
            fetch_ok = resp and resp.status == 200 and resp.body

            if not fetch_ok:
                return json.dumps({
                    "verdict": "REJECT",
                    "reason": f"Could not fetch proposal from {url} (HTTP {resp.status if resp else 'no response'})",
                    "criteria": {
                        "design_memo": False, "architecture_diagram": False,
                        "judgment_model": False, "example_flow": False,
                        "erc8183_compatibility": False
                    },
                    "feedback": "Ensure the proposal URL is publicly accessible."
                })

            content = resp.body.decode("utf-8", errors="replace")
            if len(content) > 50000:
                content = content[:50000] + "\n\n[TRUNCATED — document exceeds 50KB]"

            prompt = f"""You are an AI juror evaluating a proposal for extending ERC-8183 with court-aware dispute resolution.

SUBMISSION URL: {url}
JOB ID: {jid}

PROPOSAL CONTENT:
{content}

EVALUATION GUIDELINE:
{guideline}

Evaluate rigorously but fairly. A well-structured proposal with genuine technical depth that engages with the actual ERC-8183 spec (hooks, evaluator contracts, state machine) should pass. A superficial or generic submission should fail.

Output ONLY valid JSON:
{{
  "verdict": "ACCEPT" | "REJECT",
  "reason": "Two to three sentences summarizing the overall evaluation.",
  "criteria": {{
    "design_memo": true | false,
    "architecture_diagram": true | false,
    "judgment_model": true | false,
    "example_flow": true | false,
    "erc8183_compatibility": true | false
  }},
  "feedback": "Specific actionable feedback for the submitter (2-4 sentences)."
}}"""

            result = gl.nondet.exec_prompt(prompt)
            return result.strip() if isinstance(result, str) else str(result).strip()

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Evaluate an ERC-8183 court-aware extension proposal against five mandatory criteria",
            criteria=(
                "Verdict must be exactly 'ACCEPT' or 'REJECT'. "
                "All five criteria must be boolean. "
                "ACCEPT requires all five true. REJECT requires at least one false. "
                "Reason must reference specific criteria. "
                "Feedback must be actionable and specific to the proposal content."
            ),
        )

        try:
            clean = result_str.replace("```json", "").replace("```", "").strip() if isinstance(result_str, str) else str(result_str)
            parsed = json.loads(clean) if isinstance(clean, str) else clean

            v = parsed.get("verdict", "REJECT").strip().upper()
            r = parsed.get("reason", "").strip()
            criteria = parsed.get("criteria", {})
            feedback = parsed.get("feedback", "").strip()

            if v == "ACCEPT":
                all_pass = all(criteria.get(k, False) for k in [
                    "design_memo", "architecture_diagram", "judgment_model",
                    "example_flow", "erc8183_compatibility"
                ])
                if not all_pass:
                    v = "REJECT"
                    r = f"Override: not all criteria passed. {r}"

        except Exception as e:
            v = "REJECT"
            r = f"Parse error: {str(e)}"
            criteria = {}
            feedback = ""

        if v not in ("ACCEPT", "REJECT"):
            v = "REJECT"

        self.verdict = v
        self.verdict_reason = f"{r} | Feedback: {feedback}" if feedback else r
        self.criteria_scores = json.dumps(criteria)

        verdict_uint8 = VERDICT_ACCEPT if v == "ACCEPT" else VERDICT_REJECT
        reason_hash = genvm_eth.keccak256(self.verdict_reason.encode("utf-8"))

        # ABI-encode: (uint256 jobId, uint8 verdict, bytes32 reason, string details)
        resolution_encoder = genvm_eth.MethodEncoder("", [u256, u8, bytes32, str], bool)
        resolution_data = resolution_encoder.encode_call(
            [u256(int(job_id)), verdict_uint8, reason_hash, self.verdict_reason]
        )[4:]

        # Outer wrapper for bridge: (address target, bytes data)
        wrapper_encoder = genvm_eth.MethodEncoder("", [Address, bytes], bool)
        message_bytes = wrapper_encoder.encode_call(
            [Address(evaluator_contract), resolution_data]
        )[4:]

        bridge = gl.get_contract_at(Address(bridge_sender))
        bridge.emit().send_message(
            int(self.target_chain_eid),
            target_contract,
            message_bytes
        )

    @gl.public.view
    def get_verdict(self) -> str:
        return json.dumps({
            "job_id":          self.job_id,
            "verdict":         self.verdict,
            "verdict_reason":  self.verdict_reason,
            "criteria_scores": json.loads(self.criteria_scores) if self.criteria_scores else {},
            "proposal_url":    self.proposal_url,
            "guideline":       self.guideline_version,
        })

    @gl.public.view
    def get_status(self) -> str:
        return self.verdict
