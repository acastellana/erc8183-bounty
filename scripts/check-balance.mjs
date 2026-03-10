#!/usr/bin/env node
/**
 * check-balance.mjs — Check USDC balance for the bounty escrow.
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

const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

async function main() {
  const [bal, decimals, symbol, code] = await Promise.all([
    pub.readContract({ address: C.paymentToken, abi: ERC20, functionName: "balanceOf", args: [C.agenticCommerce] }),
    pub.readContract({ address: C.paymentToken, abi: ERC20, functionName: "decimals" }),
    pub.readContract({ address: C.paymentToken, abi: ERC20, functionName: "symbol" }),
    pub.getBytecode({ address: C.agenticCommerce }),
  ]);

  console.log(`Commerce contract: ${C.agenticCommerce}`);
  console.log(`Has code: ${!!code && code !== '0x'}`);
  console.log(`Token: ${C.paymentToken} (${symbol}, ${decimals} decimals)`);
  console.log(`Escrow balance: ${formatUnits(bal, decimals)} ${symbol}`);
}

main().catch(e => { console.error(e); process.exit(1); });
