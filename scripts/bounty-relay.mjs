#!/usr/bin/env node
/**
 * bounty-relay.mjs
 *
 * Bridge relay for BountyEscrow8183 <-> GenLayer.
 *
 * Direction 1 — Base → GenLayer:
 *   Polls BountyEscrow8183 for EvaluationRequested events.
 *   On each new submission:
 *     1. Decodes the proposal URL from the event data
 *     2. Deploys ProposalEvaluator.py on GenLayer
 *     3. Waits for AI jury finalization
 *     4. Stores oracle metadata
 *
 * Direction 2 — GenLayer → Base (via zkSync + LayerZero):
 *   Polls BridgeSender on GenLayer for pending messages.
 *   For each message:
 *     1. Quotes fee on BridgeForwarder (zkSync Sepolia)
 *     2. Calls callRemoteArbitrary → LayerZero → BridgeReceiver on Base
 *     3. BridgeReceiver calls InternetCourtFactory → resolveFromCourt()
 *
 * Usage:
 *   node scripts/bounty-relay.mjs          # continuous polling
 *   node scripts/bounty-relay.mjs --once   # one-shot
 *
 * Env vars:
 *   RELAY_PRIVATE_KEY    Relayer wallet key
 *   BASE_RPC_URL         Base Sepolia RPC
 *   ZKSYNC_RPC_URL       zkSync Sepolia RPC
 *   GENLAYER_RPC_URL     GenLayer Studionet RPC
 */

import { ethers } from "ethers";
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, "..");
const TRADE_ROOT = join(ROOT, "..", "conditional-payment-cross-border-trade");
const DATA  = join(ROOT, "artifacts", "relay-state");
const ONCE  = process.argv.includes("--once");

// ── Config ────────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = join(ROOT, ".relay.env");
  if (existsSync(envPath)) {
    readFileSync(envPath, "utf8").split("\n").forEach(line => {
      const [k, ...v] = line.split("=");
      if (k && !process.env[k.trim()]) process.env[k.trim()] = v.join("=").trim();
    });
  }
}
loadEnv();

const RELAY_KEY    = process.env.RELAY_PRIVATE_KEY || readFileSync(join(TRADE_ROOT, "base-sepolia/.wallets/relayer.key"), "utf8").trim();
const BASE_RPC     = process.env.BASE_RPC_URL    || "https://sepolia.base.org";
const ZKSYNC_RPC   = process.env.ZKSYNC_RPC_URL  || "https://sepolia.era.zksync.dev";
const GL_RPC       = process.env.GENLAYER_RPC_URL || "https://studio.genlayer.com/api";

// Bounty contract
const BOUNTY_CONTRACT  = "0x0ee284054841fc6e60d2e2047e1e0f88ae02fe16";
const COURT_FACTORY    = "0xd533cB0B52E85b3F506b6f0c28b8f6bc4E449Dda";

// InternetCourt bridge contracts
const BRIDGE_SENDER    = "0xC94bE65Baf99590B1523db557D157fabaD2DA729"; // GenLayer
const BRIDGE_FORWARDER = "0x95c4E5b042d75528f7df355742e48B298028b3f2"; // zkSync Sepolia
const LZ_DST_EID       = 40245; // Base Sepolia

// ── Providers + clients ───────────────────────────────────────────────────────

const baseProvider   = new ethers.JsonRpcProvider(BASE_RPC);
const zksyncProvider = new ethers.JsonRpcProvider(ZKSYNC_RPC);
const relayWallet    = new ethers.Wallet(RELAY_KEY.startsWith("0x") ? RELAY_KEY : "0x" + RELAY_KEY);
const baseSigner     = relayWallet.connect(baseProvider);
const zksyncSigner   = relayWallet.connect(zksyncProvider);

const glAccount = createAccount(RELAY_KEY.startsWith("0x") ? RELAY_KEY : "0x" + RELAY_KEY);
const glClient  = createClient({ chain: studionet, endpoint: GL_RPC, account: glAccount });

// ── ABIs ──────────────────────────────────────────────────────────────────────

const BOUNTY_ABI = [
  "event EvaluationRequested(bytes32 indexed submissionId, address indexed submitter, bytes data)",
  "event SubmissionReceived(bytes32 indexed submissionId, address indexed submitter, string proposalUrl)",
  "function submissions(bytes32) view returns (address submitter, string proposalUrl, uint256 submittedAt, uint8 verdict, string verdictReason, bool resolved)",
  "function currentStatus() view returns (uint8)",
];

const BRIDGE_FORWARDER_ABI = [
  "function quoteCallRemoteArbitrary(uint32 dstEid, bytes data, bytes options) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function callRemoteArbitrary(bytes32 txHash, uint32 dstEid, bytes data, bytes options) payable",
  "function isHashUsed(bytes32 txHash) view returns (bool)",
];

// ── State persistence ─────────────────────────────────────────────────────────

