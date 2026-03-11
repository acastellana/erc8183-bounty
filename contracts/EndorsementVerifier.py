# v0.3.0
# { "Depends": "py-genlayer:latest" }
"""EndorsementVerifier — GenLayer oracle for ERC-8183 author endorsement.

Uses prompt_non_comparative with YES/NO output. The leader checks the
Ethereum Magicians thread; co-validators verify if the answer is reasonable.

Verdict codes (match GenLayerEvaluator.sol):
    ACCEPT (1) — at least one ERC-8183 author endorsed the proposal
    REJECT (2) — no endorsement found
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

        def check():
            resp = gl.nondet.web.get(FORUM_THREAD_URL)
            if not resp or resp.status != 200 or not resp.body:
                return "NO|Could not fetch forum thread"

            content = resp.body.decode("utf-8", errors="replace")
            if len(content) > 60000:
                content = content[:60000]

            prompt = f"""Check if any ERC-8183 author ({authors}) posted a POSITIVE reply about the proposal at {url} on this Ethereum Magicians thread.

A positive reply = author expresses support, approval, or constructive interest.
Merely asking questions without support does NOT count.

FORUM CONTENT:
{content[:50000]}

Output format: YES|author_name or NO|reason
Examples:
- YES|dcrapis posted supportive feedback
- NO|No replies from any ERC-8183 author found"""

            result = gl.nondet.exec_prompt(prompt)
            return str(result).strip()

        result_str = gl.eq_principle.prompt_non_comparative(
            check,
            task="Check if an ERC-8183 author endorsed a proposal on Ethereum Magicians",
            criteria=(
                "Output must start with YES or NO. "
                "YES only if a specific ERC-8183 author (dcrapis, ai-virtual-b, "
                "twx-virtuals, or Zuhwa) posted a positive/supportive reply. "
                "NO if no such reply exists."
            ),
        )

        result_upper = str(result_str).strip().upper()
        is_endorsed = result_upper.startswith("YES")

        # Extract reason
        parts = str(result_str).split("|", 1)
        reason = parts[1].strip() if len(parts) > 1 else str(result_str)

        if is_endorsed:
            self.verdict = "ACCEPT"
            self.verdict_reason = f"Endorsed: {reason}"
        else:
            self.verdict = "REJECT"
            self.verdict_reason = f"Not endorsed: {reason}"

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
