import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const RPC = "https://sepolia.base.org";
const transport = http(RPC);
const pub = createPublicClient({ chain: baseSepolia, transport });

async function main() {
  const bounty = "0x0ee284054841fc6e60d2e2047e1e0f88ae02fe16";
  const pen = "0x08bc87f6511913caa4e127c5e4e91618a37a9719";

  // ERC-20 balance
  const [tokenBal, escrowCode] = await Promise.all([
    pub.readContract({
      address: pen,
      abi: [
        {"type":"function","name":"balanceOf","inputs":[{"name":"account","type":"address","internalType":"address"}],"outputs":[{"name":"balance","type":"uint256","internalType":"uint256"}],"stateMutability":"view"}
      ],
      functionName: "balanceOf",
      args: [bounty],
    }),
    pub.getBytecode({ address: bounty }),
  ]);

  console.log("Bounty contract:", bounty);
  console.log("Has code:", !!escrowCode && escrowCode !== '0x');
  console.log("PEN balance:", tokenBal.toString());
}

main().catch(e => { console.error(e); process.exit(1); });
