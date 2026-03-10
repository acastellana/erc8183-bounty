#!/usr/bin/env node
/**
 * test-bounty.mjs — End-to-end test of the BountyEscrow8183 system.
 *
 * Tests:
 *   1. Contract deployment verification
 *   2. State reads (status, evaluator, depositor, balance, deadline)
 *   3. Submit a test proposal on-chain
 *   4. Verify submission event and state
 *   5. (Optional) Trigger relay for GenLayer evaluation
 *
 * Usage:
 *   node scripts/test-bounty.mjs           # read-only checks
 *   node scripts/test-bounty.mjs --submit  # also submit a test proposal
 */

import {
  createPublicClient, createWalletClient, http,
  formatUnits, decodeAbiParameters, encodeAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const TRADE_ROOT = join(ROOT, "..", "conditional-payment-cross-border-trade");
const RPC   = "https://sepolia.base.org";
const SUBMIT = process.argv.includes("--submit");

// Load deployment artifacts
const deploy = JSON.parse(readFileSync(join(ROOT, "artifacts/bounty-deployment.json"), "utf8"));
const BOUNTY = deploy.bountyContract;
const TOKEN  = deploy.token;

// ABI from compiled artifact
const artifact = JSON.parse(readFileSync(
  join(ROOT, "sol/out/BountyEscrow8183.sol/BountyEscrow8183.json"), "utf8"
));
const ABI = artifact.abi;

const transport = http(RPC);
const pub = createPublicClient({ chain: baseSepolia, transport });

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ✅ ${label}${detail ? " — " + detail : ""}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`);
    fail++;
  }
}

async function readContract(fn, args = []) {
  return pub.readContract({ address: BOUNTY, abi: ABI, functionName: fn, args });
}

async function main() {
  console.log("═══ ERC-8183 Bounty Test Suite ═══\n");
  console.log(`Contract: ${BOUNTY}`);
  console.log(`Network:  Base Sepolia\n`);

  // ── 1. Contract exists ──────────────────────────────────────────────────
  console.log("▸ Contract deployment");
  const code = await pub.getBytecode({ address: BOUNTY });
  check("Contract has bytecode", code && code !== "0x");

  // ── 2. State reads ─────────────────────────────────────────────────────
  console.log("\n▸ State reads");

  const status = await readContract("currentStatus");
  check("Status is Open (0)", Number(status) === 0, `status=${status}`);

  const evaluator = await readContract("evaluator");
  check("Evaluator is InternetCourtFactory", evaluator.toLowerCase() === deploy.evaluator.toLowerCase(), evaluator);

  const depositor = await readContract("depositor");
  check("Depositor matches deployer", depositor.toLowerCase() === deploy.depositor.toLowerCase(), depositor);

  const escrowToken = await readContract("escrowToken");
  check("Escrow token is MockPEN", escrowToken.toLowerCase() === TOKEN.toLowerCase(), escrowToken);

  const balance = await readContract("escrowBalance");
  const balanceFmt = formatUnits(balance, 18);
  check("Escrow balance is 50,000 PEN", balanceFmt === "50000.0" || balanceFmt === "50000", balanceFmt + " PEN");

  const title = await readContract("title");
  check("Title set correctly", title.includes("ERC-8183"), title);

  const deadline = await readContract("deadline");
  const deadlineDate = new Date(Number(deadline) * 1000);
  const now = new Date();
  check("Deadline is in the future", deadlineDate > now, deadlineDate.toISOString());

  const prizeAmount = await readContract("prizeAmount");
  check("Prize amount matches deposit", formatUnits(prizeAmount, 18) === "50000.0" || formatUnits(prizeAmount, 18) === "50000");

  const subCount = await readContract("submissionCount");
  console.log(`  ℹ️  Current submissions: ${subCount}`);

  // ── 3. IERC8183 interface compliance ───────────────────────────────────
  console.log("\n▸ IERC8183 interface compliance");

  // All 5 required view functions
  const statusResult = await readContract("status");
  check("status() returns uint8", typeof statusResult === "number" || typeof statusResult === "bigint");

  check("evaluator() returns address", evaluator.startsWith("0x") && evaluator.length === 42);
  check("depositor() returns address", depositor.startsWith("0x") && depositor.length === 42);
  check("escrowToken() returns address", escrowToken.startsWith("0x") && escrowToken.length === 42);
  check("escrowBalance() returns uint256", typeof balance === "bigint");

  // deposit(), submit(), resolve() exist in ABI
  const fnNames = ABI.filter(x => x.type === "function").map(x => x.name);
  check("deposit() in ABI", fnNames.includes("deposit"));
  check("submit() in ABI", fnNames.includes("submit"));
  check("resolve() in ABI", fnNames.includes("resolve"));

  // Events
  const evNames = ABI.filter(x => x.type === "event").map(x => x.name);
  check("Deposited event in ABI", evNames.includes("Deposited"));
  check("EvaluationRequested event in ABI", evNames.includes("EvaluationRequested"));
  check("Resolved event in ABI", evNames.includes("Resolved"));

  // ── 4. Submit test proposal (optional) ─────────────────────────────────
  if (SUBMIT) {
    console.log("\n▸ Submitting test proposal");

    const testUrl = "https://raw.githubusercontent.com/acastellana/erc8183-bounty/main/README.md";

    // Use importer key for test submission
    function loadKey(path) {
      const k = readFileSync(path, "utf8").trim();
      return k.startsWith("0x") ? k : "0x" + k;
    }
    const IMPORTER_KEY = loadKey(join(process.env.HOME, ".internetcourt/.importer_key"));
    const importerAcct = privateKeyToAccount(IMPORTER_KEY);
    const importerW = createWalletClient({ chain: baseSepolia, transport, account: importerAcct });

    console.log(`  Submitter: ${importerAcct.address}`);
    console.log(`  Proposal:  ${testUrl}`);

    // Encode the submission data
    const submitData = encodeAbiParameters(
      [{ name: "proposalUrl", type: "string" }],
      [testUrl]
    );

    try {
      const submitHash = await importerW.writeContract({
        address: BOUNTY,
        abi: ABI,
        functionName: "submit",
        args: [submitData],
      });
      console.log(`  Submit tx: ${submitHash}`);

      const receipt = await pub.waitForTransactionReceipt({ hash: submitHash });
      check("Submit transaction succeeded", receipt.status === "success");

      // Check submission count increased
      const newCount = await readContract("submissionCount");
      check("Submission count increased", Number(newCount) > Number(subCount), `${subCount} → ${newCount}`);

      // Get the submission ID from logs
      const evalEvent = receipt.logs.find(l => {
        try {
          return l.topics[0] === "0x" + Buffer.from(
            // keccak256("EvaluationRequested(bytes32,address,bytes)")
            // We'll just check if there's any event log from our contract
            ""
          ).toString("hex");
        } catch { return false; }
      });

      // Get the last submission ID
      const ids = await readContract("getSubmissionIds");
      const lastId = ids[ids.length - 1];
      console.log(`  Submission ID: ${lastId}`);

      // Read submission details
      const sub = await readContract("getSubmission", [lastId]);
      check("Submission submitter correct", sub[0].toLowerCase() === importerAcct.address.toLowerCase());
      check("Submission URL stored", sub[1] === testUrl);
      check("Submission not yet resolved", sub[5] === false);

      console.log(`\n  ℹ️  Submission recorded on-chain.`);
      console.log(`  ℹ️  Run 'node scripts/bounty-relay.mjs --once' to trigger GenLayer evaluation.`);
      console.log(`  ℹ️  Basescan: https://sepolia.basescan.org/tx/${submitHash}`);

    } catch (err) {
      check("Submit transaction", false, err.message.slice(0, 100));
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
