// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IERC8183.sol";

/**
 * @title AgenticCommerce
 * @notice Reference implementation of ERC-8183: Agentic Commerce Protocol.
 *
 * Job escrow with evaluator attestation for agent commerce.
 * Open → Funded → Submitted → Completed | Rejected | Expired
 *
 * Supports optional IACPHook per-job for extensibility (before/after callbacks).
 * claimRefund is deliberately NOT hookable (safety: refunds can never be blocked).
 */
contract AgenticCommerce is IERC8183, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Storage ──────────────────────────────────────────────────────────────

    struct Job {
        address client;
        address provider;
        address evaluator;
        string  description;
        uint256 budget;
        uint256 expiredAt;
        Status  status;
        address hook;           // IACPHook or address(0)
        bytes32 deliverable;    // set on submit
    }

    IERC20 public immutable paymentToken;
    address public treasury;        // optional fee recipient
    uint256 public feeBps;          // basis points (0 = no fee)

    uint256 public nextJobId;
    mapping(uint256 => Job) public jobs;

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _paymentToken, address _treasury, uint256 _feeBps) {
        require(_paymentToken != address(0), "Invalid token");
        require(_feeBps <= 1000, "Fee too high"); // max 10%
        paymentToken = IERC20(_paymentToken);
        treasury = _treasury;
        feeBps = _feeBps;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyClient(uint256 jobId) {
        require(msg.sender == jobs[jobId].client, "Not client");
        _;
    }

    modifier onlyProvider(uint256 jobId) {
        require(msg.sender == jobs[jobId].provider, "Not provider");
        _;
    }

    modifier onlyEvaluator(uint256 jobId) {
        require(msg.sender == jobs[jobId].evaluator, "Not evaluator");
        _;
    }

    modifier inStatus(uint256 jobId, Status expected) {
        require(jobs[jobId].status == expected, "Invalid status");
        _;
    }

    // ─── Hook helpers ─────────────────────────────────────────────────────────

    function _beforeHook(uint256 jobId, bytes4 selector, bytes memory data) internal {
        address hook = jobs[jobId].hook;
        if (hook != address(0)) {
            IACPHook(hook).beforeAction(jobId, selector, data);
        }
    }

    function _afterHook(uint256 jobId, bytes4 selector, bytes memory data) internal {
        address hook = jobs[jobId].hook;
        if (hook != address(0)) {
            IACPHook(hook).afterAction(jobId, selector, data);
        }
    }

    // ─── Core Functions ───────────────────────────────────────────────────────

    /// @inheritdoc IERC8183
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external override returns (uint256 jobId) {
        require(evaluator != address(0), "Evaluator required");
        require(expiredAt > block.timestamp, "Expiry must be future");

        jobId = nextJobId++;
        jobs[jobId] = Job({
            client:      msg.sender,
            provider:    provider,       // MAY be address(0)
            evaluator:   evaluator,
            description: description,
            budget:      0,
            expiredAt:   expiredAt,
            status:      Status.Open,
            hook:        hook,
            deliverable: bytes32(0)
        });

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    /// @inheritdoc IERC8183
    function setProvider(
        uint256 jobId,
        address provider,
        bytes calldata optParams
    ) external override onlyClient(jobId) inStatus(jobId, Status.Open) {
        Job storage job = jobs[jobId];
        require(job.provider == address(0), "Provider already set");
        require(provider != address(0), "Invalid provider");

        _beforeHook(jobId, this.setProvider.selector, abi.encode(provider, optParams));

        job.provider = provider;

        emit ProviderSet(jobId, provider);

        _afterHook(jobId, this.setProvider.selector, abi.encode(provider, optParams));
    }

    /// @inheritdoc IERC8183
    function setBudget(
        uint256 jobId,
        uint256 amount,
        bytes calldata optParams
    ) external override inStatus(jobId, Status.Open) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client || msg.sender == job.provider, "Not client or provider");

        _beforeHook(jobId, this.setBudget.selector, abi.encode(amount, optParams));

        job.budget = amount;

        emit BudgetSet(jobId, amount);

        _afterHook(jobId, this.setBudget.selector, abi.encode(amount, optParams));
    }

    /// @inheritdoc IERC8183
    function fund(
        uint256 jobId,
        uint256 expectedBudget,
        bytes calldata optParams
    ) external override nonReentrant onlyClient(jobId) inStatus(jobId, Status.Open) {
        Job storage job = jobs[jobId];
        require(job.provider != address(0), "Provider not set");
        require(job.budget > 0, "Budget not set");
        require(job.budget == expectedBudget, "Budget mismatch");

        _beforeHook(jobId, this.fund.selector, optParams);

        paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);
        job.status = Status.Funded;

        emit JobFunded(jobId, msg.sender, job.budget);

        _afterHook(jobId, this.fund.selector, optParams);
    }

    /// @inheritdoc IERC8183
    function submit(
        uint256 jobId,
        bytes32 deliverable,
        bytes calldata optParams
    ) external override onlyProvider(jobId) inStatus(jobId, Status.Funded) {
        _beforeHook(jobId, this.submit.selector, abi.encode(deliverable, optParams));

        jobs[jobId].deliverable = deliverable;
        jobs[jobId].status = Status.Submitted;

        emit JobSubmitted(jobId, msg.sender, deliverable);

        _afterHook(jobId, this.submit.selector, abi.encode(deliverable, optParams));
    }

    /// @inheritdoc IERC8183
    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external override nonReentrant onlyEvaluator(jobId) inStatus(jobId, Status.Submitted) {
        Job storage job = jobs[jobId];

        _beforeHook(jobId, this.complete.selector, abi.encode(reason, optParams));

        job.status = Status.Completed;

        // Calculate fee
        uint256 fee = (feeBps > 0 && treasury != address(0))
            ? (job.budget * feeBps) / 10000
            : 0;
        uint256 payout = job.budget - fee;

        // Transfer to provider
        paymentToken.safeTransfer(job.provider, payout);
        if (fee > 0) {
            paymentToken.safeTransfer(treasury, fee);
        }

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, payout);

        _afterHook(jobId, this.complete.selector, abi.encode(reason, optParams));
    }

    /// @inheritdoc IERC8183
    function reject(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external override nonReentrant {
        Job storage job = jobs[jobId];
        Status s = job.status;

        // Client can reject when Open; evaluator can reject when Funded or Submitted
        if (s == Status.Open) {
            require(msg.sender == job.client, "Only client when Open");
        } else if (s == Status.Funded || s == Status.Submitted) {
            require(msg.sender == job.evaluator, "Only evaluator when Funded/Submitted");
        } else {
            revert("Invalid status for reject");
        }

        _beforeHook(jobId, this.reject.selector, abi.encode(reason, optParams));

        job.status = Status.Rejected;

        // Refund if funded
        if (s == Status.Funded || s == Status.Submitted) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }

        emit JobRejected(jobId, msg.sender, reason);

        _afterHook(jobId, this.reject.selector, abi.encode(reason, optParams));
    }

    /// @inheritdoc IERC8183
    /// @dev NOT hookable — safety: refunds after expiry can never be blocked.
    function claimRefund(uint256 jobId) external override nonReentrant {
        Job storage job = jobs[jobId];
        Status s = job.status;
        require(s == Status.Funded || s == Status.Submitted, "Not refundable");
        require(block.timestamp >= job.expiredAt, "Not expired yet");

        job.status = Status.Expired;

        paymentToken.safeTransfer(job.client, job.budget);

        emit JobExpired(jobId);
        emit Refunded(jobId, job.client, job.budget);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getJob(uint256 jobId) external view returns (
        address client,
        address provider,
        address evaluator,
        string memory description,
        uint256 budget,
        uint256 expiredAt,
        Status status,
        address hook,
        bytes32 deliverable
    ) {
        Job storage j = jobs[jobId];
        return (j.client, j.provider, j.evaluator, j.description, j.budget, j.expiredAt, j.status, j.hook, j.deliverable);
    }

    function jobCount() external view returns (uint256) {
        return nextJobId;
    }
}
