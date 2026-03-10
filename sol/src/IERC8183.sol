// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IERC8183 — Agentic Commerce Protocol
 * @notice ERC-8183: Job escrow with evaluator attestation for agent commerce.
 *
 * A job has escrowed budget, four active states (Open → Funded → Submitted → Terminal),
 * and an evaluator who alone may mark the job completed or rejected after submission.
 *
 * Ref: https://eips.ethereum.org/EIPS/eip-8183
 */

/// @notice Hook interface for extending ERC-8183 jobs.
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

interface IERC8183 {
    // ─── Enums ────────────────────────────────────────────────────────────────
    enum Status { Open, Funded, Submitted, Completed, Rejected, Expired }

    // ─── Events ───────────────────────────────────────────────────────────────
    event JobCreated(uint256 indexed jobId, address indexed client, address provider, address evaluator, uint256 expiredAt);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    // ─── Core Functions ───────────────────────────────────────────────────────

    /// @notice Create a job. Provider MAY be zero (set later via setProvider).
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    /// @notice Set provider on a job created with provider=0. Client only.
    function setProvider(uint256 jobId, address provider, bytes calldata optParams) external;

    /// @notice Set or negotiate budget. Client or provider.
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;

    /// @notice Fund the job escrow. Client only. Moves Open → Funded.
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;

    /// @notice Submit deliverable. Provider only. Moves Funded → Submitted.
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;

    /// @notice Complete job. Evaluator only when Submitted. Releases escrow to provider.
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @notice Reject job. Client when Open; evaluator when Funded or Submitted. Refunds client.
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @notice Claim refund after expiry. Anyone may call.
    function claimRefund(uint256 jobId) external;
}
