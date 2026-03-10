// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC8183.sol";

/**
 * @title GenLayerEvaluator
 * @notice ERC-8183 evaluator that aggregates two off-chain signals before resolving a job.
 *
 * Signal 1 — AI Jury (GenLayer):
 *   ProposalEvaluator on GenLayer evaluates the submission against 5 technical criteria.
 *   Verdict delivered via LayerZero bridge.
 *
 * Signal 2 — Author Endorsement:
 *   The proposal must be posted on the Ethereum Magicians ERC-8183 thread
 *   with a positive reply from Davide Crapis (dcrapis), the ERC-8183 author.
 *   Verified by a second GenLayer oracle that fetches the forum thread.
 *
 * The evaluator only calls complete() when BOTH signals are ACCEPT.
 * If either signal is REJECT, the evaluator calls reject() immediately.
 *
 * Per ERC-8183 spec: "Evaluator MAY be a smart contract that performs
 * arbitrary checks (e.g. aggregating off-chain signals) before deciding
 * whether to call complete or reject on the job."
 *
 * The job sits in Submitted status while signals accumulate — no interface changes needed.
 */
contract GenLayerEvaluator {
    // ─── State ────────────────────────────────────────────────────────────────

    address public owner;
    address public agenticCommerce;
    address public courtRelay;

    uint8 public constant VERDICT_UNDETERMINED = 0;
    uint8 public constant VERDICT_ACCEPT       = 1;
    uint8 public constant VERDICT_REJECT       = 2;

    struct Evaluation {
        uint256 jobId;
        // Signal 1: AI Jury
        uint8   aiVerdict;          // 0=pending, 1=accept, 2=reject
        bytes32 aiReason;
        string  aiDetails;
        bool    aiDelivered;
        // Signal 2: Author Endorsement
        uint8   endorsementVerdict; // 0=pending, 1=accept, 2=reject
        bytes32 endorsementReason;
        string  endorsementDetails;
        bool    endorsementDelivered;
        // Final
        bool    resolved;           // true once complete() or reject() called
    }

    mapping(uint256 => Evaluation) public evaluations;
    mapping(bytes32 => uint256) public deliverableToJob;

    // ─── Events ───────────────────────────────────────────────────────────────

    event EvaluationRequested(uint256 indexed jobId, bytes32 indexed deliverable);
    event AIVerdictDelivered(uint256 indexed jobId, uint8 verdict, bytes32 reason);
    event EndorsementDelivered(uint256 indexed jobId, uint8 verdict, bytes32 reason);
    event JobResolved(uint256 indexed jobId, bool completed, string summary);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyRelay() {
        require(msg.sender == courtRelay || msg.sender == owner, "Not authorized");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _agenticCommerce, address _courtRelay) {
        require(_agenticCommerce != address(0), "Invalid commerce");
        owner = msg.sender;
        agenticCommerce = _agenticCommerce;
        courtRelay = _courtRelay;
    }

    // ─── Register evaluation ──────────────────────────────────────────────────

    function registerEvaluation(uint256 jobId, bytes32 deliverable) external onlyRelay {
        require(!evaluations[jobId].resolved, "Already resolved");

        evaluations[jobId].jobId = jobId;
        deliverableToJob[deliverable] = jobId;

        emit EvaluationRequested(jobId, deliverable);
    }

    // ─── Signal 1: AI Jury verdict ────────────────────────────────────────────

    function deliverAIVerdict(
        uint256 jobId,
        uint8 verdict,
        bytes32 reason,
        string calldata details
    ) external onlyRelay {
        Evaluation storage eval = evaluations[jobId];
        require(!eval.aiDelivered, "AI verdict already delivered");
        require(!eval.resolved, "Already resolved");
        require(verdict == VERDICT_ACCEPT || verdict == VERDICT_REJECT, "Invalid verdict");

        eval.aiVerdict   = verdict;
        eval.aiReason    = reason;
        eval.aiDetails   = details;
        eval.aiDelivered = true;

        emit AIVerdictDelivered(jobId, verdict, reason);

        // If REJECT, resolve immediately (fail fast)
        if (verdict == VERDICT_REJECT) {
            _resolve(jobId, false, string.concat("AI jury rejected: ", details));
            return;
        }

        // If both signals are in, try to resolve
        _tryResolve(jobId);
    }

    // ─── Signal 2: Author endorsement ─────────────────────────────────────────

    function deliverEndorsement(
        uint256 jobId,
        uint8 verdict,
        bytes32 reason,
        string calldata details
    ) external onlyRelay {
        Evaluation storage eval = evaluations[jobId];
        require(!eval.endorsementDelivered, "Endorsement already delivered");
        require(!eval.resolved, "Already resolved");
        require(verdict == VERDICT_ACCEPT || verdict == VERDICT_REJECT, "Invalid verdict");

        eval.endorsementVerdict   = verdict;
        eval.endorsementReason    = reason;
        eval.endorsementDetails   = details;
        eval.endorsementDelivered = true;

        emit EndorsementDelivered(jobId, verdict, reason);

        // If REJECT, resolve immediately
        if (verdict == VERDICT_REJECT) {
            _resolve(jobId, false, string.concat("Endorsement missing: ", details));
            return;
        }

        _tryResolve(jobId);
    }

    // ─── Backwards-compatible single-signal entry point ───────────────────────
    // For testing or when endorsement is waived.

    function deliverVerdict(
        uint256 jobId,
        uint8 verdict,
        bytes32 reason,
        string calldata details
    ) external onlyRelay {
        Evaluation storage eval = evaluations[jobId];
        require(!eval.resolved, "Already resolved");

        // Deliver as AI verdict
        if (!eval.aiDelivered) {
            eval.aiVerdict   = verdict;
            eval.aiReason    = reason;
            eval.aiDetails   = details;
            eval.aiDelivered = true;
            emit AIVerdictDelivered(jobId, verdict, reason);
        }

        // Also mark endorsement as delivered (bypass for single-signal mode)
        if (!eval.endorsementDelivered) {
            eval.endorsementVerdict   = verdict;
            eval.endorsementReason    = reason;
            eval.endorsementDetails   = "Single-signal mode";
            eval.endorsementDelivered = true;
            emit EndorsementDelivered(jobId, verdict, reason);
        }

        if (verdict == VERDICT_REJECT) {
            _resolve(jobId, false, details);
        } else {
            _tryResolve(jobId);
        }
    }

    // ─── Resolution logic ─────────────────────────────────────────────────────

    function _tryResolve(uint256 jobId) internal {
        Evaluation storage eval = evaluations[jobId];
        if (eval.resolved) return;
        if (!eval.aiDelivered || !eval.endorsementDelivered) return;

        // Both signals delivered — both must be ACCEPT
        bool aiPass = eval.aiVerdict == VERDICT_ACCEPT;
        bool endorsePass = eval.endorsementVerdict == VERDICT_ACCEPT;

        if (aiPass && endorsePass) {
            _resolve(jobId, true, string.concat(eval.aiDetails, " | Endorsement: ", eval.endorsementDetails));
        } else if (!aiPass) {
            _resolve(jobId, false, string.concat("AI rejected: ", eval.aiDetails));
        } else {
            _resolve(jobId, false, string.concat("Endorsement rejected: ", eval.endorsementDetails));
        }
    }

    function _resolve(uint256 jobId, bool completed, string memory summary) internal {
        Evaluation storage eval = evaluations[jobId];
        require(!eval.resolved, "Already resolved");
        eval.resolved = true;

        bytes32 reason = eval.aiReason; // use AI reason as primary attestation hash

        emit JobResolved(jobId, completed, summary);

        if (completed) {
            IERC8183(agenticCommerce).complete(jobId, reason, bytes(summary));
        } else {
            IERC8183(agenticCommerce).reject(jobId, reason, bytes(summary));
        }
    }

    // ─── IC bridge entry point ────────────────────────────────────────────────

    function resolveFromCourt(bytes calldata payload) external onlyRelay {
        (uint256 jobId, uint8 signalType, uint8 verdict, bytes32 reason, string memory details) =
            abi.decode(payload, (uint256, uint8, uint8, bytes32, string));

        if (signalType == 1) {
            // AI jury signal
            Evaluation storage eval = evaluations[jobId];
            if (!eval.aiDelivered) {
                eval.aiVerdict = verdict;
                eval.aiReason = reason;
                eval.aiDetails = details;
                eval.aiDelivered = true;
                emit AIVerdictDelivered(jobId, verdict, reason);
            }
        } else if (signalType == 2) {
            // Endorsement signal
            Evaluation storage eval2 = evaluations[jobId];
            if (!eval2.endorsementDelivered) {
                eval2.endorsementVerdict = verdict;
                eval2.endorsementReason = reason;
                eval2.endorsementDetails = details;
                eval2.endorsementDelivered = true;
                emit EndorsementDelivered(jobId, verdict, reason);
            }
        }

        Evaluation storage e = evaluations[jobId];
        if (!e.resolved) {
            if (verdict == VERDICT_REJECT) {
                _resolve(jobId, false, details);
            } else {
                _tryResolve(jobId);
            }
        }
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setCourtRelay(address _relay) external onlyOwner { courtRelay = _relay; }
    function setAgenticCommerce(address _c) external onlyOwner { agenticCommerce = _c; }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getEvaluation(uint256 jobId) external view returns (
        uint8 aiVerdict, bool aiDelivered,
        uint8 endorsementVerdict, bool endorsementDelivered,
        bool resolved
    ) {
        Evaluation storage e = evaluations[jobId];
        return (e.aiVerdict, e.aiDelivered, e.endorsementVerdict, e.endorsementDelivered, e.resolved);
    }

    function getDetails(uint256 jobId) external view returns (
        string memory aiDetails, string memory endorsementDetails
    ) {
        Evaluation storage e = evaluations[jobId];
        return (e.aiDetails, e.endorsementDetails);
    }

    function isFullyResolved(uint256 jobId) external view returns (bool) {
        return evaluations[jobId].resolved;
    }

    function pendingSignals(uint256 jobId) external view returns (bool needsAI, bool needsEndorsement) {
        Evaluation storage e = evaluations[jobId];
        return (!e.aiDelivered, !e.endorsementDelivered);
    }
}
