#!/usr/bin/env node
/**
 * test-dual-signal.mjs — Test the dual-signal GenLayerEvaluator.
 *
 * Creates a new job with the v2 evaluator, then tests:
 *   1. AI verdict arrives (ACCEPT) — job stays Submitted (waiting for endorsement)
 *   2. Endorsement arrives (ACCEPT) — job moves to Completed
 *   3. Reject-fast: AI REJECT → immediate reject (no wait for endorsement)
 */

import {
  createPublicClient, createWalletClient, http,
  parseUnits, parseAbi, formatUnits, keccak256, toBytes, decodeEventLog
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const deploy = JSON.parse(readFileSync(join(ROOT, "artifacts/bounty-deployment.json"), "utf8"));
const C = deploy.contracts;

const commerceABI = JSON.parse(readFileSync(join(ROOT, "sol/out/AgenticCommerce.sol/AgenticCommerce.json"), "utf8")).abi;
const evaluatorABI = JSON.parse(readFileSync(join(ROOT, "sol/out/GenLayerEvaluator.sol/GenLayerEvaluator.json"), "utf8")).abi;
const hookABI = JSON.parse(readFileSync(join(ROOT, "sol/out/CourtAwareHook.sol/CourtAwareHook.json"), "utf8")).abi;
const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)","function mint(address,uint256)"]);

const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });

