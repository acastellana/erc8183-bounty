import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const deploy = JSON.parse(readFileSync(join(ROOT, "artifacts/bounty-deployment.json"), "utf8"));
const evaluatorABI = JSON.parse(readFileSync(join(ROOT, "sol/out/GenLayerEvaluator.sol/GenLayerEvaluator.json"), "utf8")).abi;

const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });

function loadKey(p) { const k = readFileSync(p, "utf8").trim(); return k.startsWith("0x") ? k : "0x" + k; }
const ownerAcct = privateKeyToAccount(loadKey(`${process.env.HOME}/.internetcourt/.exporter_key`));
const w = createWalletClient({ chain: baseSepolia, transport, account: ownerAcct });

// Relay wallet address
const RELAY_WALLET = "0x7b9797c4c2DA625b120A27AD2c07bECB7A0E30fa";

async function main() {
  const evalAddr = deploy.contracts.genLayerEvaluator;
  console.log(`Evaluator: ${evalAddr}`);
  console.log(`Setting courtRelay to: ${RELAY_WALLET}`);

  const hash = await w.writeContract({
    address: evalAddr,
    abi: evaluatorABI,
    functionName: "setCourtRelay",
    args: [RELAY_WALLET],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`✓ setCourtRelay tx: ${hash} (status: ${receipt.status})`);

  // Verify
  const relay = await pub.readContract({ address: evalAddr, abi: evaluatorABI, functionName: "courtRelay" });
  console.log(`Verified courtRelay: ${relay}`);
}

main().catch(e => { console.error(e); process.exit(1); });
