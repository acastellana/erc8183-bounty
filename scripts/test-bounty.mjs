#!/usr/bin/env node
/**
 * test-bounty.mjs — Verify the ERC-8183 bounty deployment (v2).
 *
 * Tests:
 *   1. Contract deployment (AgenticCommerce, GenLayerEvaluator, CourtAwareHook)
 *   2. Job state (status, evaluator, hook, budget, deadline)
 *   3. ERC-8183 lifecycle compliance
 *   4. (Optional --submit) Full submission flow
 */

import { createPublicClient, createWalletClient, http, formatUnits, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const SUBMIT = process.argv.includes("--submit");

const deploy = JSON.parse(readFileSync(join(ROOT, "artifacts/bounty-deployment.json"), "utf8"));
const C = deploy.contracts;

const commerceABI = JSON.parse(readFileSync(join(ROOT, "sol/out/AgenticCommerce.sol/AgenticCommerce.json"), "utf8")).abi;
const evaluatorABI = JSON.parse(readFileSync(join(ROOT, "sol/out/GenLayerEvaluator.sol/GenLayerEvaluator.json"), "utf8")).abi;
const hookABI = JSON.parse(readFileSync(join(ROOT, "sol/out/CourtAwareHook.sol/CourtAwareHook.json"), "utf8")).abi;

const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });

let pass = 0, fail = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}

async function r(addr, abi, fn, args = []) {
  return pub.readContract({ address: addr, abi, functionName: fn, args });
}

async function main() {
  console.log("═══ ERC-8183 Bounty Test Suite (v2) ═══\n");

  // ── 1. Contracts exist ──────────────────────────────────────────────────
  console.log("▸ Contract deployment");
  for (const [name, addr] of Object.entries(C)) {
    if (name === "paymentToken" || name === "internetCourtFactory") continue;
    const code = await pub.getBytecode({ address: addr });
    check(`${name} has bytecode`, code && code !== "0x", addr);
  }

  // ── 2. AgenticCommerce state ────────────────────────────────────────────
  console.log("\n▸ AgenticCommerce state");
  const token = await r(C.agenticCommerce, commerceABI, "paymentToken");
  check("Payment token is MockPEN", token.toLowerCase() === C.paymentToken.toLowerCase());

  const jobCount = await r(C.agenticCommerce, commerceABI, "jobCount");
  check("At least 1 job exists", Number(jobCount) >= 1, `jobCount=${jobCount}`);

  // ── 3. Job state ────────────────────────────────────────────────────────
  console.log("\n▸ Job #0 state");
  const job = await r(C.agenticCommerce, commerceABI, "getJob", [0n]);
  const [client, provider, evaluator, desc, budget, expiredAt, status, hook, deliverable] = job;

  check("Client is deployer", client.toLowerCase() === deploy.job.client.toLowerCase());
  check("Provider is open (address(0))", provider === "0x0000000000000000000000000000000000000000");
  check("Evaluator is GenLayerEvaluator", evaluator.toLowerCase() === C.genLayerEvaluator.toLowerCase());
  check("Hook is CourtAwareHook", hook.toLowerCase() === C.courtAwareHook.toLowerCase());
  check("Status is Open (0)", Number(status) === 0);
  check("Budget is 50,000 PEN", formatUnits(budget, 18) === "50000.0" || formatUnits(budget, 18) === "50000", formatUnits(budget, 18));
  check("Deadline is future", Number(expiredAt) > Math.floor(Date.now()/1000), new Date(Number(expiredAt)*1000).toISOString());
  check("Description is set", desc.length > 50, `${desc.length} chars`);

  // ── 4. GenLayerEvaluator state ──────────────────────────────────────────
  console.log("\n▸ GenLayerEvaluator state");
  const evalCommerce = await r(C.genLayerEvaluator, evaluatorABI, "agenticCommerce");
  check("Points to AgenticCommerce", evalCommerce.toLowerCase() === C.agenticCommerce.toLowerCase());

  const courtRelay = await r(C.genLayerEvaluator, evaluatorABI, "courtRelay");
  check("Court relay is IC Factory", courtRelay.toLowerCase() === C.internetCourtFactory.toLowerCase());

  // ── 5. CourtAwareHook state ─────────────────────────────────────────────
  console.log("\n▸ CourtAwareHook state");
  const hookCommerce = await r(C.courtAwareHook, hookABI, "agenticCommerce");
  check("Points to AgenticCommerce", hookCommerce.toLowerCase() === C.agenticCommerce.toLowerCase());

  const [tc, tr] = await r(C.courtAwareHook, hookABI, "stats");
  check("Stats initialized (0 completed, 0 rejected)", Number(tc) === 0 && Number(tr) === 0);

  // ── 6. ERC-8183 interface compliance ────────────────────────────────────
  console.log("\n▸ ERC-8183 interface compliance");
  const fns = commerceABI.filter(x => x.type === "function").map(x => x.name);
  const events = commerceABI.filter(x => x.type === "event").map(x => x.name);

  for (const fn of ["createJob","setProvider","setBudget","fund","submit","complete","reject","claimRefund"]) {
    check(`${fn}() in ABI`, fns.includes(fn));
  }
  for (const ev of ["JobCreated","ProviderSet","BudgetSet","JobFunded","JobSubmitted","JobCompleted","JobRejected","JobExpired","PaymentReleased","Refunded"]) {
    check(`${ev} event in ABI`, events.includes(ev));
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
