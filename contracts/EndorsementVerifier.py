# v0.2.0
# { "Depends": "py-genlayer:latest" }
"""EndorsementVerifier — GenLayer oracle for ERC-8183 author endorsement.

Uses threshold-based consensus: each validator checks if any ERC-8183 author
posted a positive reply on the Ethereum Magicians thread. Returns "YES" or "NO"
— a simple string that validators can agree on across different LLMs.

Verdict codes (match GenLayerEvaluator.sol):
    ACCEPT (1) — at least one author endorsed
    REJECT (2) — no author endorsement found
"""

from genlayer import *
import json

genvm_eth = gl.evm

VERDICT_ACCEPT = 1
VERDICT_REJECT = 2

EIP_AUTHORS = ["dcrapis", "ai-virtual-b", "twx-virtuals", "Zuhwa"]
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
        authors = ", ".join(EIP_AUTHORS)

        # Simple YES/NO check — consensuable across LLMs
        def check_endorsement():
            resp = gl.nondet.web.get(FORUM_THREAD_URL)
            if not resp or resp.status != 200 or not resp.body:
                return "NO"

            content = resp.body.decode("utf-8", errors="replace")
            if len(content) > 80000:
                content = content[:80000]

            prompt = f"""Check if any of these ERC-8183 authors have posted a POSITIVE reply about the proposal at {url} on the Ethereum Magicians forum:

Authors: {authors}

Forum thread content:
{content[:60000]}

A positive reply means the author expresses support, approval, or constructive interest in the extension proposal. Merely asking questions does not count.

Answer ONLY "YES" or "NO"."""

            result = gl.nondet.exec_prompt(prompt)
            answer = str(result).strip().upper()
            # Normalize to exactly YES or NO
            if "YES" in answer:
                return "YES"
            return "NO"

        # Consensus on YES/NO — validators can easily agree on this
        endorsed = gl.eq_principle.prompt_comparative(
            check_endorsement,
            task="Check if an ERC-8183 author endorsed a proposal on Ethereum Magicians",
            criteria="Output must be exactly YES or NO",
        )

        endorsed_str = str(endorsed).strip().upper()
        is_endorsed = "YES" in endorsed_str

        if is_endorsed:
            self.verdict = "ACCEPT"
            self.verdict_reason = "Author endorsement found on Ethereum Magicians thread"
        else:
            self.verdict = "REJECT"
            self.verdict_reason = "No author endorsement found on Ethereum Magicians thread"

        verdict_uint8 = VERDICT_ACCEPT if is_endorsed else VERDICT_REJECT
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
