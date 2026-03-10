# ERC-8183 Court-Aware Extension Bounty

**Live bounty page:** [acastellana.github.io/erc8183-bounty](https://acastellana.github.io/erc8183-bounty/)

A bounty for proposals that extend [ERC-8183 (Agentic Commerce Protocol)](https://eips.ethereum.org/EIPS/eip-8183) with court-aware dispute resolution via GenLayer AI adjudication.

## 🐕 Dogfooding

This bounty **is itself an ERC-8183 job**. The prize is held in a real `AgenticCommerce` contract with a `GenLayerEvaluator` (evaluator) and `CourtAwareHook` (hook). The bounty demonstrates the exact pattern it asks you to extend.

## The Problem

ERC-8183 is a minimal job escrow with evaluator attestation for AI agent commerce:
- **Three roles:** Client (funds), Provider (works), Evaluator (attests)
- **Six states:** Open → Funded → Submitted → Completed | Rejected | Expired
- **Hooks:** `IACPHook` — `beforeAction`/`afterAction` callbacks per job

But: *"No dispute resolution or arbitration; reject/expire is final."*

The bounty seeks proposals that add:
- **Partial payouts** — graduated fund distribution, not just all-or-nothing
- **Penalty tiers** — proportional consequences for quality/timing
- **Resubmission** — rejected providers can fix and try again
- **Multi-round evaluation** — sequential evaluation phases
- **Dispute escalation** — appeal path against evaluator decisions

All through the hooks system and/or custom evaluator contracts — **without modifying the core ERC-8183 interface**.

## Prize

**5,000 USDC** held in ERC-8183 job escrow on Base Sepolia.

## Evaluation Criteria

The GenLayer AI jury evaluates submissions against five mandatory criteria:

1. **Design memo** — Problem analysis, proposed extension, GenLayer integration, tradeoffs
2. **Architecture diagram** — Visual showing AgenticCommerce base + extension components + bridge
3. **Judgment model** — Graduated verdict codes with fund distribution rules
4. **Concrete example flow** — End-to-end walkthrough with specific values and ERC-8183 function calls
5. **ERC-8183 compatibility** — Extensions via hooks/evaluator contracts; core interface unchanged
6. **Author endorsement** — Posted on [Ethereum Magicians ERC-8183 thread](https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902) with a positive reply from any original EIP author: Davide Crapis (@dcrapis), Bryan Lim (@ai-virtual-b), Tay Weixiong (@twx-virtuals), or Chooi Zuhwa (@Zuhwa)

All six must pass for `complete()` to be called. The evaluator aggregates two GenLayer oracle signals — AI technical review (criteria 1-5) + forum endorsement verification (criterion 6).

## Deployed Contracts

| Contract | Network | Address |
|----------|---------|---------|
| AgenticCommerce | Base Sepolia | [`0x160b…abb1`](https://sepolia.basescan.org/address/0x160bc3cb45db987d957d6fee942a6ad7e0e2abb1) |
| GenLayerEvaluator (v2, dual-signal) | Base Sepolia | [`0xd0da…1f7f`](https://sepolia.basescan.org/address/0xd0da34b858137c4f27185c5a3b4056b91dd61f7f) |
| CourtAwareHook | Base Sepolia | [`0x1032…09a5`](https://sepolia.basescan.org/address/0x10320f3a68efec5027c03d766ddfa81b19e009a5) |
| MockUSDC (prize) | Base Sepolia | [`0x2a2f…4d4e`](https://sepolia.basescan.org/address/0x2a2f8da3bf952f31751191dfb9a076701bed4d4e) |
| InternetCourtFactory | Base Sepolia | [`0xd533…9Dda`](https://sepolia.basescan.org/address/0xd533cB0B52E85b3F506b6f0c28b8f6bc4E449Dda) |
| ProposalEvaluator (Signal 1) | GenLayer Studionet | Deployed per submission |
| EndorsementVerifier (Signal 2) | GenLayer Studionet | Deployed per submission |

## Architecture

```
BASE SEPOLIA                                    GENLAYER STUDIONET

┌────────────────────────────┐
│  AgenticCommerce (ERC-8183)│
│                            │
│  createJob()  ← client     │
│  setProvider() ← client    │
│  fund()       ← client     │                ┌─────────────────────┐
│  submit()     ← provider   │── event → relay │ ProposalEvaluator   │
│  complete()   ← evaluator  │                │ (GenLayer contract)  │
│  reject()     ← evaluator  │                │ • AI jury evaluates  │
│                            │                │ • 5-criteria rubric  │
│  hook: CourtAwareHook      │                │ • multi-LLM vote     │
└─────────────┬──────────────┘                └──────────┬───────────┘
              │                                          │
┌─────────────▼──────────────┐                           │
│  GenLayerEvaluator         │◀── LayerZero bridge ──────┘
│  deliverVerdict()          │
│  → complete() or reject()  │
└────────────────────────────┘
```

## How to Submit

1. Write your proposal covering all five criteria
2. Publish at a publicly accessible URL
3. Contact us to be assigned as provider via `setProvider()`
4. Once funded, call `registerProposal()` on CourtAwareHook
5. Call `submit()` on AgenticCommerce
6. Wait for GenLayer AI jury verdict

## Project Structure

```
├── contracts/
│   ├── ProposalEvaluator.py     # GenLayer AI jury contract
│   └── EndorsementVerifier.py   # Forum endorsement check
├── sol/src/
│   ├── IERC8183.sol              # ERC-8183 interface + IACPHook
│   ├── AgenticCommerce.sol       # ERC-8183 implementation
│   ├── GenLayerEvaluator.sol     # Evaluator bridging to GenLayer
│   ├── CourtAwareHook.sol        # Reference hook for the bounty
│   └── MockUSDC.sol              # 6-decimal test token
├── scripts/
│   ├── deploy-bounty.mjs         # Deploy all contracts + create job
│   ├── setup-job.mjs             # Complete job setup (budget, tokens)
│   ├── test-bounty.mjs           # 35-check test suite
│   ├── test-lifecycle.mjs        # 42-check lifecycle test
│   └── test-dual-signal.mjs      # Dual-signal flow test
├── artifacts/
│   └── bounty-deployment.json    # Deployment addresses and metadata
└── index.html                     # Bounty page
```

## Related

- [ERC-8183 Specification](https://eips.ethereum.org/EIPS/eip-8183) — The full Agentic Commerce Protocol EIP
- [Conditional Payment × GenLayer](https://acastellana.github.io/conditional-payment-cross-border-trade/) — Graduated penalty models and AI jury evaluation in production
- [GenLayer Documentation](https://docs.genlayer.com)

## License

MIT
