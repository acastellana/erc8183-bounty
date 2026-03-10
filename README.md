# ERC-8183 Court-Aware Extension Bounty

**Live bounty page:** [acastellana.github.io/erc8183-bounty](https://acastellana.github.io/erc8183-bounty/)

A bounty for proposals that extend ERC-8183 (minimal escrow + evaluator primitive) with court-aware commercial logic — partial payouts, graduated penalties, refund windows, and resubmission — powered by GenLayer AI adjudication.

## 🐕 Dogfooding

This bounty eats its own dogfood. The prize is held in a real ERC-8183 escrow contract on Base Sepolia. Submissions are evaluated by a GenLayer AI jury. If the jury accepts your proposal, the contract releases the prize to your address automatically.

## Prize

**50,000 PEN** held in escrow on Base Sepolia.

## Evaluation Criteria

The GenLayer AI jury evaluates every submission against five mandatory criteria:

1. **Design memo** — Problem statement, proposed solution, rationale, tradeoffs
2. **Architecture diagram** — Visual system overview showing ERC-8183 base + extension
3. **Judgment model** — How verdicts map to outcomes (partial payout, penalty, refund, resubmission)
4. **Concrete example flow** — End-to-end walkthrough with specific values
5. **ERC-8183 preservation** — Extensions layer on top; the base interface is unchanged

All five must pass for the bounty to be awarded.

## How to Submit

1. Write your proposal covering all five criteria
2. Publish at a publicly accessible URL (GitHub repo, HackMD, hosted page)
3. Call `submit(abi.encode(proposalUrl))` on the BountyEscrow8183 contract on Base Sepolia
4. Wait for the GenLayer AI jury verdict

## Deployed Contracts

| Contract | Network | Address |
|----------|---------|---------|
| BountyEscrow8183 | Base Sepolia | [`0x0ee284054841fc6e60d2e2047e1e0f88ae02fe16`](https://sepolia.basescan.org/address/0x0ee284054841fc6e60d2e2047e1e0f88ae02fe16) |
| MockPEN (prize token) | Base Sepolia | [`0x08bc87f6511913caa4e127c5e4e91618a37a9719`](https://sepolia.basescan.org/address/0x08bc87f6511913caa4e127c5e4e91618a37a9719) |
| InternetCourtFactory | Base Sepolia | [`0xd533cB0B52E85b3F506b6f0c28b8f6bc4E449Dda`](https://sepolia.basescan.org/address/0xd533cB0B52E85b3F506b6f0c28b8f6bc4E449Dda) |
| ProposalEvaluator | GenLayer Studionet | Deployed per submission |

## Architecture

```
BASE SEPOLIA                              GENLAYER

┌──────────────────────┐
│   BountyEscrow8183   │
│   implements IERC8183│
│                      │                 ┌──────────────────────┐
│  deposit()  ← sponsor│                 │  ProposalEvaluator   │
│  submit()   ← anyone │── event → relay →│  (GenLayer contract) │
│  resolve()  ← factory│                 │                      │
│                      │                 │  • fetches proposal   │
└──────────┬───────────┘                 │  • AI jury evaluates  │
           │                             │  • multi-LLM consensus│
┌──────────▼───────────┐                 └──────────┬───────────┘
│ InternetCourtFactory │                            │
│ (verdict dispatcher) │◀── LayerZero bridge ───────┘
└──────────────────────┘
```

## ERC-8183 Interface

```solidity
interface IERC8183 {
    function deposit(address token, uint256 amount) external payable;
    function submit(bytes calldata data) external returns (bytes32 submissionId);
    function resolve(bytes32 submissionId, uint8 verdict, bytes calldata data) external;

    function status() external view returns (uint8);
    function evaluator() external view returns (address);
    function depositor() external view returns (address);
    function escrowToken() external view returns (address);
    function escrowBalance() external view returns (uint256);
}
```

## Project Structure

```
├── contracts/
│   └── ProposalEvaluator.py    # GenLayer AI jury contract
├── sol/
│   └── src/
│       ├── IERC8183.sol         # The ERC-8183 interface
│       └── BountyEscrow8183.sol # Bounty escrow implementation
├── scripts/
│   └── deploy-bounty.mjs       # Deployment script
├── artifacts/
│   └── bounty-deployment.json  # Deployment artifacts
└── index.html                   # Bounty page
```

## Related

- [Conditional Payment × GenLayer](https://acastellana.github.io/conditional-payment-cross-border-trade/) — the original demo showing graduated penalties and AI jury evaluation in action
- [GenLayer Documentation](https://docs.genlayer.com)

## License

MIT
