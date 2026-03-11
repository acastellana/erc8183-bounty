# v0.6.0
# { "Depends": "py-genlayer:latest" }
"""EndorsementVerifier — Ultra-minimal author endorsement check.

Uses JSON API for clean data. Returns just ACCEPT/REJECT string.
"""

from genlayer import *
import json

genvm_eth = gl.evm

FORUM_JSON = "https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902.json"


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
            resp = gl.nondet.web.get(FORUM_JSON)
            if not resp or resp.status != 200 or not resp.body:
                return "REJECT"

            # Parse JSON API for post authors
            try:
                data = json.loads(resp.body.decode("utf-8"))
                posts = data.get("post_stream", {}).get("posts", [])
                authors = {"dcrapis", "ai-virtual-b", "twx-virtuals", "zuhwa",
                           "davidecrapis.eth", "davidecrapis"}

                for post in posts:
                    username = str(post.get("username", "")).lower()
                    if username in authors and post.get("post_number", 0) > 1:
                        # Found a reply from an author
                        cooked = str(post.get("cooked", ""))[:500]
                        prompt = (
                            "Is this forum reply a positive endorsement? "
                            "Reply exactly YES or NO.\n\n" + cooked
                        )
                        raw = gl.nondet.exec_prompt(prompt)
                        if "YES" in str(raw).upper():
                            return "ACCEPT"

                return "REJECT"
            except:
                return "REJECT"

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Check if an ERC-8183 author endorsed a proposal",
            criteria="Output must be exactly ACCEPT or REJECT.",
        )

        v = str(result_str).strip().upper()
        if "ACCEPT" in v:
            self.verdict = "ACCEPT"
        else:
            self.verdict = "REJECT"

        self.verdict_reason = "Forum endorsement check"

        verdict_uint8 = 1 if self.verdict == "ACCEPT" else 2
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
