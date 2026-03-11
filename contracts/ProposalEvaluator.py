# v0.6.0
# { "Depends": "py-genlayer:latest" }
"""ProposalEvaluator — Minimal GenLayer AI Jury for ERC-8183 Bounty.

Stripped-down version for reliable Studionet consensus:
- Short prompt, small content window
- Clean JSON output with aggressive stripping
- Simple verification criteria for co-validators
"""

from genlayer import *
import json

genvm_eth = gl.evm


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
                return '{"verdict":"REJECT","reasoning":"Could not fetch proposal"}'

            content = resp.body.decode("utf-8", errors="replace")[:8000]

            prompt = (
                "Does this document propose an extension to ERC-8183 with: "
                "(a) a design analysis, (b) architecture, (c) graduated verdicts, "
                "(d) example flow, (e) compatibility via hooks? "
                "Reply JSON: {\"verdict\":\"ACCEPT\" or \"REJECT\",\"reasoning\":\"one sentence\"}\n\n"
                + content
            )

            raw = gl.nondet.exec_prompt(prompt)
            # Aggressively clean output
            s = str(raw).strip()
            s = s.replace("```json", "").replace("```", "").strip()
            # Find the JSON object
            start = s.find("{")
            end = s.rfind("}") + 1
            if start >= 0 and end > start:
                s = s[start:end]
            return s

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Evaluate if a document proposes an ERC-8183 extension",
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
            r = "Could not parse evaluation result"

        if v not in ("ACCEPT", "REJECT"):
            v = "REJECT"

        self.verdict = v
        self.verdict_reason = r[:300]

        verdict_uint8 = 1 if v == "ACCEPT" else 2
        reason_hash = genvm_eth.keccak256(self.verdict_reason.encode("utf-8"))

        enc = genvm_eth.MethodEncoder("", [u256, u8, bytes32, str], bool)
        data = enc.encode_call(
            [u256(int(job_id)), verdict_uint8, reason_hash, self.verdict_reason]
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
