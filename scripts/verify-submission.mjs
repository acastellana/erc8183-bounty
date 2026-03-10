#!/usr/bin/env node
/**
 * verify-submission.mjs — Check submission state for an ERC-8183 job.
 */
import { createPublicClient, http, formatUnits, parseAbi } from "viem";
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

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const STATUSES = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const JOB_ID = BigInt(process.argv[2] || "0");

async function main() {
  console.log(`═══ Job #${JOB_ID} State ═══\n`);

  const job = await pub.readContract({ address: C.agenticCommerce, abi: commerceABI, functionName: "getJob", args: [JOB_ID] });
  const [client, provider, evaluator, desc, budget, expiredAt, status, hook, deliverable] = job;

  console.log(`Status:      ${STATUSES[Number(status)]}`);
  console.log(`Client:      ${client}`);
  console.log(`Provider:    ${provider === "0x0000000000000000000000000000000000000000" ? "(open)" : provider}`);
  console.log(`Evaluator:   ${evaluator}`);
  console.log(`Hook:        ${hook}`);
  console.log(`Budget:      ${formatUnits(budget, 6)} USDC`);
  console.log(`Deadline:    ${new Date(Number(expiredAt) * 1000).toISOString()}`);
  console.log(`Deliverable: ${deliverable}`);
  console.log(`Description: ${desc.slice(0, 100)}${desc.length > 100 ? "…" : ""}`);

  // Escrow balance
  const escrow = await pub.readContract({ address: C.paymentToken, abi: ERC20, functionName: "balanceOf", args: [C.agenticCommerce] });
  console.log(`\nEscrow:      ${formatUnits(escrow, 6)} USDC`);

  // Evaluator state
  try {
    const evalState = await pub.readContract({ address: C.genLayerEvaluator, abi: evaluatorABI, functionName: "getEvaluation", args: [JOB_ID] });
    console.log(`\nEvaluator verdict: ${["NONE","ACCEPT","REJECT"][Number(evalState[0])]}`);
    console.log(`Evaluator delivered: ${evalState[3]}`);
  } catch {}

  // Hook state
  try {
    const proposal = await pub.readContract({ address: C.courtAwareHook, abi: hookABI, functionName: "getProposal", args: [JOB_ID] });
    console.log(`\nProposal URL: ${proposal[0] || "(none)"}`);
    console.log(`Proposal registered: ${proposal[3]}`);
  } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
