// Dumps the raw return value of broker.inference.verifyService for a
// configured 0G Compute provider. Useful for understanding what fields
// the SDK actually returns vs what the docs claim.
//
// Run: node --env-file=.env.local scripts/verify-service-raw.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";

const RPC = "https://evmrpc-testnet.0g.ai";
const PROVIDER = "0xa48f01287233509FD694a22Bf840225062E67836"; // Galileo qwen-2.5-7b
const PK = process.env.WALLET_PRIVATE_KEY;
if (!PK) throw new Error("WALLET_PRIVATE_KEY not set");

const provider = new JsonRpcProvider(RPC);
const signer = new Wallet(PK, provider);
console.log(`signer: ${signer.address}`);

const broker = await createZGComputeNetworkBroker(signer);

const dir = mkdtempSync(path.join(tmpdir(), "tee-raw-"));
console.log(`reportDir: ${dir}\n`);

const attestation = await broker.inference.verifyService(PROVIDER, dir, (step) => {
  // mute the chatty step callback; we want the final return value
});

console.log("=== verifyService raw return ===");
console.log(
  JSON.stringify(
    attestation,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);

console.log("\n=== top-level keys ===");
console.log(Object.keys(attestation));

console.log("\n=== signerVerification keys ===");
console.log(attestation?.signerVerification ? Object.keys(attestation.signerVerification) : null);

console.log("\n=== composeVerification keys ===");
console.log(attestation?.composeVerification ? Object.keys(attestation.composeVerification) : null);

rmSync(dir, { recursive: true, force: true });
