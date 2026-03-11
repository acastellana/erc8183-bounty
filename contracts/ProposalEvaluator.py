# v0.7.0
# { "Depends": "py-genlayer:latest" }
"""ProposalEvaluator — Ultra-minimal GenLayer AI Jury.

Returns just verdict + one-sentence reason as "VERDICT: reason" string.
No JSON parsing needed — co-validators just check the verdict word.
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
                return "REJECT: Could not fetch proposal"

            content = resp.body.decode("utf-8", errors="replace")[:8000]

            prompt = (
                "Does this document propose a concrete extension to ERC-8183 "
                "with design analysis, architecture, graduated verdicts, "
                "example flow, and compatibility via hooks?\n\n"
                "Reply with exactly one word: ACCEPT or REJECT\n\n"
                + content
            )

            raw = gl.nondet.exec_prompt(prompt)
            s = str(raw).strip().upper()
            # Extract just the verdict word
            if "ACCEPT" in s:
                return "ACCEPT"
            return "REJECT"

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Decide if a document is a valid ERC-8183 extension proposal",
            criteria="Output must be exactly ACCEPT or REJECT.",
        )

        v = str(result_str).strip().upper()
        if "ACCEPT" in v:
            self.verdict = "ACCEPT"
        else:
            self.verdict = "REJECT"

        self.verdict_reason = "AI jury evaluation"

        verdict_uint8 = 1 if self.verdict == "ACCEPT" else 2
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
