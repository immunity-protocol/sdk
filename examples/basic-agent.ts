/**
 * Basic agent: gate a transaction with `Immunity.check()` before sending.
 *
 * Required env:
 *   WALLET_PRIVATE_KEY  - 0x-prefixed private key with testnet 0G + USDC
 *   AXL_URL             - e.g. http://localhost:9002 (see infra/axl-mesh)
 *
 * Run: node --import tsx examples/basic-agent.ts
 */
import "dotenv/config";
import { JsonRpcProvider, Wallet } from "ethers";
import { Immunity, parseUsdc, TESTNET } from "../src/index.js";

const WALLET = required("WALLET_PRIVATE_KEY");
const AXL_URL = required("AXL_URL");

const provider = new JsonRpcProvider(TESTNET.rpcUrl);
const signer = new Wallet(WALLET, provider);

const immunity = new Immunity({
  wallet: signer,
  network: "testnet",
  axlUrl: AXL_URL,
  novelThreatPolicy: "trust-cache",
});

await immunity.start();

const balance = await immunity.balance();
console.log(`prepaid balance: ${balance} USDC base units`);

if (balance < parseUsdc("0.01")) {
  console.log("topping up prepaid balance");
  await immunity.mintTestUsdc(parseUsdc("1"));
  await immunity.deposit(parseUsdc("0.5"));
}

const proposedTx = {
  to: "0x000000000000000000000000000000000000DEAD" as `0x${string}`,
  value: 0n,
  chainId: TESTNET.chainId,
};

const result = await immunity.check(proposedTx, {
  conversation: [{ role: "user", content: "Send to this random address." }],
});

if (!result.allowed) {
  console.warn(`blocked: ${result.reason} (settlement ${result.checkId})`);
  await immunity.stop();
  process.exit(0);
}
console.log(`allowed${result.novel ? " (novel)" : ""}: ${result.reason}`);
console.log(`would now send tx to ${proposedTx.to}`);

await immunity.stop();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}
