import {
  JsonRpcProvider,
  type Provider,
  type Signer,
  Wallet,
  isAddress,
} from "ethers";
import type { Address } from "../types/antibody.js";
import { MissingConfigError } from "../types/errors.js";
import { normalizeAddress } from "../util/address.js";

/**
 * Resolve the signer to a concrete `(signer, address, provider)` triple.
 *
 * Accepts: an unconnected Wallet, a connected Wallet, any ethers v6 Signer,
 * or a private-key string when paired with an `rpcUrl`. Returns the signer
 * already attached to a provider so subsequent `Contract` calls can read
 * and write.
 */
export interface ResolvedSigner {
  signer: Signer;
  address: Address;
  provider: Provider;
}

export async function resolveSigner(
  input: Signer | string,
  rpcUrl: string,
): Promise<ResolvedSigner> {
  if (typeof input === "string") {
    if (!input.startsWith("0x") || input.length !== 66) {
      throw new MissingConfigError("wallet", "private key must be 0x + 64 hex chars");
    }
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(input, provider);
    return { signer: wallet, address: normalizeAddress(wallet.address), provider };
  }
  let signer = input;
  let provider = signer.provider;
  if (!provider) {
    provider = new JsonRpcProvider(rpcUrl);
    signer = signer.connect(provider);
  }
  const addr = await signer.getAddress();
  if (!isAddress(addr)) {
    throw new MissingConfigError("wallet", `signer.getAddress() returned non-address: ${addr}`);
  }
  return { signer, address: normalizeAddress(addr), provider };
}
