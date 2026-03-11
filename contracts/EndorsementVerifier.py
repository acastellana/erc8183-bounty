# v0.4.0
# { "Depends": "py-genlayer:latest" }
"""EndorsementVerifier — GenLayer oracle for ERC-8183 author endorsement.

Uses prompt_non_comparative following the InternetCourt pattern:
- Leader checks forum and returns JSON with verdict + reasoning
- Co-validators verify: is verdict valid? does reasoning make sense?

Verdict codes (match GenLayerEvaluator.sol):
    ACCEPT (1) — author endorsement found
    REJECT (2) — no endorsement found
"""

from genlayer import *
import json

genvm_eth = gl.evm

VERDICT_ACCEPT = 1
VERDICT_REJECT = 2

FORUM_THREAD_URL = "https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902"


class EndorsementVerifier(gl.Contract):
    job_id:              str
    proposal_url:        str
    evaluator_contract:  str
    bridge_sender:       str
    target_chain_eid:    u256
    verdict:             str
    verdict_reason:      str

    def __init__(
        self,
        job_id: str,
        proposal_url: str,
        evaluator_contract: str,
        bridge_sender: str,
        target_chain_eid: int,
        target_contract: str,
    ):
        self.job_id             = job_id
        self.proposal_url       = proposal_url
        self.evaluator_contract = evaluator_contract
        self.bridge_sender      = bridge_sender
        self.target_chain_eid   = u256(target_chain_eid)

        url = proposal_url

        def nondet():
            resp = gl.nondet.web.get(FORUM_THREAD_URL)
            if not resp or resp.status != 200 or not resp.body:
                return json.dumps({
                    "verdict": "REJECT",
                    "reasoning": "Could not fetch Ethereum Magicians thread"
                })

            content = resp.body.decode("utf-8", errors="replace")
            if len(content) > 60000:
                content = content[:60000]

            prompt = f"""Check if any original ERC-8183 author has positively endorsed the proposal at {url} on this Ethereum Magicians forum thread.

ERC-8183 authors: @dcrapis (Davide Crapis), @ai-virtual-b (Bryan Lim), @twx-virtuals (Tay Weixiong), @Zuhwa (Chooi Zuhwa)

FORUM THREAD:
{content[:50000]}

A positive endorsement = author expresses support, approval, or constructive interest.
Merely asking questions without expressing support does NOT count.

Respond with ONLY a JSON object:
{{"verdict": "ACCEPT" or "REJECT", "reasoning": "1-2 sentence explanation of what was found."}}"""

            result = gl.nondet.exec_prompt(prompt)
            if isinstance(result, str):
                result = result.replace("```json", "").replace("```", "").strip()
            return result

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Check if an ERC-8183 author endorsed a proposal on Ethereum Magicians",
            criteria="The verdict must be ACCEPT or REJECT. The reasoning must state which author endorsed or that none did.",
        )

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

        resolution_encoder = genvm_eth.MethodEncoder("", [u256, u8, u8, bytes32, str], bool)
        resolution_data = resolution_encoder.encode_call(
            [u256(int(job_id)), u8(2), verdict_uint8, reason_hash, self.verdict_reason]
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
