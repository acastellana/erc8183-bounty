#!/usr/bin/env node
/**
 * bounty-relay.mjs — Bridge relay for ERC-8183 bounty (v2, dual-signal).
 *
 * Direction 1 — Base → GenLayer:
 *   Polls AgenticCommerce for JobSubmitted events.
 *   On each new submission:
 *     1. Reads proposal URL from CourtAwareHook
 *     2. Deploys ProposalEvaluator (Signal 1: AI jury) on GenLayer
 *     3. Deploys EndorsementVerifier (Signal 2: forum check) on GenLayer
 *     4. Waits for both to finalize
 *     5. Registers evaluation on GenLayerEvaluator
 *
 * Direction 2 — GenLayer → Base:
 *   Polls BridgeSender for pending messages.
 *   Relays via BridgeForwarder → LayerZero → Base Sepolia.
 *
 * Usage:
 *   node scripts/bounty-relay.mjs          # continuous (30s poll)
 *   node scripts/bounty-relay.mjs --once   # one-shot
 */

import { ethers } from "ethers";
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const TRADE = join(ROOT, "..", "conditional-payment-cross-border-trade");
const DATA  = join(ROOT, "artifacts", "relay-state");
const ONCE  = process.argv.includes("--once");

mkdirSync(DATA, { recursive: true });

// ── Config ────────────────────────────────────────────────────────────────────

function loadEnv() {
  for (const p of [join(ROOT, ".relay.env"), join(TRADE, ".relay.env")]) {
    if (existsSync(p)) {
      readFileSync(p, "utf8").split("\n").forEach(l => {
        const [k, ...v] = l.split("=");
        if (k && !process.env[k.trim()]) process.env[k.trim()] = v.join("=").trim();
      });
    }
  }
}
loadEnv();

const RELAY_KEY = process.env.RELAY_PRIVATE_KEY ||
  readFileSync(join(TRADE, "base-sepolia/.wallets/relayer.key"), "utf8").trim();
const BASE_RPC   = process.env.BASE_RPC_URL    || "https://sepolia.base.org";
const ZKSYNC_RPC = process.env.ZKSYNC_RPC_URL  || "https://sepolia.era.zksync.dev";
const GL_RPC     = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";

// Load deployment artifacts
const deploy = JSON.parse(readFileSync(join(ROOT, "artifacts/bounty-deployment.json"), "utf8"));
const C = deploy.contracts;

// Bridge contracts (shared with conditional-payment)
const BRIDGE_SENDER    = "0xC94bE65Baf99590B1523db557D157fabaD2DA729";
const BRIDGE_FORWARDER = "0x95c4E5b042d75528f7df355742e48B298028b3f2";
const LZ_DST_EID       = 40245;

// ── Providers ─────────────────────────────────────────────────────────────────

const baseProvider   = new ethers.JsonRpcProvider(BASE_RPC);
const zksyncProvider = new ethers.JsonRpcProvider(ZKSYNC_RPC);
const relayWallet    = new ethers.Wallet(RELAY_KEY.startsWith("0x") ? RELAY_KEY : "0x" + RELAY_KEY);
const baseSigner     = relayWallet.connect(baseProvider);
const zksyncSigner   = relayWallet.connect(zksyncProvider);

// GenLayer client
const glAccount = createAccount(RELAY_KEY.startsWith("0x") ? RELAY_KEY : "0x" + RELAY_KEY);
const glClient  = createClient({ chain: studionet, endpoint: GL_RPC, account: glAccount });

// ── ABIs ──────────────────────────────────────────────────────────────────────

const COMMERCE_ABI = [
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
  "function getJob(uint256 jobId) view returns (address,address,address,string,uint256,uint256,uint8,address,bytes32)",
];

const HOOK_ABI = [
  "function getProposal(uint256 jobId) view returns (string,string,uint256,bool)",
];

const EVALUATOR_ABI = [
  "function registerEvaluation(uint256 jobId, bytes32 deliverable)",
  "function deliverAIVerdict(uint256 jobId, uint8 verdict, bytes32 reason, string details)",
  "function deliverEndorsement(uint256 jobId, uint8 verdict, bytes32 reason, string details)",
  "function pendingSignals(uint256 jobId) view returns (bool,bool)",
  "function isFullyResolved(uint256 jobId) view returns (bool)",
];

const BRIDGE_FORWARDER_ABI = [
  "function quoteCallRemoteArbitrary(uint32 dstEid, bytes data, bytes options) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function callRemoteArbitrary(bytes32 txHash, uint32 dstEid, bytes data, bytes options) payable",
  "function isHashUsed(bytes32 txHash) view returns (bool)",
];

// ── State ─────────────────────────────────────────────────────────────────────

const PROCESSED_FILE = join(DATA, "processed-jobs.json");
const ORACLE_FILE    = join(DATA, "oracle-state.json");

