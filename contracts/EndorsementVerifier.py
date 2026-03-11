# v0.5.0
# { "Depends": "py-genlayer:latest" }
"""EndorsementVerifier — Minimal GenLayer oracle for author endorsement.

Stripped-down for reliable Studionet consensus:
- Short prompt, aggressive content truncation
- Clean JSON, simple criteria
"""

from genlayer import *
import json

genvm_eth = gl.evm

FORUM_URL = "https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902"


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
            resp = gl.nondet.web.get(FORUM_URL)
            if not resp or resp.status != 200 or not resp.body:
                return '{"verdict":"REJECT","reasoning":"Could not fetch forum thread"}'

            content = resp.body.decode("utf-8", errors="replace")[:15000]

            prompt = (
                "Has any ERC-8183 author (dcrapis, ai-virtual-b, twx-virtuals, Zuhwa) "
                "posted a positive reply about " + url + " in this thread? "
                "Reply JSON: {\"verdict\":\"ACCEPT\" or \"REJECT\",\"reasoning\":\"one sentence\"}\n\n"
                + content
            )

            raw = gl.nondet.exec_prompt(prompt)
            s = str(raw).strip()
            s = s.replace("```json", "").replace("```", "").strip()
            start = s.find("{")
            end = s.rfind("}") + 1
            if start >= 0 and end > start:
                s = s[start:end]
            return s

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Check if an ERC-8183 author endorsed a proposal on a forum",
            criteria="Verdict must be ACCEPT or REJECT. Reasoning must be one sentence.",
        )

        try:
            s = str(result_str).strip()
            s = s.replace("```json", "").replace("```", "").strip()
            start = s.find("{")
            end = s.rfind("}") + 1
            if start >= 0 and end > start:
                s = s[start:end]
            parsed = json.loads(s)
            v = str(parsed.get("verdict", "REJECT")).strip().upper()
            r = str(parsed.get("reasoning", "")).strip()
        except:
            v = "REJECT"
            r = "Could not parse verification result"

        if v not in ("ACCEPT", "REJECT"):
            v = "REJECT"

        self.verdict = v
        self.verdict_reason = r[:300]

        verdict_uint8 = 1 if v == "ACCEPT" else 2
        reason_hash = genvm_eth.keccak256(self.verdict_reason.encode("utf-8"))

        enc = genvm_eth.MethodEncoder("", [u256, u8, u8, bytes32, str], bool)
        data = enc.encode_call(
            [u256(int(job_id)), u8(2), verdict_uint8, reason_hash, self.verdict_reason]
        )[4:]

        wrapper = genvm_eth.MethodEncoder("", [Address, bytes], bool)
        msg = wrapper.encode_call([Address(evaluator_contract), data])[4:]

        bridge = gl.get_contract_at(Address(bridge_sender))
        bridge.emit().send_message(int(self.target_chain_eid), target_contract, msg)

    @gl.public.view
    def get_verdict(self) -> str:
        return self.verdict

    @gl.public.view
    def get_reason(self) -> str:
        return self.verdict_reason

    @gl.public.view
    def get_status(self) -> str:
        return self.verdict
