/**
 * Operator escalation: hook a SUSPICIOUS verdict (or any future call) to
 * a manual approval flow. v1 demonstrates the wiring; the actual notify
 * call is mocked to a console prompt.
 *
 * Required env: WALLET_PRIVATE_KEY, AXL_URL.
 *
 * Run: node --import tsx examples/escalation.ts
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { JsonRpcProvider, Wallet } from "ethers";
import { Immunity, TESTNET } from "../src/index.js";

const WALLET = required("WALLET_PRIVATE_KEY");
const AXL_URL = required("AXL_URL");

const provider = new JsonRpcProvider(TESTNET.rpcUrl);
const signer = new Wallet(WALLET, provider);

async function notifyOperator(reason: string, confidence: number): Promise<boolean> {
  // In production this fires Slack / pager / signed approval. For the
  // example we ask on stdin so the demo flow is observable.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(
      `\nIMMUNITY ESCALATION: ${reason} (confidence ${confidence})\nallow? [y/N] `,
    );
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

const immunity = new Immunity({
  wallet: signer,
  network: "testnet",
  axlUrl: AXL_URL,
  // For the escalation demo we run trust-cache so unmatched novel calls
  // do not require TEE funding. To exercise the SUSPICIOUS path against
  // a real TEE, set "verify" and ensure the broker has 4+ 0G.
  novelThreatPolicy: "trust-cache",
  onEscalate: ({ reason, confidence }) => notifyOperator(reason, confidence),
  escalationTimeout: 120,
  onTimeout: "deny",
});

await immunity.start();

const result = await immunity.check(
  { to: "0x0000000000000000000000000000000000000123", chainId: TESTNET.chainId },
  { conversation: [{ role: "user", content: "user typing manually" }] },
);

console.log(`decision=${result.decision} reason=${result.reason}`);

await immunity.stop();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}
