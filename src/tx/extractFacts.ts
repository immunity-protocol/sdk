import { Interface } from "ethers";
import type { Address } from "../types/antibody.js";
import type { ProposedTx } from "../types/context.js";

/**
 * Observable transaction facts derived from a `ProposedTx`. The Registry
 * stores these on chain (via `check()` event) so the indexer can attach
 * a USD value off-chain via a paid price oracle.
 *
 * Operators do NOT supply these directly. They are extracted by the SDK
 * from the tx the operator just asked it to check.
 */
export interface TxFacts {
  /** ERC20 contract address being interacted with, or `0x0` for native token. */
  tokenAddress: Address;
  /** Amount in the token's native decimals. */
  tokenAmount: bigint;
  /** Chain id where the tx would have executed. 0 if unknown. */
  originChainId: number;
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const SELECTORS = {
  transfer:     "0xa9059cbb",
  transferFrom: "0x23b872dd",
} as const;

const ERC20_TRANSFER_INTERFACE = new Interface([
  "function transfer(address to, uint256 value)",
  "function transferFrom(address from, address to, uint256 value)",
]);

/**
 * Pure transaction-fact extractor. No network calls, no async work.
 *
 * Returns all-zero facts (`{ 0x0, 0n, 0 }`) for inputs the SDK doesn't
 * recognize — that is a normal state, not an error. The indexer treats
 * `tokenAmount === 0` as "no priceable value" and skips USD lookup.
 */
export function extractFacts(tx: ProposedTx | null): TxFacts {
  const empty: TxFacts = {
    tokenAddress: ZERO_ADDRESS,
    tokenAmount:  0n,
    originChainId: 0,
  };

  if (!tx) return empty;

  const chainId = tx.chainId ?? 0;
  const data = tx.data ?? "0x";
  const hasData = data.length >= 10;

  // Native transfer: value > 0 and no calldata. A payable function call
  // with both value AND data is NOT a native transfer — it falls through
  // to selector dispatch (e.g. swapExactETHForTokens).
  if (tx.value && tx.value > 0n && !hasData) {
    return {
      tokenAddress: ZERO_ADDRESS,
      tokenAmount:  tx.value,
      originChainId: chainId,
    };
  }

  if (!hasData) return empty;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    if (selector === SELECTORS.transfer) {
      const decoded = ERC20_TRANSFER_INTERFACE.decodeFunctionData("transfer", data);
      return {
        tokenAddress: tx.to,
        tokenAmount:  BigInt(decoded[1]),
        originChainId: chainId,
      };
    }
    if (selector === SELECTORS.transferFrom) {
      const decoded = ERC20_TRANSFER_INTERFACE.decodeFunctionData("transferFrom", data);
      return {
        tokenAddress: tx.to,
        tokenAmount:  BigInt(decoded[2]),
        originChainId: chainId,
      };
    }
  } catch {
    // Malformed calldata for the selector → unrecognized.
  }

  return empty;
}
