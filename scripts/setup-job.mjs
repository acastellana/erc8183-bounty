#!/usr/bin/env node
/**
 * setup-job.mjs — Complete job setup after contract deployment.
 * Sets budget, mints tokens, approves spend.
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

const MOCK_PEN = "0x08bc87f6511913caa4e127c5e4e91618a37a9719";
const COMMERCE = "0x45f0a7987fa2e83aa20425863482d9b2a3560d21";
const EVALUATOR = "0xaf1b4ab035e36b1e8f6194543ecc78cfdbd11f04";
const HOOK = "0xb0ccec14e35c5c14a497b67438900d9e27d45387";
const JOB_ID = 0n;
const PRIZE = parseUnits("50000", 18);

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
  await sleep(2000); // nonce cooldown
  return hash;
}

async function main() {
  console.log("═══ Complete Job Setup ═══\n");

  const hashes = {};

  hashes.setBudget = await step("Set budget to 50,000 PEN", () =>
    w.writeContract({ address: COMMERCE, abi: ABI, functionName: "setBudget", args: [JOB_ID, PRIZE, "0x"] })
  );

  hashes.mint = await step("Mint 50,000 PEN", () =>
    w.writeContract({ address: MOCK_PEN, abi: ERC20, functionName: "mint", args: [acct.address, PRIZE] })
  );

  hashes.approve = await step("Approve AgenticCommerce to spend PEN", () =>
    w.writeContract({ address: MOCK_PEN, abi: ERC20, functionName: "approve", args: [COMMERCE, PRIZE] })
  );

  // Verify state
  console.log("\n▸ Verifying state...");
  const job = await pub.readContract({ address: COMMERCE, abi: ABI, functionName: "getJob", args: [JOB_ID] });
  console.log(`  Status: ${["Open","Funded","Submitted","Completed","Rejected","Expired"][Number(job[6])]}`);
  console.log(`  Budget: ${formatUnits(job[4], 18)} PEN`);
  console.log(`  Evaluator: ${job[2]}`);
  console.log(`  Hook: ${job[7]}`);
  console.log(`  Provider: ${job[1] === "0x0000000000000000000000000000000000000000" ? "(open)" : job[1]}`);
  console.log(`  Deadline: ${new Date(Number(job[5]) * 1000).toISOString()}`);

  const bal = await pub.readContract({ address: MOCK_PEN, abi: ERC20, functionName: "balanceOf", args: [acct.address] });
  console.log(`  Client PEN balance: ${formatUnits(bal, 18)}`);

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
  console.log("  2. Client calls fund(0, 50000e18, '0x')");
  console.log("  3. Provider calls hook.registerProposal(0, url, title)");
  console.log("  4. Provider calls commerce.submit(0, keccak256(url), '0x')");
}

main().catch(e => { console.error(e); process.exit(1); });
