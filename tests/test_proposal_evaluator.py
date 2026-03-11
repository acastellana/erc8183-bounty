"""Direct mode tests for ProposalEvaluator v0.7.0"""
import json
import pytest


MOCK_PROPOSAL = """
# ERC-8183 Extension Proposal
## Design Analysis
This proposal extends ERC-8183 with graduated verdict support.
## Architecture
The system uses a modular hook-based architecture.
## Graduated Verdicts
Verdicts range from ACCEPT to REJECT with intermediate states.
## Example Flow
1. Agent submits proposal
2. AI jury evaluates
3. Verdict returned on-chain
## Compatibility
Hooks implement IAgenticCommerceHook interface.
"""

MOCK_BAD_PROPOSAL = "Hello world, this is not a proposal."

ACCEPT_JSON = '{"verdict":"ACCEPT","reasoning":"Contains all required sections"}'
REJECT_JSON = '{"verdict":"REJECT","reasoning":"Missing required sections"}'


def test_proposal_accept(direct_vm, direct_deploy):
    """Leader and validator both see a valid proposal → ACCEPT consensus."""
    direct_vm.mock_web(
        r"raw\.githubusercontent\.com",
        {"status": 200, "body": MOCK_PROPOSAL}
    )
    direct_vm.mock_llm(r".*", ACCEPT_JSON)

    contract = direct_deploy(
        "contracts/ProposalEvaluator.py",
        "1",                                    # job_id
        "0x" + "11" * 20,                       # bounty_contract
        "0x" + "22" * 20,                       # evaluator_contract
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "v1",                                   # guideline_version
        "0x" + "33" * 20,                       # bridge_sender
        30184,                                  # target_chain_eid
        "0x" + "44" * 20,                       # target_contract
    )

    assert contract.get_verdict() == "ACCEPT"
    assert "required sections" in contract.get_reason().lower() or len(contract.get_reason()) > 0


def test_proposal_reject(direct_vm, direct_deploy):
    """Leader and validator both see a bad proposal → REJECT consensus."""
    direct_vm.mock_web(
        r"raw\.githubusercontent\.com",
        {"status": 200, "body": MOCK_BAD_PROPOSAL}
    )
    direct_vm.mock_llm(r".*", REJECT_JSON)

    contract = direct_deploy(
        "contracts/ProposalEvaluator.py",
        "2", "0x" + "11" * 20, "0x" + "22" * 20,
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "v1", "0x" + "33" * 20, 30184, "0x" + "44" * 20,
    )

    assert contract.get_verdict() == "REJECT"


def test_proposal_validator_agrees(direct_vm, direct_deploy):
    """Validator independently evaluates and agrees with leader."""
    direct_vm.mock_web(
        r"raw\.githubusercontent\.com",
        {"status": 200, "body": MOCK_PROPOSAL}
    )
    direct_vm.mock_llm(r".*", ACCEPT_JSON)

    contract = direct_deploy(
        "contracts/ProposalEvaluator.py",
        "3", "0x" + "11" * 20, "0x" + "22" * 20,
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "v1", "0x" + "33" * 20, 30184, "0x" + "44" * 20,
    )

    # Same mocks = validator gets same result → agrees
    assert direct_vm.run_validator() is True


def test_proposal_validator_disagrees(direct_vm, direct_deploy):
    """Validator evaluates differently → disagrees with leader."""
    direct_vm.mock_web(
        r"raw\.githubusercontent\.com",
        {"status": 200, "body": MOCK_PROPOSAL}
    )
    direct_vm.mock_llm(r".*", ACCEPT_JSON)

    contract = direct_deploy(
        "contracts/ProposalEvaluator.py",
        "4", "0x" + "11" * 20, "0x" + "22" * 20,
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "v1", "0x" + "33" * 20, 30184, "0x" + "44" * 20,
    )

    # Swap mocks: validator sees REJECT instead of ACCEPT
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r"raw\.githubusercontent\.com",
        {"status": 200, "body": MOCK_PROPOSAL}
    )
    direct_vm.mock_llm(r".*", REJECT_JSON)

    assert direct_vm.run_validator() is False


def test_proposal_fetch_failure(direct_vm, direct_deploy):
    """Web fetch fails → UserError raised."""
    direct_vm.mock_web(
        r"raw\.githubusercontent\.com",
        {"status": 404, "body": "Not Found"}
    )

    with direct_vm.expect_revert("[EXTERNAL] Could not fetch proposal"):
        direct_deploy(
            "contracts/ProposalEvaluator.py",
            "5", "0x" + "11" * 20, "0x" + "22" * 20,
            "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
            "v1", "0x" + "33" * 20, 30184, "0x" + "44" * 20,
        )


def test_proposal_leader_error_validator_disagrees(direct_vm, direct_deploy):
    """If leader errored, validator should always disagree."""
    direct_vm.mock_web(
        r"raw\.githubusercontent\.com",
        {"status": 200, "body": MOCK_PROPOSAL}
    )
    direct_vm.mock_llm(r".*", ACCEPT_JSON)

    contract = direct_deploy(
        "contracts/ProposalEvaluator.py",
        "6", "0x" + "11" * 20, "0x" + "22" * 20,
        "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md",
        "v1", "0x" + "33" * 20, 30184, "0x" + "44" * 20,
    )

    # Simulate leader error → validator should return False
    assert direct_vm.run_validator(leader_error=ValueError("timeout")) is False
