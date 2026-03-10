#!/usr/bin/env node
/**
 * upgrade-evaluator.mjs — Deploy new GenLayerEvaluator (dual-signal)
 * and update it on the existing bounty job.
 */

import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

const deploy = JSON.parse(readFileSync(join(ROOT, "artifacts/bounty-deployment.json"), "utf8"));
const C = deploy.contracts;

const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });

function loadKey(p) { const k = readFileSync(p, "utf8").trim(); return k.startsWith("0x") ? k : "0x" + k; }
const clientAcct = privateKeyToAccount(loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`));
const w = createWalletClient({ chain: baseSepolia, transport, account: clientAcct });

const evaluatorArtifact = JSON.parse(readFileSync(join(ROOT, "sol/out/GenLayerEvaluator.sol/GenLayerEvaluator.json"), "utf8"));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("═══ Upgrade GenLayerEvaluator (dual-signal) ═══\n");

  // Deploy new evaluator
  console.log("▸ Deploying new GenLayerEvaluator...");
  const hash = await w.deployContract({
    abi: evaluatorArtifact.abi,
    bytecode: evaluatorArtifact.bytecode.object,
    args: [C.agenticCommerce, C.internetCourtFactory],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const newAddr = receipt.contractAddress;
  console.log(`  ✓ New evaluator at ${newAddr}`);
  console.log(`  tx: ${hash}\n`);

  await sleep(3000);

  // Verify it points correctly
  const commerce = await pub.readContract({ address: newAddr, abi: evaluatorArtifact.abi, functionName: "agenticCommerce" });
  const relay = await pub.readContract({ address: newAddr, abi: evaluatorArtifact.abi, functionName: "courtRelay" });
  console.log(`  agenticCommerce: ${commerce}`);
  console.log(`  courtRelay: ${relay}`);

  // Check pending signals view
  const [needsAI, needsEndorsement] = await pub.readContract({
    address: newAddr, abi: evaluatorArtifact.abi, functionName: "pendingSignals", args: [0n]
  });
  console.log(`  pendingSignals(job0): needsAI=${needsAI}, needsEndorsement=${needsEndorsement}`);

  // Update artifacts
  const oldEvaluator = C.genLayerEvaluator;
  deploy.contracts.genLayerEvaluator = newAddr;
  deploy.contracts.genLayerEvaluatorV1 = oldEvaluator;
  deploy.job.evaluator = newAddr;
  deploy.job.evaluatorNote = "Dual-signal: AI jury + author endorsement";
  writeFileSync(join(ROOT, "artifacts/bounty-deployment.json"), JSON.stringify(deploy, null, 2));

  console.log(`\n  Old evaluator: ${oldEvaluator}`);
  console.log(`  New evaluator: ${newAddr}`);
  console.log(`\n  ⚠️  Note: Job #0's evaluator is still the old address on-chain.`);
  console.log(`  For NEW jobs, use the new evaluator address.`);
  console.log(`  Job #0 was created with evaluator=${oldEvaluator} which is immutable per ERC-8183.`);
  console.log(`  The old evaluator's deliverVerdict() still works (backwards compatible).`);

  console.log("\n═══ Done ═══");
}

main().catch(e => { console.error(e); process.exit(1); });
