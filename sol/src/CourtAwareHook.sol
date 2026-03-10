// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC8183.sol";

/**
 * @title CourtAwareHook
 * @notice Reference IACPHook demonstrating court-aware extensions for ERC-8183.
 *
 * This hook shows the PATTERN for extending ERC-8183 with GenLayer AI adjudication.
 * It adds:
 *   - Submission metadata tracking (proposal URLs mapped to deliverable hashes)
 *   - Pre-submit validation (provider must register metadata before submitting)
 *   - Post-complete/reject event enrichment (emits court verdict details)
 *
 * This is a minimal "starter" hook. The bounty asks for proposals that build on
 * this pattern to add:
 *   - Partial payouts (not just all-or-nothing complete/reject)
 *   - Graduated penalties
 *   - Resubmission windows
 *   - Multi-round evaluation
 *   - Dispute escalation
 *
 * Architecture:
 *   AgenticCommerce → beforeAction/afterAction → CourtAwareHook
 *   CourtAwareHook stores metadata; GenLayerEvaluator handles verdict delivery
 */
contract CourtAwareHook is IACPHook {
    // ─── State ────────────────────────────────────────────────────────────────

    address public immutable agenticCommerce;  // only accept calls from this contract
    address public owner;

    struct SubmissionMeta {
        string  proposalUrl;         // URL to the full proposal
        string  proposalTitle;       // Short title
        uint256 registeredAt;        // When metadata was registered
        bool    registered;          // Must be true before submit()
    }

    // jobId → submission metadata
    mapping(uint256 => SubmissionMeta) public submissions;

    // Track court outcomes for reporting
    struct CourtOutcome {
        uint256 jobId;
        bool    completed;      // true = complete, false = reject
        bytes32 reason;
        uint256 resolvedAt;
    }
    mapping(uint256 => CourtOutcome) public outcomes;
    uint256 public totalCompleted;
    uint256 public totalRejected;

    // ─── Events ───────────────────────────────────────────────────────────────

    event ProposalRegistered(uint256 indexed jobId, string proposalUrl, string proposalTitle);
    event CourtVerdictApplied(uint256 indexed jobId, bool completed, bytes32 reason);

    // ─── Selectors ────────────────────────────────────────────────────────────

    bytes4 constant SEL_SET_PROVIDER = bytes4(keccak256("setProvider(uint256,address,bytes)"));
    bytes4 constant SEL_SET_BUDGET   = bytes4(keccak256("setBudget(uint256,uint256,bytes)"));
    bytes4 constant SEL_FUND         = bytes4(keccak256("fund(uint256,uint256,bytes)"));
    bytes4 constant SEL_SUBMIT       = bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 constant SEL_COMPLETE     = bytes4(keccak256("complete(uint256,bytes32,bytes)"));
    bytes4 constant SEL_REJECT       = bytes4(keccak256("reject(uint256,bytes32,bytes)"));

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _agenticCommerce) {
        agenticCommerce = _agenticCommerce;
        owner = msg.sender;
    }

    modifier onlyACP() {
        require(msg.sender == agenticCommerce, "Only ACP contract");
        _;
    }

    // ─── Register proposal metadata (called by provider before submit) ────────

    /// @notice Provider registers their proposal metadata before calling submit().
    ///         The deliverable hash in submit() should be keccak256(proposalUrl).
    function registerProposal(
        uint256 jobId,
        string calldata proposalUrl,
        string calldata proposalTitle
    ) external {
        require(bytes(proposalUrl).length > 0, "Empty URL");
        require(!submissions[jobId].registered, "Already registered");

        submissions[jobId] = SubmissionMeta({
            proposalUrl:   proposalUrl,
            proposalTitle: proposalTitle,
            registeredAt:  block.timestamp,
            registered:    true
        });

        emit ProposalRegistered(jobId, proposalUrl, proposalTitle);
    }

    // ─── IACPHook implementation ──────────────────────────────────────────────

    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata /* data */
    ) external override onlyACP {
        if (selector == SEL_SUBMIT) {
            // Require proposal metadata to be registered before submission
            require(submissions[jobId].registered, "Register proposal first");
        }
        // Other selectors: no-op (extensible by overriding)
    }

    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external override onlyACP {
        if (selector == SEL_COMPLETE) {
            // Track court completion
            (bytes32 reason, ) = abi.decode(data, (bytes32, bytes));
            outcomes[jobId] = CourtOutcome({
                jobId:      jobId,
                completed:  true,
                reason:     reason,
                resolvedAt: block.timestamp
            });
            totalCompleted++;
            emit CourtVerdictApplied(jobId, true, reason);
        } else if (selector == SEL_REJECT) {
            // Track court rejection
            (bytes32 reason, ) = abi.decode(data, (bytes32, bytes));
            outcomes[jobId] = CourtOutcome({
                jobId:      jobId,
                completed:  false,
                reason:     reason,
                resolvedAt: block.timestamp
            });
            totalRejected++;
            emit CourtVerdictApplied(jobId, false, reason);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getProposal(uint256 jobId) external view returns (
        string memory proposalUrl,
        string memory proposalTitle,
        uint256 registeredAt,
        bool registered
    ) {
        SubmissionMeta storage s = submissions[jobId];
        return (s.proposalUrl, s.proposalTitle, s.registeredAt, s.registered);
    }

    function getOutcome(uint256 jobId) external view returns (
        bool completed,
        bytes32 reason,
        uint256 resolvedAt
    ) {
        CourtOutcome storage o = outcomes[jobId];
        return (o.completed, o.reason, o.resolvedAt);
    }

    function stats() external view returns (uint256 completed, uint256 rejected) {
        return (totalCompleted, totalRejected);
    }
}
