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
  approve:      "0x095ea7b3",
  // Uniswap V2 router
  v2_swapExactTokensForTokens: "0x38ed1739",
  v2_swapExactETHForTokens:    "0x7ff36ab5",
  v2_swapExactTokensForETH:    "0x18cbafe5",
  // Uniswap V3 SwapRouter (legacy, with deadline)
  v3_exactInputSingleDeadline: "0x414bf389",
  v3_exactInputDeadline:       "0xc04b8d59",
  // Uniswap V3 SwapRouter02 (current, no deadline)
  v3_exactInputSingle:         "0x04e45aaf",
  v3_exactInput:               "0xb858183f",
} as const;

const ERC20_INTERFACE = new Interface([
  "function transfer(address to, uint256 value)",
  "function transferFrom(address from, address to, uint256 value)",
  "function approve(address spender, uint256 value)",
]);

const UNI_V2_INTERFACE = new Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const UNI_V3_02_INTERFACE = new Interface([
  // SwapRouter02 — no deadline in struct
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))",
]);

const UNI_V3_INTERFACE = new Interface([
  // SwapRouter — has deadline in struct
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum))",
]);

/** Extract the first (input) token from a packed Uniswap V3 path. */
function firstTokenInPath(path: string): Address {
  // path = 0x | tokenIn(20) | fee(3) | tokenMid(20) | fee(3) | tokenOut(20) | ...
  // 20 bytes = 40 hex chars after the 0x prefix.
  if (!path.startsWith("0x") || path.length < 42) {
    throw new Error("v3 path too short");
  }
  return `0x${path.slice(2, 42)}` as Address;
}

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
      const decoded = ERC20_INTERFACE.decodeFunctionData("transfer", data);
      return {
        tokenAddress: tx.to,
        tokenAmount:  BigInt(decoded[1]),
        originChainId: chainId,
      };
    }
    if (selector === SELECTORS.transferFrom) {
      const decoded = ERC20_INTERFACE.decodeFunctionData("transferFrom", data);
      return {
        tokenAddress: tx.to,
        tokenAmount:  BigInt(decoded[2]),
        originChainId: chainId,
      };
    }
    if (selector === SELECTORS.approve) {
      // amount may be MAX_UINT256 (unlimited approval) — that's valid data,
      // not a special case. Indexer can decide how to display it.
      const decoded = ERC20_INTERFACE.decodeFunctionData("approve", data);
      return {
        tokenAddress: tx.to,
        tokenAmount:  BigInt(decoded[1]),
        originChainId: chainId,
      };
    }

    // ---- Uniswap V2 router ----
    if (selector === SELECTORS.v2_swapExactTokensForTokens) {
      const decoded = UNI_V2_INTERFACE.decodeFunctionData("swapExactTokensForTokens", data);
      const path = decoded[2] as string[];
      return {
        tokenAddress: path[0] as Address,
        tokenAmount:  BigInt(decoded[0]),
        originChainId: chainId,
      };
    }
    if (selector === SELECTORS.v2_swapExactTokensForETH) {
      const decoded = UNI_V2_INTERFACE.decodeFunctionData("swapExactTokensForETH", data);
      const path = decoded[2] as string[];
      return {
        tokenAddress: path[0] as Address,
        tokenAmount:  BigInt(decoded[0]),
        originChainId: chainId,
      };
    }
    if (selector === SELECTORS.v2_swapExactETHForTokens) {
      // Native ETH → token. tokenAmount comes from msg.value.
      return {
        tokenAddress: ZERO_ADDRESS,
        tokenAmount:  tx.value ?? 0n,
        originChainId: chainId,
      };
    }

    // ---- Uniswap V3 SwapRouter02 (no deadline) ----
    if (selector === SELECTORS.v3_exactInputSingle) {
      const decoded = UNI_V3_02_INTERFACE.decodeFunctionData("exactInputSingle", data);
      const params = decoded[0]; // tuple
      return {
        tokenAddress: params[0] as Address,   // tokenIn
        tokenAmount:  BigInt(params[4]),       // amountIn
        originChainId: chainId,
      };
    }
    if (selector === SELECTORS.v3_exactInput) {
      const decoded = UNI_V3_02_INTERFACE.decodeFunctionData("exactInput", data);
      const params = decoded[0];
      return {
        tokenAddress: firstTokenInPath(params[0] as string),
        tokenAmount:  BigInt(params[2]),       // amountIn
        originChainId: chainId,
      };
    }

    // ---- Uniswap V3 SwapRouter (with deadline) ----
    if (selector === SELECTORS.v3_exactInputSingleDeadline) {
      const decoded = UNI_V3_INTERFACE.decodeFunctionData("exactInputSingle", data);
      const params = decoded[0];
      return {
        tokenAddress: params[0] as Address,
        tokenAmount:  BigInt(params[5]),       // amountIn (deadline at index 4)
        originChainId: chainId,
      };
    }
    if (selector === SELECTORS.v3_exactInputDeadline) {
      const decoded = UNI_V3_INTERFACE.decodeFunctionData("exactInput", data);
      const params = decoded[0];
      return {
        tokenAddress: firstTokenInPath(params[0] as string),
        tokenAmount:  BigInt(params[3]),       // amountIn (deadline at index 2)
        originChainId: chainId,
      };
    }
  } catch {
    // Malformed calldata for the selector → unrecognized.
  }

  return empty;
}
