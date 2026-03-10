#!/usr/bin/env node
/**
 * test-lifecycle.mjs — Full ERC-8183 lifecycle test on Base Sepolia.
 *
 * Creates a NEW job (so we don't burn the real bounty job #0),
 * then runs the entire lifecycle: setProvider → fund → registerProposal → submit.
 *
 * Uses:
 *   - Exporter wallet as client
 *   - Importer wallet as provider (test submitter)
 *   - GenLayerEvaluator as evaluator
 *   - CourtAwareHook as hook
 */

import {
  createPublicClient, createWalletClient, http,
  parseUnits, parseAbi, formatUnits, keccak256, toBytes, decodeEventLog, toHex,
  encodePacked, stringToHex
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
const hookABI = JSON.parse(readFileSync(join(ROOT, "sol/out/CourtAwareHook.sol/CourtAwareHook.json"), "utf8")).abi;
const evaluatorABI = JSON.parse(readFileSync(join(ROOT, "sol/out/GenLayerEvaluator.sol/GenLayerEvaluator.json"), "utf8")).abi;

const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
]);

const RPC = "https://sepolia.base.org";
const transport = http(RPC);
const pub = createPublicClient({ chain: baseSepolia, transport });

function loadKey(p) { const k = readFileSync(p, "utf8").trim(); return k.startsWith("0x") ? k : "0x" + k; }
const clientKey = loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`);
const providerKey = loadKey(`${process.env.HOME}/.internetcourt/.importer_key`);

const clientAcct = privateKeyToAccount(clientKey);
const providerAcct = privateKeyToAccount(providerKey);

const clientW = createWalletClient({ chain: baseSepolia, transport, account: clientAcct });
const providerW = createWalletClient({ chain: baseSepolia, transport, account: providerAcct });

const STATUSES = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const TEST_PRIZE = parseUnits("100", 6); // 100 USDC for test
const TEST_URL = "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md";
const DELIVERABLE = keccak256(toBytes(TEST_URL));

let pass = 0, fail = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function step(label, fn) {
  process.stdout.write(`\n▸ ${label}... `);
  const hash = await fn();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const ok = receipt.status === "success";
  console.log(ok ? `✓` : `✗`);
  console.log(`  tx: ${hash}`);
  console.log(`  gas: ${receipt.gasUsed.toLocaleString()}`);
  check(`${label} succeeded`, ok);
  await sleep(2500); // nonce cooldown
  return { hash, receipt };
}

async function getJobStatus(jobId) {
  const job = await pub.readContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "getJob", args: [jobId] });
  return { client: job[0], provider: job[1], evaluator: job[2], description: job[3], budget: job[4], expiredAt: job[5], status: Number(job[6]), hook: job[7], deliverable: job[8] };
}

async function main() {
  console.log("═══ ERC-8183 Full Lifecycle Test ═══");
  console.log(`Client:   ${clientAcct.address}`);
  console.log(`Provider: ${providerAcct.address}`);
  console.log(`Commerce: ${C.agenticCommerce}`);
  console.log(`Evaluator: ${C.genLayerEvaluator}`);
  console.log(`Hook:     ${C.courtAwareHook}`);

  // ── Step 1: Create a test job ───────────────────────────────────────────
  const deadline = Math.floor(Date.now() / 1000) + 7200; // 2 hours
  let jobId;

  const { receipt: createReceipt } = await step("createJob (Open)", () =>
    clientW.writeContract({
      address: C.agenticCommerce, abi: commerceABI,
      functionName: "createJob",
      args: [
        "0x0000000000000000000000000000000000000000", // provider = open
        C.genLayerEvaluator,
        BigInt(deadline),
        "Test job: lifecycle validation on Base Sepolia",
        C.courtAwareHook,
      ],
    })
  );

  // Extract jobId from event
  for (const log of createReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: commerceABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "JobCreated") {
        jobId = decoded.args.jobId;
        console.log(`  jobId: ${jobId}`);
      }
    } catch {}
  }
  check("Got jobId from event", jobId !== undefined);

  let job = await getJobStatus(jobId);
  check("Status is Open", job.status === 0, STATUSES[job.status]);
  check("Provider is address(0)", job.provider === "0x0000000000000000000000000000000000000000");

  // ── Step 2: Set budget ──────────────────────────────────────────────────
  await step("setBudget (100 USDC)", () =>
    clientW.writeContract({
      address: C.agenticCommerce, abi: commerceABI,
      functionName: "setBudget",
      args: [jobId, TEST_PRIZE, "0x"],
    })
  );

  job = await getJobStatus(jobId);
  check("Budget set to 100 USDC", formatUnits(job.budget, 6) === "100");

  // ── Step 3: Set provider ────────────────────────────────────────────────
  await step("setProvider (assign importer as provider)", () =>
    clientW.writeContract({
      address: C.agenticCommerce, abi: commerceABI,
      functionName: "setProvider",
      args: [jobId, providerAcct.address, "0x"],
    })
  );

  job = await getJobStatus(jobId);
  check("Provider set", job.provider.toLowerCase() === providerAcct.address.toLowerCase());
  check("Still Open", job.status === 0, STATUSES[job.status]);

  // ── Step 4: Mint + Approve + Fund ───────────────────────────────────────
  await step("Mint 100 USDC for client", () =>
    clientW.writeContract({
      address: C.paymentToken, abi: ERC20,
      functionName: "mint",
      args: [clientAcct.address, TEST_PRIZE],
    })
  );

  await step("Approve AgenticCommerce to spend USDC", () =>
    clientW.writeContract({
      address: C.paymentToken, abi: ERC20,
      functionName: "approve",
      args: [C.agenticCommerce, TEST_PRIZE],
    })
  );

  await step("fund (Open → Funded)", () =>
    clientW.writeContract({
      address: C.agenticCommerce, abi: commerceABI,
      functionName: "fund",
      args: [jobId, TEST_PRIZE, "0x"],
    })
  );

  job = await getJobStatus(jobId);
  check("Status is Funded", job.status === 1, STATUSES[job.status]);

  // Verify escrow: token balance of commerce contract
  const escrowBal = await pub.readContract({
    address: C.paymentToken, abi: ERC20,
    functionName: "balanceOf", args: [C.agenticCommerce],
  });
  check("Tokens in escrow", escrowBal >= TEST_PRIZE, `${formatUnits(escrowBal, 6)} USDC`);

  // ── Step 5: Register proposal on hook ───────────────────────────────────
  await step("registerProposal on CourtAwareHook (provider)", () =>
    providerW.writeContract({
      address: C.courtAwareHook, abi: hookABI,
      functionName: "registerProposal",
      args: [jobId, TEST_URL, "Test Proposal: ERC-8183 Lifecycle Validation"],
    })
  );

  // Verify hook state
  const proposal = await pub.readContract({
    address: C.courtAwareHook, abi: hookABI,
    functionName: "getProposal", args: [jobId],
  });
  check("Proposal URL stored", proposal[0] === TEST_URL);
  check("Proposal registered", proposal[3] === true);

  // ── Step 6: Submit deliverable (Funded → Submitted) ─────────────────────
  const { receipt: submitReceipt } = await step("submit deliverable (Funded → Submitted)", () =>
    providerW.writeContract({
      address: C.agenticCommerce, abi: commerceABI,
      functionName: "submit",
      args: [jobId, DELIVERABLE, "0x"],
    })
  );

  job = await getJobStatus(jobId);
  check("Status is Submitted", job.status === 2, STATUSES[job.status]);
  check("Deliverable stored", job.deliverable === DELIVERABLE);

  // Check for JobSubmitted event
  let hasSubmitEvent = false;
  for (const log of submitReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: commerceABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "JobSubmitted") {
        hasSubmitEvent = true;
        console.log(`  JobSubmitted event: provider=${decoded.args.provider}, deliverable=${decoded.args.deliverable.slice(0, 18)}…`);
      }
    } catch {}
  }
  check("JobSubmitted event emitted", hasSubmitEvent);

  // ── Step 7: Simulate evaluator verdict (complete) ───────────────────────
  // The GenLayerEvaluator.deliverVerdict() can only be called by courtRelay or owner.
  // Owner is the deployer (clientAcct). Let's test the full verdict delivery.

  const reason = keccak256(toBytes("Test verdict: all criteria pass"));

  await step("deliverVerdict → complete (Submitted → Completed)", () =>
    clientW.writeContract({
      address: C.genLayerEvaluator, abi: evaluatorABI,
      functionName: "registerEvaluation",
      args: [jobId, DELIVERABLE],
    })
  );

  await step("deliverVerdict ACCEPT (evaluator → complete())", () =>
    clientW.writeContract({
      address: C.genLayerEvaluator, abi: evaluatorABI,
      functionName: "deliverVerdict",
      args: [jobId, 1, reason, "All five criteria met. Strong design memo with clear hook architecture."],  // 1 = ACCEPT
    })
  );

  job = await getJobStatus(jobId);
  check("Status is Completed", job.status === 3, STATUSES[job.status]);

  // Check provider received payment
  const providerBal = await pub.readContract({
    address: C.paymentToken, abi: ERC20,
    functionName: "balanceOf", args: [providerAcct.address],
  });
  check("Provider received payment", providerBal >= TEST_PRIZE, `${formatUnits(providerBal, 6)} USDC`);

  // Check hook tracked the outcome
  const outcome = await pub.readContract({
    address: C.courtAwareHook, abi: hookABI,
    functionName: "getOutcome", args: [jobId],
  });
  check("Hook recorded completion", outcome[0] === true); // completed = true
  check("Hook recorded reason", outcome[1] === reason);

  const [tc, tr] = await pub.readContract({
    address: C.courtAwareHook, abi: hookABI,
    functionName: "stats",
  });
  check("Hook stats: 1 completed", Number(tc) >= 1);

  // Check evaluator state
  const evalState = await pub.readContract({
    address: C.genLayerEvaluator, abi: evaluatorABI,
    functionName: "getEvaluation", args: [jobId],
  });
  check("Evaluator recorded verdict=1 (ACCEPT)", Number(evalState[0]) === 1);
  check("Evaluator marked delivered", evalState[3] === true);

  // ── Step 8: Test rejection flow (new job) ───────────────────────────────
  console.log("\n═══ Testing REJECT flow ═══");

  const deadline2 = Math.floor(Date.now() / 1000) + 7200;
  let jobId2;

  const { receipt: cr2 } = await step("createJob #2 for reject test", () =>
    clientW.writeContract({
      address: C.agenticCommerce, abi: commerceABI,
      functionName: "createJob",
      args: ["0x0000000000000000000000000000000000000000", C.genLayerEvaluator, BigInt(deadline2), "Test job: reject flow", C.courtAwareHook],
    })
  );
  for (const log of cr2.logs) {
    try {
      const d = decodeEventLog({ abi: commerceABI, data: log.data, topics: log.topics });
      if (d.eventName === "JobCreated") jobId2 = d.args.jobId;
    } catch {}
  }
  console.log(`  jobId2: ${jobId2}`);

  await step("setBudget #2", () =>
    clientW.writeContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "setBudget", args: [jobId2, TEST_PRIZE, "0x"] })
  );
  await step("setProvider #2", () =>
    clientW.writeContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "setProvider", args: [jobId2, providerAcct.address, "0x"] })
  );
  await step("Mint + approve #2", async () => {
    const h1 = await clientW.writeContract({ address: C.paymentToken, abi: ERC20, functionName: "mint", args: [clientAcct.address, TEST_PRIZE] });
    await pub.waitForTransactionReceipt({ hash: h1 });
    await sleep(2000);
    return clientW.writeContract({ address: C.paymentToken, abi: ERC20, functionName: "approve", args: [C.agenticCommerce, TEST_PRIZE] });
  });
  await step("fund #2", () =>
    clientW.writeContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "fund", args: [jobId2, TEST_PRIZE, "0x"] })
  );
  await step("registerProposal #2", () =>
    providerW.writeContract({ address: C.courtAwareHook, abi: hookABI, functionName: "registerProposal", args: [jobId2, TEST_URL, "Test Reject Proposal"] })
  );
  await step("submit #2", () =>
    providerW.writeContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "submit", args: [jobId2, DELIVERABLE, "0x"] })
  );

  const rejectReason = keccak256(toBytes("Missing architecture diagram"));

  await step("registerEvaluation #2", () =>
    clientW.writeContract({ address: C.genLayerEvaluator, abi: evaluatorABI, functionName: "registerEvaluation", args: [jobId2, DELIVERABLE] })
  );
  await step("deliverVerdict REJECT #2", () =>
    clientW.writeContract({
      address: C.genLayerEvaluator, abi: evaluatorABI,
      functionName: "deliverVerdict",
      args: [jobId2, 2, rejectReason, "Missing architecture diagram. Design memo is solid but no visual overview provided."],
    })
  );

  const job2 = await getJobStatus(jobId2);
  check("Job #2 status is Rejected", job2.status === 4, STATUSES[job2.status]);

  // Check client got refund
  const clientBal = await pub.readContract({
    address: C.paymentToken, abi: ERC20,
    functionName: "balanceOf", args: [clientAcct.address],
  });
  check("Client received refund", clientBal >= TEST_PRIZE, `${formatUnits(clientBal, 6)} USDC`);

  // Hook stats
  const [tc2, tr2] = await pub.readContract({ address: C.courtAwareHook, abi: hookABI, functionName: "stats" });
  check("Hook stats: 1+ rejected", Number(tr2) >= 1);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  console.log(`\nLifecycle flows tested:`);
  console.log(`  ✅ ACCEPT: createJob → setBudget → setProvider → fund → registerProposal → submit → deliverVerdict(ACCEPT) → complete → payment released`);
  console.log(`  ✅ REJECT: createJob → ... → submit → deliverVerdict(REJECT) → reject → refund to client`);

  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