function loadJson(p, d) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } }
function saveJson(p, d) { writeFileSync(p, JSON.stringify(d, null, 2)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── GenLayer JSON-RPC ─────────────────────────────────────────────────────────

let rpcId = 1;
async function glRpc(method, params) {
  const res = await fetch(GL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`GL ${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

async function deployGLContract(code, args) {
  const txHash = await glClient.deployContract({
    code,
    args,
    leaderOnly: false,
  });
  return txHash;
}

async function waitForFinalization(txHash, label, timeoutSec = 420) {
  const maxIter = Math.ceil(timeoutSec / 5);
  for (let i = 0; i < maxIter; i++) {
    await sleep(5000);
    try {
      const tx = await glClient.getTransaction({ hash: txHash });
      const status = tx?.statusName || tx?.status_name || "";
      if (status === "FINALIZED") {
        console.log(`  [${label}] ✅ Finalized`);
        return tx;
      }
      if (["CANCELED", "UNDETERMINED"].includes(status) ||
          (tx?.resultName && ["FAILURE", "DISAGREE"].includes(tx.resultName))) {
        console.error(`  [${label}] ❌ Failed: ${status} / ${tx?.resultName}`);
        return null;
      }
      if (i % 6 === 0) console.log(`  [${label}] ${i * 5}s — status: ${status}`);
    } catch (e) {
      if (i % 12 === 0) console.log(`  [${label}] ${i * 5}s — poll error: ${e.message}`);
    }
  }
  console.error(`  [${label}] ⏰ Timeout after ${timeoutSec}s`);
  return null;
}

// ── DIRECTION 1: Base → GenLayer ──────────────────────────────────────────────

async function pollSubmissions() {
  const processed = new Set(loadJson(PROCESSED_FILE, []));
  const currentBlock = await baseProvider.getBlockNumber();
  const lookback = Math.max(0, currentBlock - 5000);

  const commerce = new ethers.Contract(C.agenticCommerce, COMMERCE_ABI, baseProvider);
  const events = await commerce.queryFilter(commerce.filters.JobSubmitted(), lookback, currentBlock);

  for (const evt of events) {
    const jobId = evt.args[0];
    const provider = evt.args[1];
    const deliverable = evt.args[2];
    const key = `${jobId}-${evt.transactionHash}`;

    if (processed.has(key)) continue;

    console.log(`\n[BASE→GL] JobSubmitted`);
    console.log(`  jobId:       ${jobId}`);
    console.log(`  provider:    ${provider}`);
    console.log(`  deliverable: ${deliverable}`);

    // Skip already-resolved jobs
    try {
      const evaluator = new ethers.Contract(C.genLayerEvaluator, EVALUATOR_ABI, baseProvider);
      const resolved = await evaluator.isFullyResolved(jobId);
      if (resolved) {
        console.log(`  Already resolved, skipping`);
        processed.add(key);
        saveJson(PROCESSED_FILE, [...processed]);
        continue;
      }
    } catch {}

    try {
      await processSubmission(jobId, deliverable);
      processed.add(key);
      saveJson(PROCESSED_FILE, [...processed]);
    } catch (err) {
      console.error(`[BASE→GL] Error processing job ${jobId}:`, err.message);
    }
  }
}

async function processSubmission(jobId, deliverable) {
  // Get proposal URL from hook
  const hook = new ethers.Contract(C.courtAwareHook, HOOK_ABI, baseProvider);
  const [proposalUrl, proposalTitle] = await hook.getProposal(jobId);

  if (!proposalUrl) {
    console.error(`  No proposal URL found for job ${jobId}`);
    return;
  }
  console.log(`  proposalUrl: ${proposalUrl}`);
  console.log(`  title:       ${proposalTitle}`);

  // Register evaluation on-chain
  const evaluator = new ethers.Contract(C.genLayerEvaluator, EVALUATOR_ABI, baseSigner);
  const regTx = await evaluator.registerEvaluation(jobId, deliverable);
  await regTx.wait();
  console.log(`  Registered evaluation: ${regTx.hash}`);

  // Deploy Signal 1: ProposalEvaluator on GenLayer
  const evalSrc = readFileSync(join(ROOT, "contracts/ProposalEvaluator.py"), "utf8");
  console.log(`  Deploying ProposalEvaluator (Signal 1)...`);

  const evalTxHash = await deployGLContract(evalSrc, [
    jobId.toString(),          // job_id
    C.agenticCommerce,         // bounty_contract
    C.genLayerEvaluator,       // evaluator_contract
    proposalUrl,               // proposal_url
    "court-ext-v1",            // guideline_version
    BRIDGE_SENDER,             // bridge_sender
    LZ_DST_EID,                // target_chain_eid
    C.internetCourtFactory,    // target_contract
  ]);
  console.log(`  Signal 1 tx: ${evalTxHash}`);

  // Deploy Signal 2: EndorsementVerifier on GenLayer
  const endorseSrc = readFileSync(join(ROOT, "contracts/EndorsementVerifier.py"), "utf8");
  console.log(`  Deploying EndorsementVerifier (Signal 2)...`);

  const endorseTxHash = await deployGLContract(endorseSrc, [
    jobId.toString(),          // job_id
    proposalUrl,               // proposal_url
    C.genLayerEvaluator,       // evaluator_contract
    BRIDGE_SENDER,             // bridge_sender
    LZ_DST_EID,                // target_chain_eid
    C.internetCourtFactory,    // target_contract
  ]);
  console.log(`  Signal 2 tx: ${endorseTxHash}`);

  // Wait for both to finalize (in parallel)
  console.log(`  Waiting for AI jury + endorsement verification...`);
  const [evalResult, endorseResult] = await Promise.all([
    waitForFinalization(evalTxHash, "AI-Jury"),
    waitForFinalization(endorseTxHash, "Endorsement"),
  ]);

  // Save oracle state
  const state = loadJson(ORACLE_FILE, {});
  state[jobId.toString()] = {
    proposalUrl,
    proposalTitle,
    signal1: { txHash: evalTxHash, finalized: !!evalResult },
    signal2: { txHash: endorseTxHash, finalized: !!endorseResult },
    timestamp: Math.floor(Date.now() / 1000),
  };
  saveJson(ORACLE_FILE, state);

  console.log(`  Oracle contracts deployed. Bridge relay will deliver verdicts.`);
}

// ── DIRECTION 2: GenLayer → Base (via zkSync + LayerZero) ────────────────────

function encodeFnCall(fn, args) {
  return JSON.stringify({ fn, args });
}

async function relayVerdictsToBase() {
  console.log("\n[GL→BASE] Checking BridgeSender for pending messages...");

  let hashes;
  try {
    hashes = await glRpc("gen_call", [{
      to: BRIDGE_SENDER,
      data: encodeFnCall("get_message_hashes", []),
    }]);
  } catch (e) {
    console.log(`  Bridge query failed: ${e.message}`);
    return;
  }

  if (!hashes || !Array.isArray(hashes) || hashes.length === 0) {
    console.log("  No pending messages.");
    return;
  }

  console.log(`  ${hashes.length} pending message(s)`);

  const forwarder = new ethers.Contract(BRIDGE_FORWARDER, BRIDGE_FORWARDER_ABI, zksyncSigner);

  for (const msgHash of hashes) {
    try {
      const msg = await glRpc("gen_call", [{
        to: BRIDGE_SENDER,
        data: encodeFnCall("get_message", [msgHash]),
      }]);

      if (!msg) continue;

      const rawData = msg.data ?? msg[2] ?? null;
      if (!rawData) {
        console.log(`  [${msgHash.slice(0, 12)}…] Missing message payload`);
        continue;
      }

      const dataBytes = typeof rawData === "string"
        ? (rawData.startsWith("0x") ? rawData : ethers.hexlify(ethers.toUtf8Bytes(rawData)))
        : ethers.hexlify(rawData);

      const txHashBytes32 = ethers.keccak256(ethers.toUtf8Bytes(msgHash));

      const isUsed = await forwarder.isHashUsed(txHashBytes32);
      if (isUsed) {
        console.log(`  [${msgHash.slice(0, 12)}…] Already relayed`);
        try {
          await glRpc("gen_call", [{
            to: BRIDGE_SENDER,
            data: encodeFnCall("delete_message", [msgHash]),
          }]);
        } catch {}
        continue;
      }

      const options = "0x00030100110100000000000000000000000000030d40"; // 200k gas
      const [nativeFee] = await forwarder.quoteCallRemoteArbitrary(LZ_DST_EID, dataBytes, options);
      const feeWithBuffer = nativeFee * 12n / 10n;

      const bal = await zksyncProvider.getBalance(relayWallet.address);
      if (bal < feeWithBuffer) {
        console.error(`  Insufficient zkSync ETH: ${ethers.formatEther(bal)}`);
        continue;
      }

      console.log(`  [${msgHash.slice(0, 12)}…] Relaying (fee: ${ethers.formatEther(nativeFee)} ETH)...`);
      const tx = await forwarder.callRemoteArbitrary(
        txHashBytes32, LZ_DST_EID, dataBytes, options,
        { value: feeWithBuffer }
      );
      console.log(`  [${msgHash.slice(0, 12)}…] ✅ Sent: ${tx.hash}`);
      await tx.wait();

    } catch (err) {
      console.error(`  [${msgHash.slice(0, 12)}…] Failed: ${err.message}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runOnce() {
  console.log(`\n═══ Bounty Relay [${new Date().toISOString()}] ═══`);
  await pollSubmissions();
  await relayVerdictsToBase();
}

async function main() {
  console.log("═══ ERC-8183 Bounty Relay (v2 — Dual Signal) ═══");
  console.log(`AgenticCommerce: ${C.agenticCommerce}`);
  console.log(`GenLayerEvaluator: ${C.genLayerEvaluator}`);
  console.log(`CourtAwareHook: ${C.courtAwareHook}`);
  console.log(`Relay wallet: ${relayWallet.address}`);
  console.log(`Mode: ${ONCE ? "one-shot" : "continuous (30s)"}\n`);

  if (ONCE) {
    await runOnce();
    return;
  }

  while (true) {
    try { await runOnce(); }
    catch (err) { console.error(`[ERROR] ${err.message}`); }
    await sleep(30000);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
