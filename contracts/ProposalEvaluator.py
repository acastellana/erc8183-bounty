# v0.7.0
# { "Depends": "py-genlayer:latest" }
"""ProposalEvaluator — GenLayer AI Jury for ERC-8183 Bounty.

Uses custom leader/validator pattern (gl.vm.run_nondet):
- Leader fetches proposal, evaluates with LLM, returns verdict
- Validator independently fetches + evaluates, compares verdict with leader
- Both agree on ACCEPT/REJECT → consensus passes

Recommended pattern per GenLayer team (Rally/MergeProof).
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

        def leader_fn():
            resp = gl.nondet.web.get(url)
            if not resp or resp.status != 200 or not resp.body:
                raise gl.vm.UserError("[EXTERNAL] Could not fetch proposal")

            content = resp.body.decode("utf-8", errors="replace")[:8000]

            prompt = (
                "Does this document propose an extension to ERC-8183 with: "
                "(a) a design analysis, (b) architecture, (c) graduated verdicts, "
                "(d) example flow, (e) compatibility via hooks? "
                'Reply ONLY with JSON: {"verdict":"ACCEPT" or "REJECT","reasoning":"one sentence"}\n\n'
                + content
            )

            raw = gl.nondet.exec_prompt(prompt)
            s = str(raw).strip()
            s = s.replace("```json", "").replace("```", "").strip()
            start = s.find("{")
            end = s.rfind("}") + 1
            if start >= 0 and end > start:
                s = s[start:end]
            parsed = json.loads(s)
            verdict = str(parsed.get("verdict", "REJECT")).strip().upper()
            reasoning = str(parsed.get("reasoning", "")).strip()[:300]
            if verdict not in ("ACCEPT", "REJECT"):
                verdict = "REJECT"
            return {"verdict": verdict, "reasoning": reasoning}

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            validator_result = leader_fn()
            return validator_result["verdict"] == leaders_res.calldata["verdict"]

        result = gl.vm.run_nondet(leader_fn, validator_fn)

        self.verdict = result["verdict"]
        self.verdict_reason = result["reasoning"]

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
