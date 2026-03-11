# v0.3.0
# { "Depends": "py-genlayer:latest" }
"""ProposalEvaluator — GenLayer AI Jury for ERC-8183 Court-Aware Extension Bounty.

Uses threshold-based consensus: each validator scores 0-5 criteria,
then validators agree on whether score >= 5 (ACCEPT) or < 5 (REJECT).
This produces a boolean that validators can reach consensus on,
unlike free-form JSON which causes UNDETERMINED on multi-LLM setups.

Verdict codes (match GenLayerEvaluator.sol):
    ACCEPT (1) — all 5 criteria met → triggers complete()
    REJECT (2) — any criteria unmet → triggers reject()
"""

from genlayer import *
import json

genvm_eth = gl.evm

GUIDELINE = (
    "Evaluate this ERC-8183 court-aware extension proposal against FIVE criteria:\n\n"
    "1. DESIGN MEMO: Clear document identifying ERC-8183 limitations, proposing "
    "concrete extension via hooks/evaluator contracts, explaining GenLayer integration, "
    "discussing tradeoffs.\n\n"
    "2. ARCHITECTURE DIAGRAM: Visual showing AgenticCommerce base + extension "
    "components + GenLayer bridge path + chain placement.\n\n"
    "3. JUDGMENT MODEL: Graduated verdicts beyond binary complete/reject. Must support "
    "at least TWO of: partial payout, penalty tiers, refund with deduction, resubmission. "
    "Defines verdict codes and fund distribution rules.\n\n"
    "4. CONCRETE EXAMPLE: End-to-end walkthrough with specific values (amounts, IDs, "
    "timestamps), showing each ERC-8183 function call and at least one non-trivial outcome.\n\n"
    "5. ERC-8183 COMPATIBILITY: Does NOT modify core AgenticCommerce or IERC8183. "
    "Uses hooks (IACPHook) and/or custom evaluators. Existing jobs work unchanged. "
    "Extension is opt-in per job.\n\n"
    "Return ONLY a single integer 0-5 representing how many criteria are clearly met."
)

VERDICT_ACCEPT = 1
VERDICT_REJECT = 2
THRESHOLD = 5  # all 5 must pass


class ProposalEvaluator(gl.Contract):
    job_id:             str
    bounty_contract:    str
    evaluator_contract: str
    proposal_url:       str
    bridge_sender:      str
    target_chain_eid:   u256
    verdict:            str
    verdict_reason:     str
    score:              str

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
        self.job_id             = job_id
        self.bounty_contract    = bounty_contract
        self.evaluator_contract = evaluator_contract
        self.proposal_url       = proposal_url
        self.bridge_sender      = bridge_sender
        self.target_chain_eid   = u256(target_chain_eid)

        url = proposal_url
        jid = job_id

        # Step 1: Fetch and score (non-deterministic)
        def get_score():
            resp = gl.nondet.web.get(url)
            if not resp or resp.status != 200 or not resp.body:
                return "0"

            content = resp.body.decode("utf-8", errors="replace")
            if len(content) > 50000:
                content = content[:50000] + "\n[TRUNCATED]"

            prompt = f"""You are evaluating a proposal for extending ERC-8183.

PROPOSAL CONTENT:
{content}

{GUIDELINE}

Be rigorous but fair. Count each criterion as met (1) or unmet (0).
Output ONLY a single digit: the total count of criteria met (0, 1, 2, 3, 4, or 5)."""

            result = gl.nondet.exec_prompt(prompt)
            # Extract just the number
            cleaned = "".join(c for c in str(result).strip() if c.isdigit())
            return cleaned[:1] if cleaned else "0"

        # Step 2: Get reason (non-deterministic)
        def get_reason():
            resp = gl.nondet.web.get(url)
            if not resp or resp.status != 200 or not resp.body:
                return "Could not fetch proposal"

            content = resp.body.decode("utf-8", errors="replace")[:30000]

            prompt = f"""Briefly summarize (2 sentences max) why this ERC-8183 extension proposal does or does not meet the five evaluation criteria (design memo, architecture diagram, judgment model, example flow, ERC-8183 compatibility).

PROPOSAL:
{content[:20000]}

Output ONLY the 2-sentence summary."""

            result = gl.nondet.exec_prompt(prompt)
            return str(result).strip()[:500]

        # Consensus on the score (validators must agree on the number)
        score_str = gl.eq_principle.prompt_comparative(
            get_score,
            task="Count how many of 5 evaluation criteria an ERC-8183 proposal meets",
            criteria="Output must be a single digit 0-5",
        )

        try:
            score_val = int("".join(c for c in str(score_str) if c.isdigit())[:1] or "0")
        except:
            score_val = 0

        self.score = str(score_val)

        # Determine verdict from score threshold
        if score_val >= THRESHOLD:
            v = "ACCEPT"
        else:
            v = "REJECT"

        # Get reason (non-comparative — just informational, doesn't need consensus)
        try:
            reason = get_reason()
        except:
            reason = f"Score: {score_val}/5"

        self.verdict = v
        self.verdict_reason = f"Score {score_val}/5. {reason}"

        verdict_uint8 = VERDICT_ACCEPT if v == "ACCEPT" else VERDICT_REJECT
        reason_hash = genvm_eth.keccak256(self.verdict_reason.encode("utf-8"))

        resolution_encoder = genvm_eth.MethodEncoder("", [u256, u8, bytes32, str], bool)
        resolution_data = resolution_encoder.encode_call(
            [u256(int(job_id)), verdict_uint8, reason_hash, self.verdict_reason]
        )[4:]

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
        return self.verdict

    @gl.public.view
    def get_reason(self) -> str:
        return self.verdict_reason

    @gl.public.view
    def get_score(self) -> str:
        return self.score

    @gl.public.view
    def get_status(self) -> str:
        return self.verdict
