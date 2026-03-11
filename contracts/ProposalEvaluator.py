# v0.5.0
# { "Depends": "py-genlayer:latest" }
"""ProposalEvaluator — GenLayer AI Jury for ERC-8183 Court-Aware Extension Bounty.

Uses prompt_non_comparative following the InternetCourt pattern:
- Leader evaluates and returns JSON with verdict + reasoning
- Co-validators verify: is verdict valid? does reasoning address the criteria?
- Co-validators do NOT re-evaluate the proposal themselves

Verdict codes (match GenLayerEvaluator.sol):
    ACCEPT (1) — all criteria met
    REJECT (2) — criteria not met
"""

from genlayer import *
import json

genvm_eth = gl.evm

VERDICT_ACCEPT = 1
VERDICT_REJECT = 2


class ProposalEvaluator(gl.Contract):
    job_id:             str
    bounty_contract:    str
    evaluator_contract: str
    proposal_url:       str
    bridge_sender:      str
    target_chain_eid:   u256
    verdict:            str
    verdict_reason:     str

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

        def nondet():
            resp = gl.nondet.web.get(url)
            if not resp or resp.status != 200 or not resp.body:
                return json.dumps({
                    "verdict": "REJECT",
                    "reasoning": f"Could not fetch proposal from {url}"
                })

            content = resp.body.decode("utf-8", errors="replace")
            if len(content) > 40000:
                content = content[:40000] + "\n[TRUNCATED]"

            prompt = f"""You are evaluating a proposal for extending ERC-8183 with court-aware dispute resolution.

PROPOSAL:
{content}

CRITERIA (all 5 must be met for ACCEPT):
1. Design memo analyzing ERC-8183 limitations and proposing extension
2. Architecture diagram showing base contract + extensions + bridge
3. Judgment model with graduated verdicts (partial payout/penalties)
4. Concrete example flow with specific values
5. ERC-8183 compatibility (uses hooks/evaluators, no core changes)

Respond with ONLY a JSON object:
{{"verdict": "ACCEPT" or "REJECT", "reasoning": "2-3 sentence explanation referencing specific criteria."}}"""

            result = gl.nondet.exec_prompt(prompt)
            if isinstance(result, str):
                result = result.replace("```json", "").replace("```", "").strip()
            return result

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Evaluate an ERC-8183 extension proposal and render a verdict as JSON",
            criteria="The verdict must be ACCEPT or REJECT. The reasoning must reference specific evaluation criteria.",
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
            r = parsed.get("reasoning", "No reasoning provided").strip()
        except Exception as e:
            v = "REJECT"
            r = f"Parse error: {str(e)}"

        if v not in ("ACCEPT", "REJECT"):
            v = "REJECT"

        self.verdict = v
        self.verdict_reason = r

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
    def get_status(self) -> str:
        return self.verdict