mkdirSync(DATA, { recursive: true });
const PROCESSED_FILE = join(DATA, "processed-submissions.json");
const GL_META_FILE   = join(DATA, "genlayer-evaluations.json");

function loadJson(path, def) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return def; }
}
function saveJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ── GenLayer JSON-RPC ─────────────────────────────────────────────────────────

let rpcId = 1;
async function glJsonRpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ });
  const res = await fetch(GL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`GL RPC ${method}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── DIRECTION 1: Base → GenLayer ──────────────────────────────────────────────

async function pollSubmissions() {
  const processed = new Set(loadJson(PROCESSED_FILE, []));
  const currentBlock = await baseProvider.getBlockNumber();
  const lookback = Math.max(0, currentBlock - 5000);

  const contract = new ethers.Contract(BOUNTY_CONTRACT, BOUNTY_ABI, baseProvider);
  const filter = contract.filters.EvaluationRequested();
  const events = await contract.queryFilter(filter, lookback, currentBlock);

  for (const evt of events) {
    const submissionId = evt.args[0]; // bytes32
    const submitter    = evt.args[1]; // address
    const key = `${submissionId}-${evt.transactionHash}`;

    if (processed.has(key)) continue;

    // Decode proposal URL from the submission data
    const sub = await contract.submissions(submissionId);
    const proposalUrl = sub.proposalUrl;

    console.log(`\n[EVM→GL] EvaluationRequested`);
    console.log(`  submissionId: ${submissionId}`);
    console.log(`  submitter:    ${submitter}`);
    console.log(`  proposalUrl:  ${proposalUrl}`);

    try {
      await processSubmission(submissionId, proposalUrl);
      processed.add(key);
      saveJson(PROCESSED_FILE, [...processed]);
    } catch (err) {
      console.error(`[EVM→GL] Failed for ${submissionId}:`, err.message);
    }
  }
}

async function processSubmission(submissionId, proposalUrl) {
  // Read evaluator contract source
  const evalSrc = readFileSync(join(ROOT, "contracts/ProposalEvaluator.py"), "utf8");

  console.log(`[EVM→GL] Deploying ProposalEvaluator for submission ${submissionId}...`);

  // Deploy ProposalEvaluator on GenLayer
  const txHash = await glClient.deployContract({
    code: evalSrc,
    args: [
      submissionId,           // submission_id: str
      BOUNTY_CONTRACT,        // bounty_contract: str
      proposalUrl,            // proposal_url: str
      "bounty-proposal-v1",   // guideline_version: str
      BRIDGE_SENDER,          // bridge_sender: str
      LZ_DST_EID,             // target_chain_eid: int
      COURT_FACTORY,          // target_contract: str
    ],
    leaderOnly: false,
  });

  console.log(`[EVM→GL] Deploy tx: ${txHash}`);
  console.log(`[EVM→GL] Explorer: https://explorer-studio.genlayer.com/transactions/${txHash}`);
  console.log(`[EVM→GL] Waiting for AI jury consensus...`);

  // Wait for finalization (up to ~7 min)
  let oracleAddress = null;
  let verdict = "";
  let reason  = "";

  for (let i = 0; i < 80; i++) {
    await sleep(5000);
    try {
      const tx = await glClient.getTransaction({ hash: txHash });
      if (tx.statusName === "FINALIZED") {
        console.log(`[EVM→GL] ✅ Evaluation finalized`);
        const rec = await glJsonRpc("gen_getTransactionReceipt", [txHash]);
        oracleAddress = rec?.data?.contract_address || rec?.contract_address || null;
        if (oracleAddress) {
          try {
            const state = await glJsonRpc("gen_getContractState", [oracleAddress]);
            verdict = state?.verdict || "";
            reason  = state?.verdict_reason || "";
          } catch (e) {
            // Fallback: try sim_getTransactionsForAddress
            console.log(`[EVM→GL] State read failed (known GenVM issue), using tx data`);
          }
        }
        console.log(`[EVM→GL] Oracle: ${oracleAddress}`);
        console.log(`[EVM→GL] Verdict: ${verdict}`);
        console.log(`[EVM→GL] Reason: ${reason.slice(0, 200)}`);
        break;
      }
      if (["CANCELED", "UNDETERMINED"].includes(tx.statusName) ||
          ["FAILURE", "DISAGREE"].includes(tx.resultName)) {
        console.error(`[EVM→GL] Evaluation failed: status=${tx.statusName} result=${tx.resultName}`);
        throw new Error(`Evaluation failed: ${tx.statusName}`);
      }
      if (i % 6 === 0) process.stdout.write(`  [${i * 5}s] status=${tx.statusName}...\n`);
    } catch (e) {
      if (e.message?.includes("Evaluation failed")) throw e;
    }
  }

  // Save evaluation metadata
  const meta = loadJson(GL_META_FILE, {});
  meta[submissionId] = {
    oracleTxHash: txHash,
    oracleAddress,
    verdict,
    reason,
    proposalUrl,
    timestamp: Math.floor(Date.now() / 1000),
  };
  saveJson(GL_META_FILE, meta);
  console.log(`[EVM→GL] Saved evaluation metadata`);
}

