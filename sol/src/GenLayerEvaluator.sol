// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC8183.sol";

/**
 * @title GenLayerEvaluator
 * @notice ERC-8183 evaluator that bridges to GenLayer for AI jury evaluation.
 *
 * Flow:
 *   1. Provider submits deliverable on AgenticCommerce (Funded → Submitted)
 *   2. Relay picks up JobSubmitted event, deploys ProposalEvaluator on GenLayer
 *   3. GenLayer AI jury evaluates the deliverable
 *   4. Verdict bridged back via LayerZero → InternetCourt → this contract
 *   5. This contract calls complete() or reject() on AgenticCommerce
 *
 * This contract IS the evaluator address set on ERC-8183 jobs.
 * The InternetCourt relay (or authorized operator) delivers verdicts here,
 * and this contract forwards them to the AgenticCommerce contract.
 */
contract GenLayerEvaluator {
    // ─── State ────────────────────────────────────────────────────────────────

    address public owner;
    address public agenticCommerce;      // The ERC-8183 contract
    address public courtRelay;           // InternetCourt relay / factory authorized to deliver verdicts

    // Verdict codes from GenLayer
    uint8 public constant VERDICT_ACCEPT = 1;
    uint8 public constant VERDICT_REJECT = 2;

    // Track evaluations
    struct Evaluation {
        uint256 jobId;
        uint8   verdict;       // 0=pending, 1=accept, 2=reject
        bytes32 reason;        // attestation hash
        string  details;       // human-readable verdict reason from GenLayer
        bool    delivered;
    }

    mapping(uint256 => Evaluation) public evaluations; // jobId → evaluation
    mapping(bytes32 => uint256) public deliverableToJob; // deliverable hash → jobId (for relay lookup)

    // ─── Events ───────────────────────────────────────────────────────────────

    event EvaluationRequested(uint256 indexed jobId, bytes32 indexed deliverable);
    event VerdictDelivered(uint256 indexed jobId, uint8 verdict, bytes32 reason);
    event VerdictExecuted(uint256 indexed jobId, bool completed);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyRelay() {
        require(msg.sender == courtRelay || msg.sender == owner, "Not authorized relay");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _agenticCommerce, address _courtRelay) {
        require(_agenticCommerce != address(0), "Invalid commerce");
        owner = msg.sender;
        agenticCommerce = _agenticCommerce;
        courtRelay = _courtRelay;
    }

    // ─── Register job for evaluation ──────────────────────────────────────────

    /// @notice Called by the relay when a JobSubmitted event is detected.
    ///         Registers the job for evaluation and emits an event for the GenLayer relay.
    function registerEvaluation(uint256 jobId, bytes32 deliverable) external onlyRelay {
        require(evaluations[jobId].jobId == 0 || !evaluations[jobId].delivered, "Already evaluated");

        evaluations[jobId] = Evaluation({
            jobId:     jobId,
            verdict:   0,
            reason:    bytes32(0),
            details:   "",
            delivered: false
        });
        deliverableToJob[deliverable] = jobId;

        emit EvaluationRequested(jobId, deliverable);
    }

    // ─── Deliver verdict from GenLayer ────────────────────────────────────────

    /// @notice Called by the InternetCourt relay to deliver the GenLayer verdict.
    ///         Automatically calls complete() or reject() on the AgenticCommerce contract.
    function deliverVerdict(
        uint256 jobId,
        uint8 verdict,
        bytes32 reason,
        string calldata details
    ) external onlyRelay {
        Evaluation storage eval = evaluations[jobId];
        require(!eval.delivered, "Already delivered");
        require(verdict == VERDICT_ACCEPT || verdict == VERDICT_REJECT, "Invalid verdict");

        eval.verdict   = verdict;
        eval.reason    = reason;
        eval.details   = details;
        eval.delivered = true;

        emit VerdictDelivered(jobId, verdict, reason);

        // Execute on AgenticCommerce
        bool completed;
        if (verdict == VERDICT_ACCEPT) {
            IERC8183(agenticCommerce).complete(jobId, reason, bytes(details));
            completed = true;
        } else {
            IERC8183(agenticCommerce).reject(jobId, reason, bytes(details));
            completed = false;
        }

        emit VerdictExecuted(jobId, completed);
    }

    /// @notice Alternative entry point for InternetCourt bridge format.
    ///         Decodes (uint256 jobId, uint8 verdict, bytes32 reason, string details).
    function resolveFromCourt(bytes calldata payload) external onlyRelay {
        (uint256 jobId, uint8 verdict, bytes32 reason, string memory details) =
            abi.decode(payload, (uint256, uint8, bytes32, string));

        // Reuse deliverVerdict logic
        Evaluation storage eval = evaluations[jobId];
        require(!eval.delivered, "Already delivered");
        require(verdict == VERDICT_ACCEPT || verdict == VERDICT_REJECT, "Invalid verdict");

        eval.verdict   = verdict;
        eval.reason    = reason;
        eval.details   = details;
        eval.delivered = true;

        emit VerdictDelivered(jobId, verdict, reason);

        bool completed;
        if (verdict == VERDICT_ACCEPT) {
            IERC8183(agenticCommerce).complete(jobId, reason, bytes(details));
            completed = true;
        } else {
            IERC8183(agenticCommerce).reject(jobId, reason, bytes(details));
            completed = false;
        }

        emit VerdictExecuted(jobId, completed);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setCourtRelay(address _relay) external onlyOwner {
        courtRelay = _relay;
    }

    function setAgenticCommerce(address _commerce) external onlyOwner {
        agenticCommerce = _commerce;
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getEvaluation(uint256 jobId) external view returns (
        uint8 verdict, bytes32 reason, string memory details, bool delivered
    ) {
        Evaluation storage e = evaluations[jobId];
        return (e.verdict, e.reason, e.details, e.delivered);
    }
}