function loadKey(p) { const k = readFileSync(p, "utf8").trim(); return k.startsWith("0x") ? k : "0x" + k; }
const clientAcct = privateKeyToAccount(loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`));
const providerAcct = privateKeyToAccount(loadKey(`${process.env.HOME}/.internetcourt/.importer_key`));
const clientW = createWalletClient({ chain: baseSepolia, transport, account: clientAcct });
const providerW = createWalletClient({ chain: baseSepolia, transport, account: providerAcct });

const STATUSES = ["Open","Funded","Submitted","Completed","Rejected","Expired"];
const PRIZE = parseUnits("50", 6);
const URL = "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md";
const DELIVERABLE = keccak256(toBytes(URL));
const NEW_EVAL = C.genLayerEvaluator; // v2 dual-signal

let pass = 0, fail = 0;
function check(l, ok, d="") { console.log(`  ${ok?"✅":"❌"} ${l}${d?" — "+d:""}`); ok?pass++:fail++; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function tx(label, fn) {
  process.stdout.write(`▸ ${label}... `);
  const h = await fn();
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log(r.status==="success" ? "✓" : "✗");
  check(label, r.status==="success");
  await sleep(4000);
  return r;
}

async function getStatus(jobId) {
  const j = await pub.readContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "getJob", args: [jobId] });
  return Number(j[6]);
}

async function createAndFundJob() {
  const deadline = Math.floor(Date.now()/1000) + 7200;
  const r1 = await tx("createJob", () => clientW.writeContract({
    address: C.agenticCommerce, abi: commerceABI, functionName: "createJob",
    args: ["0x0000000000000000000000000000000000000000", NEW_EVAL, BigInt(deadline), "Dual-signal test", C.courtAwareHook]
  }));
  let jobId;
  for (const log of r1.logs) {
    try { const d = decodeEventLog({ abi: commerceABI, data: log.data, topics: log.topics });
      if (d.eventName === "JobCreated") jobId = d.args.jobId; } catch {}
  }
  console.log(`  jobId: ${jobId}`);

  await tx("setBudget", () => clientW.writeContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "setBudget", args: [jobId, PRIZE, "0x"] }));
  await tx("setProvider", () => clientW.writeContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "setProvider", args: [jobId, providerAcct.address, "0x"] }));
  await tx("mint", () => clientW.writeContract({ address: C.paymentToken, abi: ERC20, functionName: "mint", args: [clientAcct.address, PRIZE] }));
  await tx("approve", () => clientW.writeContract({ address: C.paymentToken, abi: ERC20, functionName: "approve", args: [C.agenticCommerce, PRIZE] }));
  await tx("fund", () => clientW.writeContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "fund", args: [jobId, PRIZE, "0x"] }));
  await tx("registerProposal", () => providerW.writeContract({ address: C.courtAwareHook, abi: hookABI, functionName: "registerProposal", args: [jobId, URL, "Dual-signal test"] }));
  await tx("submit", () => providerW.writeContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "submit", args: [jobId, DELIVERABLE, "0x"] }));

  return jobId;
}

async function main() {
  console.log("═══ Dual-Signal Evaluator Test ═══");
  console.log(`Evaluator (v2): ${NEW_EVAL}\n`);

  // ── Test 1: Both signals ACCEPT ─────────────────────────────────────────
  console.log("━━━ Test 1: AI ACCEPT + Endorsement ACCEPT → Completed ━━━\n");
  const job1 = await createAndFundJob();

  const reason1 = keccak256(toBytes("all criteria pass"));

  // Register evaluation
  await tx("registerEvaluation", () => clientW.writeContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "registerEvaluation", args: [job1, DELIVERABLE]
  }));

  // Signal 1: AI ACCEPT
  await tx("deliverAIVerdict (ACCEPT)", () => clientW.writeContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "deliverAIVerdict",
    args: [job1, 1, reason1, "All 5 criteria met. Strong design."]
  }));

  let s = await getStatus(job1);
  check("After AI ACCEPT only → still Submitted", s === 2, STATUSES[s]);

  // Check pending signals
  const [needsAI, needsEndorse] = await pub.readContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "pendingSignals", args: [job1]
  });
  check("AI signal delivered", !needsAI);
  check("Endorsement still pending", needsEndorse);

  // Signal 2: Endorsement ACCEPT
  await tx("deliverEndorsement (ACCEPT)", () => clientW.writeContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "deliverEndorsement",
    args: [job1, 1, reason1, "Davide commented: 'Excellent extension proposal, aligns well with the spec.'"]
  }));

  s = await getStatus(job1);
  check("After both ACCEPT → Completed", s === 3, STATUSES[s]);

  // ── Test 2: AI REJECT → immediate reject ────────────────────────────────
  console.log("\n━━━ Test 2: AI REJECT → immediate Rejected (no wait) ━━━\n");
  const job2 = await createAndFundJob();

  await tx("registerEvaluation #2", () => clientW.writeContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "registerEvaluation", args: [job2, DELIVERABLE]
  }));

  await tx("deliverAIVerdict (REJECT)", () => clientW.writeContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "deliverAIVerdict",
    args: [job2, 2, keccak256(toBytes("missing diagram")), "Missing architecture diagram."]
  }));

  s = await getStatus(job2);
  check("AI REJECT → immediate Rejected", s === 4, STATUSES[s]);

  // Endorsement should NOT be needed
  const resolved = await pub.readContract({ address: NEW_EVAL, abi: evaluatorABI, functionName: "isFullyResolved", args: [job2] });
  check("Evaluator marked resolved", resolved);

  // ── Test 3: AI ACCEPT + Endorsement REJECT → Rejected ──────────────────
  console.log("\n━━━ Test 3: AI ACCEPT + Endorsement REJECT → Rejected ━━━\n");
  const job3 = await createAndFundJob();

  await tx("registerEvaluation #3", () => clientW.writeContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "registerEvaluation", args: [job3, DELIVERABLE]
  }));

  await tx("deliverAIVerdict (ACCEPT)", () => clientW.writeContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "deliverAIVerdict",
    args: [job3, 1, reason1, "All criteria pass."]
  }));

  s = await getStatus(job3);
  check("After AI ACCEPT → still Submitted", s === 2, STATUSES[s]);

  await tx("deliverEndorsement (REJECT)", () => clientW.writeContract({
    address: NEW_EVAL, abi: evaluatorABI, functionName: "deliverEndorsement",
    args: [job3, 2, keccak256(toBytes("no davide comment")), "No positive comment from dcrapis found on Ethereum Magicians thread."]
  }));

  s = await getStatus(job3);
  check("AI ACCEPT + Endorsement REJECT → Rejected", s === 4, STATUSES[s]);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  console.log("\nDual-signal flows tested:");
  console.log("  ✅ AI ACCEPT + Endorsement ACCEPT → Completed (both required)");
  console.log("  ✅ AI REJECT → immediate Rejected (fail fast)");
  console.log("  ✅ AI ACCEPT + Endorsement REJECT → Rejected (endorsement gates completion)");

  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
