#!/usr/bin/env node
/**
 * setup-job.mjs — Complete job setup after contract deployment.
 * Sets budget, mints tokens, approves spend.
 * NOTE: This script uses hardcoded addresses from the deployment artifacts.
 *       After a fresh deploy, update COMMERCE/EVALUATOR/HOOK/TOKEN or
 *       load them from artifacts/bounty-deployment.json.
 */

import {
  createPublicClient, createWalletClient, http,
  parseUnits, parseAbi, formatUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const RPC   = "https://sepolia.base.org";

// Load from artifacts so this stays in sync with deploy
const deploy = JSON.parse(readFileSync(`${ROOT}/artifacts/bounty-deployment.json`, "utf8"));
const COMMERCE  = deploy.contracts.agenticCommerce;
const TOKEN     = deploy.contracts.paymentToken;
const EVALUATOR = deploy.contracts.genLayerEvaluator;
const HOOK      = deploy.contracts.courtAwareHook;
const JOB_ID    = 0n;
const PRIZE     = parseUnits("5000", 6); // 5,000 USDC

function loadKey(p) { const k = readFileSync(p,"utf8").trim(); return k.startsWith("0x") ? k : "0x"+k; }
const KEY = loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`);
const acct = privateKeyToAccount(KEY);
const transport = http(RPC);
const pub = createPublicClient({ chain: baseSepolia, transport });
const w = createWalletClient({ chain: baseSepolia, transport, account: acct });

const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
]);
const ABI = JSON.parse(readFileSync(`${ROOT}/sol/out/AgenticCommerce.sol/AgenticCommerce.json`,"utf8")).abi;

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function step(label, fn) {
  process.stdout.write(`▸ ${label}... `);
  const hash = await fn();
  await pub.waitForTransactionReceipt({ hash });
  console.log(`✓ (${hash.slice(0,14)}…)`);
  await sleep(2000);
  return hash;
}

async function main() {
  console.log("═══ Complete Job Setup ═══\n");

  const hashes = {};

  hashes.setBudget = await step("Set budget to 5,000 USDC", () =>
    w.writeContract({ address: COMMERCE, abi: ABI, functionName: "setBudget", args: [JOB_ID, PRIZE, "0x"] })
  );

  hashes.mint = await step("Mint 5,000 USDC", () =>
    w.writeContract({ address: TOKEN, abi: ERC20, functionName: "mint", args: [acct.address, PRIZE] })
  );

  hashes.approve = await step("Approve AgenticCommerce to spend USDC", () =>
    w.writeContract({ address: TOKEN, abi: ERC20, functionName: "approve", args: [COMMERCE, PRIZE] })
  );

  // Verify state
  console.log("\n▸ Verifying state...");
  const job = await pub.readContract({ address: COMMERCE, abi: ABI, functionName: "getJob", args: [JOB_ID] });
  console.log(`  Status: ${["Open","Funded","Submitted","Completed","Rejected","Expired"][Number(job[6])]}`);
  console.log(`  Budget: ${formatUnits(job[4], 6)} USDC`);
  console.log(`  Evaluator: ${job[2]}`);
  console.log(`  Hook: ${job[7]}`);
  console.log(`  Provider: ${job[1] === "0x0000000000000000000000000000000000000000" ? "(open)" : job[1]}`);
  console.log(`  Deadline: ${new Date(Number(job[5]) * 1000).toISOString()}`);

  const bal = await pub.readContract({ address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [acct.address] });
  console.log(`  Client USDC balance: ${formatUnits(bal, 6)}`);

  // Update artifacts
  const artifacts = JSON.parse(readFileSync(`${ROOT}/artifacts/bounty-deployment.json`, "utf8"));
  artifacts.txHashes.setBudget = hashes.setBudget;
  artifacts.txHashes.mintPrize = hashes.mint;
  artifacts.txHashes.approvePrize = hashes.approve;
  artifacts.job.status = "Open (budget set, tokens minted+approved, awaiting provider)";
  writeFileSync(`${ROOT}/artifacts/bounty-deployment.json`, JSON.stringify(artifacts, null, 2));

  console.log("\n═══ Setup Complete ═══");
  console.log("Job is ready. When a provider submits:");
  console.log("  1. Client calls setProvider(0, providerAddr, '0x')");
  console.log("  2. Client calls fund(0, 5000e6, '0x')");
  console.log("  3. Provider calls hook.registerProposal(0, url, title)");
  console.log("  4. Provider calls commerce.submit(0, keccak256(url), '0x')");
}

main().catch(e => { console.error(e); process.exit(1); });
