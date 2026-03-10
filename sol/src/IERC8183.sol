// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IERC8183 — Minimal Escrow & Evaluator Primitive
 * @notice A standard interface for contracts that lock value and release it
 *         based on the verdict of an external evaluator (oracle).
 *
 * ERC-8183 deliberately stays minimal:
 *   • One depositor locks funds for a specific purpose.
 *   • One evaluator (oracle) is trusted to render a verdict.
 *   • The contract maps verdicts → fund distribution.
 *
 * Extensions (partial payout, penalty tiers, resubmission, multi-party)
 * are intentionally out of scope and should be layered on top.
 */
interface IERC8183 {
    // ─── Lifecycle statuses ──────────────────────────────────────────────────
    // Implementations MUST support at least these four states.
    // Additional states (e.g., Expired, Cancelled) are allowed.
    //
    //   Open       → funds deposited, awaiting evaluation trigger
    //   Evaluating → evaluation in progress (oracle working)
    //   Resolved   → verdict rendered, funds distributed
    //   Expired    → deadline passed with no resolution

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when funds are deposited into escrow.
    event Deposited(address indexed depositor, address indexed token, uint256 amount);

    /// @notice Emitted when evaluation is requested for a submission.
    event EvaluationRequested(bytes32 indexed submissionId, address indexed submitter, bytes data);

    /// @notice Emitted when the evaluator renders a verdict.
    event Resolved(bytes32 indexed submissionId, uint8 verdict, bytes resolutionData);

    // ─── Core operations ─────────────────────────────────────────────────────

    /// @notice Deposit funds into escrow. May be called once or incrementally.
    /// @param token ERC-20 token address (address(0) for native ETH).
    /// @param amount Amount to deposit (ignored if msg.value > 0 for ETH).
    function deposit(address token, uint256 amount) external payable;

    /// @notice Submit data for evaluation. Returns a unique submission ID.
    /// @param data ABI-encoded submission payload (format is application-specific).
    /// @return submissionId Unique identifier for this submission.
    function submit(bytes calldata data) external returns (bytes32 submissionId);

    /// @notice Called by the evaluator to render a verdict on a submission.
    /// @param submissionId The submission being resolved.
    /// @param verdict Application-specific verdict code (0 = undetermined).
    /// @param resolutionData ABI-encoded resolution details.
    function resolve(bytes32 submissionId, uint8 verdict, bytes calldata resolutionData) external;

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @notice Returns the contract's current lifecycle status.
    function status() external view returns (uint8);

    /// @notice Returns the address authorized to call resolve().
    function evaluator() external view returns (address);

    /// @notice Returns the address that deposited funds.
    function depositor() external view returns (address);

    /// @notice Returns the escrow token address (address(0) for ETH).
    function escrowToken() external view returns (address);

    /// @notice Returns the current escrow balance.
    function escrowBalance() external view returns (uint256);
}
