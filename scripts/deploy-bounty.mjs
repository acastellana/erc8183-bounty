#!/usr/bin/env node
/**
 * deploy-bounty.mjs
 *
 * Deploys the BountyEscrow8183 contract on Base Sepolia and funds it with
 * MockPEN tokens as the bounty prize.
 *
 * Steps:
 *   1. Build Solidity contracts via Forge
 *   2. Deploy BountyEscrow8183
 *   3. Deposit prize tokens
 *   4. Save deployment artifacts
 *
 * Usage: node scripts/deploy-bounty.mjs
 */

import {
  createPublicClient, createWalletClient, http,
  parseUnits, parseAbi, formatUnits, getAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const TRADE_ROOT = join(ROOT, "..", "conditional-payment-cross-border-trade");
const RPC   = "https://sepolia.base.org";
const FORGE = `${process.env.HOME}/.foundry/bin/forge`;

// ── Known addresses (reuse from conditional-payment project) ──────────────────
const MOCK_PEN        = "0x08bc87f6511913caa4e127c5e4e91618a37a9719";
const COURT_FACTORY   = "0xd533cB0B52E85b3F506b6f0c28b8f6bc4E449Dda";
const EXPORTER        = "0xe9630ba0e3cc2d3BFC58fbE1Bbde478f06E4CE87"; // bounty depositor

// ── Keys ─────────────────────────────────────────────────────────────────────
function loadKey(path) {
  const k = readFileSync(path, "utf8").trim();
  return k.startsWith("0x") ? k : "0x" + k;
}

const EXPORTER_KEY = loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`);
const exporterAcct = privateKeyToAccount(EXPORTER_KEY);

const transport = http(RPC);
const pub = createPublicClient({ chain: baseSepolia, transport });
const exporterW = createWalletClient({ chain: baseSepolia, transport, account: exporterAcct });

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

// ── Bounty parameters ─────────────────────────────────────────────────────────
const BOUNTY_TITLE       = "ERC-8183 Court-Aware Extension";
const BOUNTY_DESCRIPTION = "Design a court-aware extension layer for ERC-8183 that preserves the minimal escrow+evaluator primitive while enabling partial payouts, penalties, refunds, and resubmission through GenLayer AI adjudication.";
const CRITERIA_URL       = "ipfs://bounty-criteria-v1"; // Will update after IPFS pin
const PRIZE_AMOUNT       = parseUnits("50000", 18);     // 50,000 PEN
const DEADLINE_DAYS      = 30;
const DEADLINE           = Math.floor(Date.now() / 1000) + DEADLINE_DAYS * 86400;

async function main() {
  console.log("═══ ERC-8183 Bounty Deployment ═══\n");
  console.log(`Deployer:  ${exporterAcct.address}`);
  console.log(`Network:   Base Sepolia`);
  console.log(`Prize:     ${formatUnits(PRIZE_AMOUNT, 18)} PEN`);
  console.log(`Deadline:  ${new Date(DEADLINE * 1000).toISOString()}`);
  console.log(`Evaluator: ${COURT_FACTORY} (InternetCourtFactory)\n`);

  // Step 1: Build
  console.log("▸ Building contracts...");
  execSync(`${FORGE} build`, { cwd: `${ROOT}/sol`, stdio: "pipe" });
  console.log("  ✓ Contracts compiled\n");

  // Step 2: Get bytecode
  const artifact = JSON.parse(readFileSync(
    `${ROOT}/sol/out/BountyEscrow8183.sol/BountyEscrow8183.json`, "utf8"
  ));
  const bytecode = artifact.bytecode.object;

  // Step 3: Deploy BountyEscrow8183
  console.log("▸ Deploying BountyEscrow8183...");

  // Constructor: (evaluator, token, title, description, criteriaUrl, deadline)
  const deployHash = await exporterW.deployContract({
    abi: artifact.abi,
    bytecode,
    args: [
      COURT_FACTORY,    // evaluator (IC Factory delivers verdicts)
      MOCK_PEN,         // ERC-20 token
      BOUNTY_TITLE,
      BOUNTY_DESCRIPTION,
      CRITERIA_URL,
      BigInt(DEADLINE),
    ],
  });

  console.log(`  Deploy tx: ${deployHash}`);
  const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const bountyAddress = deployReceipt.contractAddress;
  console.log(`  ✓ BountyEscrow8183 deployed at: ${bountyAddress}\n`);

  // Step 4: Mint PEN for prize (testnet)
  console.log("▸ Minting prize tokens...");
  const mintHash = await exporterW.writeContract({
    address: MOCK_PEN,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [exporterAcct.address, PRIZE_AMOUNT],
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  console.log(`  ✓ Minted ${formatUnits(PRIZE_AMOUNT, 18)} PEN\n`);

  // Step 5: Approve + Deposit
  console.log("▸ Approving + depositing prize...");
  const approveHash = await exporterW.writeContract({
    address: MOCK_PEN,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [bountyAddress, PRIZE_AMOUNT],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });

  // Deposit via IERC8183
  const depositHash = await exporterW.writeContract({
    address: bountyAddress,
    abi: artifact.abi,
    functionName: "deposit",
    args: [MOCK_PEN, PRIZE_AMOUNT],
  });
  await pub.waitForTransactionReceipt({ hash: depositHash });

  // Verify balance
  const balance = await pub.readContract({
    address: bountyAddress,
    abi: artifact.abi,
    functionName: "escrowBalance",
  });
  console.log(`  ✓ Escrow balance: ${formatUnits(balance, 18)} PEN\n`);

  // Step 6: Save artifacts
  const artifacts = {
    network: "base-sepolia",
    deployedAt: new Date().toISOString(),
    bountyContract: bountyAddress,
    token: MOCK_PEN,
    prizeAmount: formatUnits(PRIZE_AMOUNT, 18),
    deadline: new Date(DEADLINE * 1000).toISOString(),
    deadlineUnix: DEADLINE,
    evaluator: COURT_FACTORY,
    depositor: exporterAcct.address,
    title: BOUNTY_TITLE,
    description: BOUNTY_DESCRIPTION,
    txHashes: {
      deploy: deployHash,
      mint: mintHash,
      approve: approveHash,
      deposit: depositHash,
    },
  };

  mkdirSync(`${ROOT}/artifacts`, { recursive: true });
  writeFileSync(`${ROOT}/artifacts/bounty-deployment.json`, JSON.stringify(artifacts, null, 2));
  console.log("═══ Deployment Complete ═══");
  console.log(JSON.stringify(artifacts, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
