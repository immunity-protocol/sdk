import { JsonRpcProvider, Wallet } from "ethers";
import { Immunity, formatUsdc, parseUsdc, TESTNET } from "../src/index.js";

const provider = new JsonRpcProvider(TESTNET.rpcUrl);
const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);
const immunity = new Immunity({
  wallet,
  network: "testnet",
  axlUrl: process.env.AXL_URL!,
  novelThreatPolicy: "trust-cache",
});
await immunity.start();
const before = await immunity.balance();
console.log("balance:", formatUsdc(before), "USDC");
const stats = await immunity.publisherStats();
console.log("stats:", {
  staked: formatUsdc(stats.totalStaked),
  earned: formatUsdc(stats.totalEarned),
  published: stats.publishedCount.toString(),
});
if (before < parseUsdc("4")) {
  console.log("topping up to ~4 USDC...");
  await immunity.mintTestUsdc(parseUsdc("10"));
  await immunity.deposit(parseUsdc("5"));
  console.log("balance after:", formatUsdc(await immunity.balance()), "USDC");
}
await immunity.stop();
