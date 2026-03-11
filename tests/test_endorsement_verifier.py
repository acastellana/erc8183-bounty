"""Direct mode tests for EndorsementVerifier v0.6.0"""
import json
import pytest


MOCK_FORUM_WITH_ENDORSEMENT = """
<html><body>
<div class="post" data-user="dcrapis">
Great proposal! I've reviewed the ERC-8183 extension at
https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md
and it looks solid. The graduated verdict system is well-designed.
</div>
</body></html>
"""

MOCK_FORUM_NO_ENDORSEMENT = """
<html><body>
<div class="post" data-user="random_user">
Just browsing the forum, nothing to see here.
</div>
</body></html>
"""

ACCEPT_JSON = '{"verdict":"ACCEPT","reasoning":"Author dcrapis posted a positive reply endorsing the proposal"}'
REJECT_JSON = '{"verdict":"REJECT","reasoning":"No author endorsement found in the thread"}'


def test_endorsement_accept(direct_vm, direct_deploy):
    """Forum shows author endorsement → ACCEPT."""
    direct_vm.mock_web(
        r"ethereum-magicians\.org",
        {"status": 200, "body": MOCK_FORUM_WITH_ENDORSEMENT}
    )
    direct_vm.mock_llm(r".*", ACCEPT_JSON)

    contract = direct_deploy(
        "contracts/EndorsementVerifier.py",
        "1",                                    # job_id
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "0x" + "22" * 20,                       # evaluator_contract
        "0x" + "33" * 20,                       # bridge_sender
        30184,                                  # target_chain_eid
        "0x" + "44" * 20,                       # target_contract
    )

    assert contract.get_verdict() == "ACCEPT"


def test_endorsement_reject(direct_vm, direct_deploy):
    """No author endorsement → REJECT."""
    direct_vm.mock_web(
        r"ethereum-magicians\.org",
        {"status": 200, "body": MOCK_FORUM_NO_ENDORSEMENT}
    )
    direct_vm.mock_llm(r".*", REJECT_JSON)

    contract = direct_deploy(
        "contracts/EndorsementVerifier.py",
        "2",
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "0x" + "22" * 20, "0x" + "33" * 20, 30184, "0x" + "44" * 20,
    )

    assert contract.get_verdict() == "REJECT"


def test_endorsement_validator_agrees(direct_vm, direct_deploy):
    """Validator sees same forum data → agrees."""
    direct_vm.mock_web(
        r"ethereum-magicians\.org",
        {"status": 200, "body": MOCK_FORUM_WITH_ENDORSEMENT}
    )
    direct_vm.mock_llm(r".*", ACCEPT_JSON)

    contract = direct_deploy(
        "contracts/EndorsementVerifier.py",
        "3",
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "0x" + "22" * 20, "0x" + "33" * 20, 30184, "0x" + "44" * 20,
    )

    assert direct_vm.run_validator() is True


def test_endorsement_validator_disagrees(direct_vm, direct_deploy):
    """Validator sees no endorsement while leader saw one → disagrees."""
    direct_vm.mock_web(
        r"ethereum-magicians\.org",
        {"status": 200, "body": MOCK_FORUM_WITH_ENDORSEMENT}
    )
    direct_vm.mock_llm(r".*", ACCEPT_JSON)

    contract = direct_deploy(
        "contracts/EndorsementVerifier.py",
        "4",
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "0x" + "22" * 20, "0x" + "33" * 20, 30184, "0x" + "44" * 20,
    )

    # Swap: validator sees no endorsement
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r"ethereum-magicians\.org",
        {"status": 200, "body": MOCK_FORUM_NO_ENDORSEMENT}
    )
    direct_vm.mock_llm(r".*", REJECT_JSON)

    assert direct_vm.run_validator() is False


def test_endorsement_forum_down(direct_vm, direct_deploy):
    """Forum returns 500 → UserError."""
    direct_vm.mock_web(
        r"ethereum-magicians\.org",
        {"status": 500, "body": "Internal Server Error"}
    )

    with direct_vm.expect_revert("[EXTERNAL] Could not fetch forum thread"):
        direct_deploy(
            "contracts/EndorsementVerifier.py",
            "5",
            "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
            "0x" + "22" * 20, "0x" + "33" * 20, 30184, "0x" + "44" * 20,
        )
