#!/usr/bin/env node
/**
 * deploy-bounty.mjs — Deploy the ERC-8183 bounty system on Base Sepolia.
 *
 * Deploys:
 *   1. AgenticCommerce (ERC-8183 implementation)
 *   2. GenLayerEvaluator (evaluator that bridges to GenLayer)
 *   3. CourtAwareHook (reference hook for the bounty)
 *   4. Creates and funds the bounty job
 *
 * Usage: node scripts/deploy-bounty.mjs
 */

import {
  createPublicClient, createWalletClient, http,
  parseUnits, parseAbi, formatUnits, getAddress, encodePacked, keccak256, toBytes
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const RPC   = "https://sepolia.base.org";
const FORGE = `${process.env.HOME}/.foundry/bin/forge`;

// ── Known addresses ──────────────────────────────────────────────────────────
const COURT_FACTORY  = "0xd533cB0B52E85b3F506b6f0c28b8f6bc4E449Dda";

// ── Keys ─────────────────────────────────────────────────────────────────────
function loadKey(path) {
  const k = readFileSync(path, "utf8").trim();
  return k.startsWith("0x") ? k : "0x" + k;
}

const EXPORTER_KEY = loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`);
const exporterAcct = privateKeyToAccount(EXPORTER_KEY);

const transport = http(RPC);
const pub = createPublicClient({ chain: baseSepolia, transport });
const wallet = createWalletClient({ chain: baseSepolia, transport, account: exporterAcct });

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

// ── Bounty parameters ─────────────────────────────────────────────────────────
const PRIZE_AMOUNT = parseUnits("5000", 6);     // 5,000 USDC
const DEADLINE_DAYS = 30;
const DEADLINE = Math.floor(Date.now() / 1000) + DEADLINE_DAYS * 86400;
const JOB_DESCRIPTION = "ERC-8183 Court-Aware Extension Bounty: Design a court-aware extension for the Agentic Commerce Protocol that preserves the minimal escrow+evaluator primitive while enabling partial payouts, graduated penalties, refund windows, and resubmission through GenLayer AI adjudication. Deliverable: design memo, architecture diagram, judgment model, and concrete example flow.";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function deployContract(name, args = []) {
  const artifact = JSON.parse(readFileSync(
    `${ROOT}/sol/out/${name}.sol/${name}.json`, "utf8"
  ));

  console.log(`  Deploying ${name}...`);
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args,
  });

  const receipt = await pub.waitForTransactionReceipt({ hash });
  const addr = receipt.contractAddress;
  console.log(`  ✓ ${name} at ${addr} (tx: ${hash.slice(0, 14)}…)`);
  await sleep(3000); // nonce cooldown between deploys
  return { address: addr, abi: artifact.abi, hash };
}

async function main() {
  console.log("═══ ERC-8183 Bounty Deployment (v2 — Real Spec) ═══\n");
  console.log(`Deployer:  ${exporterAcct.address}`);
  console.log(`Network:   Base Sepolia`);
  console.log(`Prize:     ${formatUnits(PRIZE_AMOUNT, 6)} USDC`);
  console.log(`Deadline:  ${new Date(DEADLINE * 1000).toISOString()}\n`);

  // Step 1: Build
  console.log("▸ Building contracts...");
  execSync(`${FORGE} build`, { cwd: `${ROOT}/sol`, stdio: "pipe" });
  console.log("  ✓ Compiled\n");

  console.log("▸ Deploying MockUSDC...");
  const mockUSDC = await deployContract("MockUSDC");

  // Step 2: Deploy AgenticCommerce
  console.log("▸ Deploying ERC-8183 contracts...");
  const commerce = await deployContract("AgenticCommerce", [
    mockUSDC.address,        // paymentToken
    exporterAcct.address,    // treasury (fee recipient)
    0n,                      // feeBps (0 = no fee for bounty)
  ]);

  // Step 3: Deploy GenLayerEvaluator
  const evaluator = await deployContract("GenLayerEvaluator", [
    commerce.address,        // agenticCommerce
    COURT_FACTORY,           // courtRelay (IC factory delivers verdicts)
  ]);

  // Step 4: Deploy CourtAwareHook
  const hook = await deployContract("CourtAwareHook", [
    commerce.address,        // agenticCommerce
  ]);

  console.log();

  // Step 5: Create the bounty job
  console.log("▸ Creating bounty job...");
  const createHash = await wallet.writeContract({
    address: commerce.address,
    abi: commerce.abi,
    functionName: "createJob",
    args: [
      "0x0000000000000000000000000000000000000000", // provider = open (set later)
      evaluator.address,                             // evaluator = GenLayerEvaluator
      BigInt(DEADLINE),                              // expiredAt
      JOB_DESCRIPTION,                               // description
      hook.address,                                  // hook = CourtAwareHook
    ],
  });
  const createReceipt = await pub.waitForTransactionReceipt({ hash: createHash });

  // Get jobId from logs
  const jobCreatedTopic = keccak256(toBytes("JobCreated(uint256,address,address,address,uint256)"));
  const jobLog = createReceipt.logs.find(l => l.topics[0] === jobCreatedTopic);
  const jobId = jobLog ? BigInt(jobLog.topics[1]) : 0n;
  console.log(`  ✓ Job created: jobId=${jobId} (tx: ${createHash.slice(0, 14)}…)\n`);

  // Step 6: Set budget
  console.log("▸ Setting budget...");
  const budgetHash = await wallet.writeContract({
    address: commerce.address,
    abi: commerce.abi,
    functionName: "setBudget",
    args: [jobId, PRIZE_AMOUNT, "0x"],
  });
  await pub.waitForTransactionReceipt({ hash: budgetHash });
  console.log(`  ✓ Budget set to ${formatUnits(PRIZE_AMOUNT, 6)} USDC\n`);

  // Note: funding happens after a provider is set (per ERC-8183 spec).
  // For the bounty, the client will fund when a provider (submitter) is assigned.

  // Step 7: Mint USDC for the prize pool
  console.log("▸ Minting prize tokens...");
  const mintHash = await wallet.writeContract({
    address: mockUSDC.address,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [exporterAcct.address, PRIZE_AMOUNT],
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  console.log(`  ✓ Minted ${formatUnits(PRIZE_AMOUNT, 6)} USDC\n`);

  // Step 8: Pre-approve AgenticCommerce to spend tokens (for when we fund)
  console.log("▸ Pre-approving token spend...");
  const approveHash = await wallet.writeContract({
    address: mockUSDC.address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [commerce.address, PRIZE_AMOUNT],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  ✓ Approved\n`);

  // Step 9: Also authorize evaluator as relay on GenLayerEvaluator
  // (owner is already the deployer, so courtRelay = COURT_FACTORY is set)

  // Step 10: Save artifacts
  const artifacts = {
    version: 2,
    spec: "ERC-8183 (Agentic Commerce Protocol)",
    network: "base-sepolia",
    deployedAt: new Date().toISOString(),
    contracts: {
      agenticCommerce: commerce.address,
      genLayerEvaluator: evaluator.address,
      courtAwareHook: hook.address,
      paymentToken: mockUSDC.address,
      internetCourtFactory: COURT_FACTORY,
    },
    job: {
      jobId: Number(jobId),
      description: JOB_DESCRIPTION,
      prizeAmount: formatUnits(PRIZE_AMOUNT, 6),
      deadline: new Date(DEADLINE * 1000).toISOString(),
      deadlineUnix: DEADLINE,
      client: exporterAcct.address,
      evaluator: evaluator.address,
      hook: hook.address,
      status: "Open (awaiting provider + funding)",
    },
    txHashes: {
      deployCommerce: commerce.hash,
      deployEvaluator: evaluator.hash,
      deployHook: hook.hash,
      createJob: createHash,
      setBudget: budgetHash,
      mintPrize: mintHash,
      approvePrize: approveHash,
    },
  };

  mkdirSync(`${ROOT}/artifacts`, { recursive: true });
  writeFileSync(`${ROOT}/artifacts/bounty-deployment.json`, JSON.stringify(artifacts, null, 2));

  console.log("═══ Deployment Complete ═══\n");
  console.log(JSON.stringify(artifacts, null, 2));
  console.log("\n📋 Next steps:");
  console.log("  1. When a provider (submitter) appears, call setProvider(jobId, providerAddr)");
  console.log("  2. Then call fund(jobId, budget) to escrow the tokens");
  console.log("  3. Provider calls registerProposal() on hook, then submit() on AgenticCommerce");
  console.log("  4. Relay deploys ProposalEvaluator on GenLayer");
  console.log("  5. GenLayer verdict → bridge → GenLayerEvaluator → complete()/reject()");
}

main().catch(e => { console.error(e); process.exit(1); });
