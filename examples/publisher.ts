/**
 * Heuristic publisher: mints an ADDRESS antibody for a known-bad address.
 *
 * Required env:
 *   WALLET_PRIVATE_KEY  - 0x-prefixed private key with testnet 0G + USDC
 *   AXL_URL             - e.g. http://localhost:9002
 *
 * Run: node --import tsx examples/publisher.ts
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
});

await immunity.start();

// Need 1 USDC to stake the antibody, plus enough for fees.
if ((await immunity.balance()) < parseUsdc("1.5")) {
  await immunity.mintTestUsdc(parseUsdc("3"));
  await immunity.deposit(parseUsdc("2"));
}

const target = "0x000000000000000000000000000000000000BAD1" as const;
console.log(`publishing ADDRESS antibody for ${target}`);

const result = await immunity.publish({
  seed: { abType: "ADDRESS", chainId: TESTNET.chainId, target },
  verdict: "MALICIOUS",
  confidence: 95,
  severity: 90,
});

console.log(`minted ${result.keccakId}`);
console.log(`immSeq ${result.immSeq}`);
console.log(`tx ${result.txHash}`);

const stats = await immunity.publisherStats();
console.log(`publisher stats: published=${stats.publishedCount} earned=${stats.totalEarned}`);

await immunity.stop();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}