// ── DIRECTION 2: GenLayer → Base ──────────────────────────────────────────────

async function relayVerdictsToBase() {
  console.log("\n[GL→EVM] Checking BridgeSender for pending messages...");

  let hashes;
  try {
    const result = await glJsonRpc("gen_call", [{
      to_address: BRIDGE_SENDER,
      function_name: "get_pending_hashes",
      function_args: [],
    }]);
    hashes = result;
  } catch (e) {
    // Fallback: try alternative method
    try {
      const result = await glJsonRpc("gen_call", [{
        to_address: BRIDGE_SENDER,
        function_name: "get_message_hashes",
        function_args: [],
      }]);
      hashes = result;
    } catch (e2) {
      console.log(`[GL→EVM] Bridge query failed: ${e2.message}`);
      return;
    }
  }

  if (!hashes || !Array.isArray(hashes) || hashes.length === 0) {
    console.log("[GL→EVM] No pending messages.");
    return;
  }

  console.log(`[GL→EVM] ${hashes.length} pending message(s) found.`);

  const forwarder = new ethers.Contract(BRIDGE_FORWARDER, BRIDGE_FORWARDER_ABI, zksyncSigner);

  for (const msgHash of hashes) {
    try {
      // Get message data from BridgeSender
      const msg = await glJsonRpc("gen_call", [{
        to_address: BRIDGE_SENDER,
        function_name: "get_message",
        function_args: [msgHash],
      }]);

      if (!msg) { console.log(`[GL→EVM] No data for hash ${msgHash}`); continue; }

      const targetChainId = msg.target_chain_id || msg[0];
      const targetContract = msg.target_contract || msg[1];
      const data = msg.data || msg[2];
      const dataBytes = typeof data === "string" ? data : ethers.hexlify(data);

      console.log(`[GL→EVM] Relaying message ${msgHash.slice(0, 16)}...`);

      // Check if already forwarded
      const txHashBytes = ethers.keccak256(ethers.toUtf8Bytes(msgHash));
      const used = await forwarder.isHashUsed(txHashBytes);
      if (used) {
        console.log(`[GL→EVM] Already relayed, deleting from GenLayer...`);
        await glJsonRpc("gen_call", [{
          to_address: BRIDGE_SENDER,
          function_name: "delete_message",
          function_args: [msgHash],
        }]);
        continue;
      }

      // Build LayerZero options (200k gas limit)
      const options = buildLzOptions(200000);

      // Quote fee
      const [nativeFee] = await forwarder.quoteCallRemoteArbitrary(LZ_DST_EID, dataBytes, options);
      console.log(`[GL→EVM] LZ fee: ${ethers.formatEther(nativeFee)} ETH`);

      // Send via forwarder
      const tx = await forwarder.callRemoteArbitrary(txHashBytes, LZ_DST_EID, dataBytes, options, {
        value: nativeFee * 12n / 10n, // 20% buffer
      });
      console.log(`[GL→EVM] Forwarder tx: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[GL→EVM] ✅ Relayed in block ${receipt.blockNumber}`);

      // Delete processed message from GenLayer
      try {
        await glClient.writeContract({
          address: BRIDGE_SENDER,
          functionName: "delete_message",
          args: [msgHash],
        });
      } catch (_) {}

    } catch (err) {
      console.error(`[GL→EVM] Failed to relay ${msgHash}: ${err.message}`);
    }
  }
}

function buildLzOptions(gasLimit) {
  // LayerZero V2 options: type 3, worker 1 (executor), option type 1 (gas), 16-byte gas limit
  const gas = BigInt(gasLimit);
  return ethers.concat([
    "0x0003",    // options type 3
    "0x01",      // worker id = 1 (executor)
    ethers.zeroPadValue(ethers.toBeHex(1 + 16), 2), // option length = 17
    "0x01",      // option type 1 (lzReceive gas)
    ethers.zeroPadValue(ethers.toBeHex(gas), 16),
  ]);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function runOnce() {
  console.log(`\n═══ Bounty Relay [${new Date().toISOString()}] ═══`);
  await pollSubmissions();
  await relayVerdictsToBase();
}

async function main() {
  console.log("═══ ERC-8183 Bounty Relay ═══");
  console.log(`Bounty contract: ${BOUNTY_CONTRACT}`);
  console.log(`Court factory:   ${COURT_FACTORY}`);
  console.log(`Bridge sender:   ${BRIDGE_SENDER}`);
  console.log(`Mode: ${ONCE ? "one-shot" : "continuous (30s interval)"}\n`);

  if (ONCE) {
    await runOnce();
    return;
  }

  while (true) {
    try {
      await runOnce();
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
    }
    await sleep(30000);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
