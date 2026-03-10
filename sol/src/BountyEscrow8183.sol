// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IERC8183.sol";

/**
 * @title BountyEscrow8183
 * @notice A bounty contract built on ERC-8183.
 *
 * The bounty sponsor deposits funds. Anyone can submit a proposal URL.
 * An external evaluator (GenLayer AI jury via InternetCourt relay) evaluates
 * each submission. If the verdict is ACCEPT, the submitter receives the prize.
 * If REJECT, the bounty stays open for new submissions.
 *
 * This contract is itself a demonstration of ERC-8183: a real escrow
 * whose outcome is determined by an AI-powered evaluator.
 *
 * Integration with InternetCourt:
 *   - On submission, the contract emits EvaluationRequested.
 *   - The relay deploys a ProposalEvaluator contract on GenLayer.
 *   - The AI jury evaluates the proposal against the bounty criteria.
 *   - The verdict is bridged back and delivered via resolveFromCourt().
 */
contract BountyEscrow8183 is IERC8183 {
    using SafeERC20 for IERC20;

    // ─── Types ───────────────────────────────────────────────────────────────

    enum BountyStatus { Open, Evaluating, Resolved, Expired, Cancelled }

    uint8 public constant VERDICT_UNDETERMINED = 0;
    uint8 public constant VERDICT_ACCEPT       = 1;
    uint8 public constant VERDICT_REJECT       = 2;

    struct Submission {
        address submitter;
        string  proposalUrl;     // URL to the proposal (GitHub repo, doc, etc.)
        uint256 submittedAt;
        uint8   verdict;         // 0 = pending, 1 = accept, 2 = reject
        string  verdictReason;
        bool    resolved;
    }

    // ─── State ───────────────────────────────────────────────────────────────

    address public override depositor;
    address public override evaluator;       // InternetCourtFactory or relay
    address public override escrowToken;     // ERC-20 token (address(0) = ETH)
    uint256 public override escrowBalance;
    BountyStatus public currentStatus;

    string  public title;
    string  public description;
    string  public criteriaUrl;              // IPFS CID or URL to full criteria doc
    uint256 public deadline;                 // Unix timestamp
    uint256 public prizeAmount;

    // Submission tracking
    mapping(bytes32 => Submission) public submissions;
    bytes32[] public submissionIds;
    bytes32 public winningSubmission;
    address public winner;

    // ─── Events ──────────────────────────────────────────────────────────────

    event BountyCreated(string title, uint256 prize, uint256 deadline);
    event SubmissionReceived(bytes32 indexed submissionId, address indexed submitter, string proposalUrl);
    event BountyAwarded(bytes32 indexed submissionId, address indexed winner, uint256 amount);
    event BountyExpired();
    event BountyCancelled(uint256 refundAmount);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyDepositor() {
        require(msg.sender == depositor, "Only depositor");
        _;
    }

    modifier onlyEvaluator() {
        require(msg.sender == evaluator, "Only evaluator");
        _;
    }

    modifier bountyOpen() {
        require(currentStatus == BountyStatus.Open, "Bounty not open");
        require(block.timestamp < deadline, "Bounty expired");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _evaluator,
        address _token,
        string memory _title,
        string memory _description,
        string memory _criteriaUrl,
        uint256 _deadline
    ) {
        require(_evaluator != address(0), "Invalid evaluator");
        require(_deadline > block.timestamp, "Deadline must be future");

        depositor   = msg.sender;
        evaluator   = _evaluator;
        escrowToken = _token;
        title       = _title;
        description = _description;
        criteriaUrl = _criteriaUrl;
        deadline    = _deadline;
        currentStatus = BountyStatus.Open;

        emit BountyCreated(_title, 0, _deadline);
    }

    // ─── IERC8183: deposit ───────────────────────────────────────────────────

    function deposit(address _token, uint256 _amount) external payable override {
        require(msg.sender == depositor, "Only depositor can fund");
        require(currentStatus == BountyStatus.Open || currentStatus == BountyStatus.Evaluating, "Cannot deposit now");

        if (_token == address(0)) {
            // ETH deposit
            require(msg.value > 0, "No ETH sent");
            escrowBalance += msg.value;
            prizeAmount   += msg.value;
            emit Deposited(msg.sender, address(0), msg.value);
        } else {
            require(_token == escrowToken, "Wrong token");
            require(_amount > 0, "Zero amount");
            IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
            escrowBalance += _amount;
            prizeAmount   += _amount;
            emit Deposited(msg.sender, _token, _amount);
        }
    }

    // ─── IERC8183: submit ────────────────────────────────────────────────────

    function submit(bytes calldata data) external override bountyOpen returns (bytes32 submissionId) {
        // Decode submission: just a proposal URL string
        string memory proposalUrl = abi.decode(data, (string));
        require(bytes(proposalUrl).length > 0, "Empty URL");

        submissionId = keccak256(abi.encodePacked(msg.sender, proposalUrl, block.timestamp));
        require(submissions[submissionId].submittedAt == 0, "Duplicate submission");

        submissions[submissionId] = Submission({
            submitter:    msg.sender,
            proposalUrl:  proposalUrl,
            submittedAt:  block.timestamp,
            verdict:      VERDICT_UNDETERMINED,
            verdictReason: "",
            resolved:     false
        });
        submissionIds.push(submissionId);

        emit SubmissionReceived(submissionId, msg.sender, proposalUrl);
        emit EvaluationRequested(submissionId, msg.sender, data);

        return submissionId;
    }

    // ─── IERC8183: resolve ───────────────────────────────────────────────────

    function resolve(
        bytes32 submissionId,
        uint8 verdict,
        bytes calldata resolutionData
    ) external override onlyEvaluator {
        Submission storage sub = submissions[submissionId];
        require(sub.submittedAt > 0, "Unknown submission");
        require(!sub.resolved, "Already resolved");
        require(currentStatus != BountyStatus.Resolved, "Bounty already awarded");

        string memory reason = "";
        if (resolutionData.length > 0) {
            reason = abi.decode(resolutionData, (string));
        }

        sub.verdict       = verdict;
        sub.verdictReason = reason;
        sub.resolved      = true;

        if (verdict == VERDICT_ACCEPT) {
            // Winner! Transfer prize
            winner            = sub.submitter;
            winningSubmission = submissionId;
            currentStatus     = BountyStatus.Resolved;

            _transferPrize(sub.submitter);

            emit BountyAwarded(submissionId, sub.submitter, prizeAmount);
        }
        // REJECT or UNDETERMINED: bounty stays open

        emit Resolved(submissionId, verdict, resolutionData);
    }

    // ─── InternetCourt-compatible resolve ────────────────────────────────────
    // Called by InternetCourtFactory.deliverResolution() via bridge relay.
    // Payload: (bytes32 submissionId, uint8 verdict, string reason)

    function resolveFromCourt(bytes32 _submissionId, uint8 _verdict, string calldata _reason) external onlyEvaluator {
        Submission storage sub = submissions[_submissionId];
        require(sub.submittedAt > 0, "Unknown submission");
        require(!sub.resolved, "Already resolved");
        require(currentStatus != BountyStatus.Resolved, "Bounty already awarded");

        sub.verdict       = _verdict;
        sub.verdictReason = _reason;
        sub.resolved      = true;

        if (_verdict == VERDICT_ACCEPT) {
            winner            = sub.submitter;
            winningSubmission = _submissionId;
            currentStatus     = BountyStatus.Resolved;

            _transferPrize(sub.submitter);

            emit BountyAwarded(_submissionId, sub.submitter, prizeAmount);
        }

        emit Resolved(_submissionId, _verdict, abi.encode(_reason));
    }

    // ─── Admin functions ─────────────────────────────────────────────────────

    /// @notice Mark bounty as expired after deadline passes. Refund depositor.
    function expire() external {
        require(block.timestamp >= deadline, "Not expired yet");
        require(currentStatus == BountyStatus.Open || currentStatus == BountyStatus.Evaluating, "Cannot expire");

        currentStatus = BountyStatus.Expired;
        _refundDepositor();

        emit BountyExpired();
    }

    /// @notice Depositor cancels bounty before any winning submission.
    function cancel() external onlyDepositor {
        require(currentStatus == BountyStatus.Open, "Cannot cancel");

        currentStatus = BountyStatus.Cancelled;
        _refundDepositor();

        emit BountyCancelled(escrowBalance);
    }

    /// @notice Update the evaluator address (e.g., if relay changes).
    function setEvaluator(address _newEvaluator) external onlyDepositor {
        require(_newEvaluator != address(0), "Invalid evaluator");
        evaluator = _newEvaluator;
    }

    // ─── IERC8183: status ────────────────────────────────────────────────────

    function status() external view override returns (uint8) {
        return uint8(currentStatus);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function submissionCount() external view returns (uint256) {
        return submissionIds.length;
    }

    function getSubmission(bytes32 _id) external view returns (
        address submitter,
        string memory proposalUrl,
        uint256 submittedAt,
        uint8 verdict,
        string memory verdictReason,
        bool resolved
    ) {
        Submission storage s = submissions[_id];
        return (s.submitter, s.proposalUrl, s.submittedAt, s.verdict, s.verdictReason, s.resolved);
    }

    function getSubmissionIds() external view returns (bytes32[] memory) {
        return submissionIds;
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _transferPrize(address _winner) internal {
        uint256 amount = escrowBalance;
        escrowBalance = 0;

        if (escrowToken == address(0)) {
            (bool ok, ) = _winner.call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            IERC20(escrowToken).safeTransfer(_winner, amount);
        }
    }

    function _refundDepositor() internal {
        uint256 amount = escrowBalance;
        if (amount == 0) return;
        escrowBalance = 0;

        if (escrowToken == address(0)) {
            (bool ok, ) = depositor.call{value: amount}("");
            require(ok, "ETH refund failed");
        } else {
            IERC20(escrowToken).safeTransfer(depositor, amount);
        }
    }

    // Allow receiving ETH
    receive() external payable {
        escrowBalance += msg.value;
        prizeAmount   += msg.value;
        emit Deposited(msg.sender, address(0), msg.value);
    }
}
