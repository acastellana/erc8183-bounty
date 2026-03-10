# v0.1.0
# { "Depends": "py-genlayer:latest" }
"""EndorsementVerifier — GenLayer oracle that verifies ERC-8183 author endorsement.

Fetches the Ethereum Magicians ERC-8183 discussion thread and checks whether
any of the original EIP authors have posted a positive reply to the proposal.

Accepted authors (from ERC-8183 spec):
  - Davide Crapis (@dcrapis)
  - Bryan Lim (@ai-virtual-b)
  - Tay Weixiong (@twx-virtuals)
  - Chooi Zuhwa (@Zuhwa)

The verifier:
  1. Fetches the Ethereum Magicians thread for ERC-8183
  2. Searches for replies from any of the four authors
  3. Evaluates whether the reply is a positive endorsement of the proposal
  4. Returns ACCEPT if a positive endorsement exists, REJECT otherwise

Verdict codes (match GenLayerEvaluator.sol):
    ACCEPT (1) — at least one author posted a positive reply
    REJECT (2) — no author endorsement found

Sends Signal 2 (endorsement) to GenLayerEvaluator via bridge.
"""

from genlayer import *
import json

genvm_eth = gl.evm

VERDICT_ACCEPT = 1
VERDICT_REJECT = 2

# ERC-8183 authors — any one of these counts as valid endorsement
EIP_AUTHORS = {
    "dcrapis":       "Davide Crapis",
    "ai-virtual-b":  "Bryan Lim",
    "twx-virtuals":  "Tay Weixiong",
    "Zuhwa":         "Chooi Zuhwa",
    # Also accept display name variations
    "davide_crapis": "Davide Crapis",
    "davidecrapis":  "Davide Crapis",
}

# Ethereum Magicians thread URL
FORUM_THREAD_URL = "https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902"


class EndorsementVerifier(gl.Contract):
    """Verifies author endorsement on Ethereum Magicians forum."""

    job_id:              str
    proposal_url:        str
    evaluator_contract:  str   # GenLayerEvaluator on Base Sepolia
    bridge_sender:       str
    target_chain_eid:    u256
    verdict:             str
    verdict_reason:      str
    endorsing_author:    str   # which author endorsed (empty if none)

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
        jid = job_id

        # Build author list for prompt
        authors_str = ", ".join(f"@{k} ({v})" for k, v in {
            "dcrapis": "Davide Crapis",
            "ai-virtual-b": "Bryan Lim",
            "twx-virtuals": "Tay Weixiong",
            "Zuhwa": "Chooi Zuhwa",
        }.items())

        def nondet():
            # Fetch the Ethereum Magicians thread
            resp = gl.nondet.web.get(FORUM_THREAD_URL)
            forum_ok = resp and resp.status == 200 and resp.body

            if not forum_ok:
                return json.dumps({
                    "verdict": "REJECT",
                    "reason": f"Could not fetch Ethereum Magicians thread ({resp.status if resp else 'no response'})",
                    "endorsing_author": "",
                    "endorsement_quote": ""
                })

            forum_content = resp.body.decode("utf-8", errors="replace")

            # Truncate if very large
            if len(forum_content) > 80000:
                forum_content = forum_content[:80000] + "\n[TRUNCATED]"

            prompt = f"""You are verifying whether any original ERC-8183 author has endorsed a specific proposal on the Ethereum Magicians forum.

PROPOSAL URL: {url}
JOB ID: {jid}

FORUM THREAD CONTENT (Ethereum Magicians):
{forum_content}

ERC-8183 AUTHORS (any one of these counts):
{authors_str}

TASK:
1. Search the forum thread for replies/posts from any of the listed ERC-8183 authors
2. Check if any author's reply references or endorses the proposal at {url}
3. A "positive endorsement" means the author:
   - Acknowledges the proposal exists
   - Expresses support, approval, or interest in the extension
   - Does NOT need to be unconditional approval — constructive positive feedback counts
4. A reply that merely asks questions without expressing support does NOT count
5. No reply from any author = REJECT

Output ONLY valid JSON:
{{
  "verdict": "ACCEPT" | "REJECT",
  "reason": "One to two sentences explaining the finding.",
  "endorsing_author": "username of the endorsing author (empty string if none)",
  "endorsement_quote": "Direct quote from the endorsing reply (empty if none, max 200 chars)"
}}"""

            result = gl.nondet.exec_prompt(prompt)
            return result.strip() if isinstance(result, str) else str(result).strip()

        result_str = gl.eq_principle.prompt_non_comparative(
            nondet,
            task="Verify whether an ERC-8183 author has positively endorsed a proposal on Ethereum Magicians",
            criteria=(
                "Verdict must be ACCEPT or REJECT. "
                "ACCEPT only if a specific author (from the listed four) posted a positive reply. "
                "endorsing_author must be a real username from the author list or empty. "
                "endorsement_quote must be a real quote from the thread or empty."
            ),
        )

        try:
            clean = result_str.replace("```json", "").replace("```", "").strip() if isinstance(result_str, str) else str(result_str)
            parsed = json.loads(clean)

            v = parsed.get("verdict", "REJECT").strip().upper()
            r = parsed.get("reason", "").strip()
            author = parsed.get("endorsing_author", "").strip()
            quote = parsed.get("endorsement_quote", "").strip()

            # Validate author is actually in our list
            if v == "ACCEPT" and author:
                author_lower = author.lower().replace("@", "")
                valid = any(author_lower == k.lower() for k in EIP_AUTHORS)
                if not valid:
                    v = "REJECT"
                    r = f"Author '{author}' is not in the ERC-8183 author list. {r}"
                    author = ""

        except Exception as e:
            v = "REJECT"
            r = f"Parse error: {str(e)}"
            author = ""
            quote = ""

        if v not in ("ACCEPT", "REJECT"):
            v = "REJECT"

        self.verdict = v
        self.verdict_reason = f"{r} | Quote: {quote}" if quote else r
        self.endorsing_author = author

        verdict_uint8 = VERDICT_ACCEPT if v == "ACCEPT" else VERDICT_REJECT
        reason_hash = genvm_eth.keccak256(self.verdict_reason.encode("utf-8"))

        # ABI-encode: (uint256 jobId, uint8 signalType, uint8 verdict, bytes32 reason, string details)
        # signalType = 2 for endorsement
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
        return json.dumps({
            "job_id":           self.job_id,
            "verdict":          self.verdict,
            "verdict_reason":   self.verdict_reason,
            "endorsing_author": self.endorsing_author,
            "proposal_url":     self.proposal_url,
            "forum_thread":     FORUM_THREAD_URL,
        })

    @gl.public.view
    def get_status(self) -> str:
        return self.verdict
