import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const deploy = JSON.parse(readFileSync(join(ROOT, "artifacts/bounty-deployment.json"), "utf8"));
const artifact = JSON.parse(readFileSync(join(ROOT, "sol/out/BountyEscrow8183.sol/BountyEscrow8183.json"), "utf8"));

const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const BOUNTY = deploy.bountyContract;
const ABI = artifact.abi;

async function main() {
  console.log("Checking submission state...\n");
  
  const count = await pub.readContract({ address: BOUNTY, abi: ABI, functionName: "submissionCount" });
  console.log(`Submission count: ${count}`);

  const status = await pub.readContract({ address: BOUNTY, abi: ABI, functionName: "currentStatus" });
  console.log(`Bounty status: ${status}`);

  const balance = await pub.readContract({ address: BOUNTY, abi: ABI, functionName: "escrowBalance" });
  console.log(`Escrow balance: ${formatUnits(balance, 18)} PEN`);

  if (Number(count) > 0) {
    const ids = await pub.readContract({ address: BOUNTY, abi: ABI, functionName: "getSubmissionIds" });
    console.log(`\nSubmission IDs:`);
    for (const id of ids) {
      const sub = await pub.readContract({ address: BOUNTY, abi: ABI, functionName: "getSubmission", args: [id] });
      console.log(`  ${id}`);
      console.log(`    Submitter: ${sub[0]}`);
      console.log(`    URL: ${sub[1]}`);
      console.log(`    Submitted: ${new Date(Number(sub[2]) * 1000).toISOString()}`);
      console.log(`    Verdict: ${sub[3]} (0=pending, 1=accept, 2=reject)`);
      console.log(`    Resolved: ${sub[5]}`);
    }
  }

  // Check tx receipt for events
  const txHash = "0x02b16a6822cb888569a994a2a4a8fb511963ebe9b476713a1d0d453ced2323ca";
  const receipt = await pub.getTransactionReceipt({ hash: txHash });
  console.log(`\nSubmit tx logs: ${receipt.logs.length}`);
  console.log(`Tx status: ${receipt.status}`);
  for (const log of receipt.logs) {
    console.log(`  Log from ${log.address}, topics: ${log.topics.length}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
