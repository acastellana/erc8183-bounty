# v0.4.0
# { "Depends": "py-genlayer:latest" }
"""ProposalEvaluator — GenLayer AI Jury for ERC-8183 Court-Aware Extension Bounty.

Uses prompt_non_comparative with a simple integer output (0-5) that
co-validators can easily verify. The leader scores the proposal,
co-validators check if the score is reasonable given the content.

Verdict codes (match GenLayerEvaluator.sol):
    ACCEPT (1) — score >= 5 → triggers complete()
    REJECT (2) — score < 5 → triggers reject()
"""

from genlayer import *
import json

genvm_eth = gl.evm

VERDICT_ACCEPT = 1
VERDICT_REJECT = 2
THRESHOLD = 5


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

        def evaluate():
            resp = gl.nondet.web.get(url)
            if not resp or resp.status != 200 or not resp.body:
                return "0|Could not fetch proposal"

            content = resp.body.decode("utf-8", errors="replace")
            if len(content) > 40000:
                content = content[:40000] + "\n[TRUNCATED]"

            prompt = f"""Score this ERC-8183 extension proposal on 5 criteria (1 point each):

1. DESIGN MEMO — clear doc analyzing ERC-8183 limitations + proposed extension
2. ARCHITECTURE DIAGRAM — visual showing base contract + extensions + bridge
3. JUDGMENT MODEL — graduated verdicts (partial payout/penalties/resubmission)
4. EXAMPLE FLOW — end-to-end walkthrough with specific values
5. COMPATIBILITY — uses hooks/evaluators, does NOT modify core ERC-8183

PROPOSAL:
{content}

Output format: SCORE|REASON
Where SCORE is 0-5 (criteria met count) and REASON is one sentence.
Example: 3|Missing architecture diagram and example flow."""

            result = gl.nondet.exec_prompt(prompt)
            return str(result).strip()

        result_str = gl.eq_principle.prompt_non_comparative(
            evaluate,
            task="Score an ERC-8183 extension proposal 0-5 based on five criteria",
            criteria=(
                "Output must be SCORE|REASON where SCORE is 0-5. "
                "Score should accurately reflect how many of the 5 criteria "
                "(design memo, architecture, judgment model, example flow, compatibility) "
                "are clearly present in the proposal."
            ),
        )

        # Parse score from "SCORE|REASON" format
        try:
            parts = str(result_str).split("|", 1)
            score_val = int("".join(c for c in parts[0] if c.isdigit())[:1] or "0")
            reason = parts[1].strip() if len(parts) > 1 else "No reason provided"
        except:
            score_val = 0
            reason = f"Parse error: {str(result_str)[:200]}"

        self.score = str(score_val)
        self.verdict = "ACCEPT" if score_val >= THRESHOLD else "REJECT"
        self.verdict_reason = f"Score {score_val}/5. {reason}"

        verdict_uint8 = VERDICT_ACCEPT if self.verdict == "ACCEPT" else VERDICT_REJECT
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
