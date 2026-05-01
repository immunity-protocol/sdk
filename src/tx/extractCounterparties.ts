import { Interface } from "ethers";
import type { Address } from "../types/antibody.js";
import type { ProposedTx } from "../types/context.js";

/**
 * Pull every address out of common calldata shapes that an AddressMatcher
 * should care about.
 *
 * `extractFacts` already decodes the same calldata to surface
 * `(tokenAddress, tokenAmount)` for accounting; this function exists
 * because the AddressMatcher needs the *behavioural* counterparty (the
 * recipient of a transfer, the spender of an approve, the swap recipient,
 * the last hop in a v3 path) — which sits one level deeper than `tx.to`
 * for any tx routed through an ERC-20 token contract or a DEX router.
 *
 * Without this, every blocked-address antibody is dead weight against
 * normal agent activity: a malicious recipient in `transfer(bad, amount)`
 * has `tx.to` = the USDC contract, which the matcher rightly treats as
 * benign. Decoding the calldata is the entire point of "look at what the
 * agent is about to do, not just where the bytes are addressed."
 *
 * Returns `[]` for unknown selectors. Safe to call on any tx; never throws.
 */

const SELECTORS = {
  transfer:                          "0xa9059cbb",
  transferFrom:                      "0x23b872dd",
  approve:                           "0x095ea7b3",
  v2_swapExactTokensForTokens:       "0x38ed1739",
  v2_swapExactETHForTokens:          "0x7ff36ab5",
  v2_swapExactTokensForETH:          "0x18cbafe5",
  v3_exactInputSingleDeadline:       "0x414bf389",
  v3_exactInputDeadline:             "0xc04b8d59",
  v3_exactInputSingle:               "0x04e45aaf",
  v3_exactInput:                     "0xb858183f",
} as const;

const ERC20_IFACE = new Interface([
  "function transfer(address to, uint256 value)",
  "function transferFrom(address from, address to, uint256 value)",
  "function approve(address spender, uint256 value)",
]);

const UNI_V2_IFACE = new Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const UNI_V3_02_IFACE = new Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))",
]);

const UNI_V3_IFACE = new Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum))",
]);

function lower(a: unknown): Address {
  return String(a).toLowerCase() as Address;
}

function tokensFromV3Path(path: string): Address[] {
  // path = 0x | tokenIn(20) | fee(3) | token(20) | fee(3) | tokenOut(20) | ...
  if (!path?.startsWith("0x")) return [];
  const hex = path.slice(2);
  const out: Address[] = [];
  // First token at offset 0, then every (20+3) = 23 bytes (46 hex chars).
  for (let i = 0; i + 40 <= hex.length; i += 46) {
    out.push(lower(`0x${hex.slice(i, i + 40)}`));
  }
  return out;
}

export function extractCounterparties(tx: ProposedTx | null): Address[] {
  if (!tx) return [];
  const data = tx.data ?? "0x";
  if (data.length < 10) return [];
  const selector = data.slice(0, 10).toLowerCase();
  const out = new Set<Address>();
  try {
    if (selector === SELECTORS.transfer) {
      const d = ERC20_IFACE.decodeFunctionData("transfer", data);
      out.add(lower(d[0]));
    } else if (selector === SELECTORS.transferFrom) {
      const d = ERC20_IFACE.decodeFunctionData("transferFrom", data);
      out.add(lower(d[0])); // from
      out.add(lower(d[1])); // to
    } else if (selector === SELECTORS.approve) {
      const d = ERC20_IFACE.decodeFunctionData("approve", data);
      out.add(lower(d[0])); // spender
    } else if (selector === SELECTORS.v2_swapExactTokensForTokens) {
      const d = UNI_V2_IFACE.decodeFunctionData("swapExactTokensForTokens", data);
      const path = (d[2] as string[]) ?? [];
      for (const a of path) out.add(lower(a));
      out.add(lower(d[3])); // recipient
    } else if (selector === SELECTORS.v2_swapExactETHForTokens) {
      const d = UNI_V2_IFACE.decodeFunctionData("swapExactETHForTokens", data);
      const path = (d[1] as string[]) ?? [];
      for (const a of path) out.add(lower(a));
      out.add(lower(d[2])); // recipient
    } else if (selector === SELECTORS.v2_swapExactTokensForETH) {
      const d = UNI_V2_IFACE.decodeFunctionData("swapExactTokensForETH", data);
      const path = (d[2] as string[]) ?? [];
      for (const a of path) out.add(lower(a));
      out.add(lower(d[3])); // recipient
    } else if (selector === SELECTORS.v3_exactInputSingle) {
      const params = UNI_V3_02_IFACE.decodeFunctionData("exactInputSingle", data)[0];
      out.add(lower(params[0])); // tokenIn
      out.add(lower(params[1])); // tokenOut
      out.add(lower(params[3])); // recipient
    } else if (selector === SELECTORS.v3_exactInput) {
      const params = UNI_V3_02_IFACE.decodeFunctionData("exactInput", data)[0];
      for (const a of tokensFromV3Path(params[0] as string)) out.add(a);
      out.add(lower(params[1])); // recipient
    } else if (selector === SELECTORS.v3_exactInputSingleDeadline) {
      const params = UNI_V3_IFACE.decodeFunctionData("exactInputSingle", data)[0];
      out.add(lower(params[0]));
      out.add(lower(params[1]));
      out.add(lower(params[3])); // recipient (deadline at 4 here)
    } else if (selector === SELECTORS.v3_exactInputDeadline) {
      const params = UNI_V3_IFACE.decodeFunctionData("exactInput", data)[0];
      for (const a of tokensFromV3Path(params[0] as string)) out.add(a);
      out.add(lower(params[1])); // recipient (deadline at 2 here)
    }
  } catch {
    // Malformed for the selector — fall through with whatever we accumulated.
  }
  // Drop the zero address — the matcher should never match against 0x0.
  out.delete("0x0000000000000000000000000000000000000000" as Address);
  return [...out];
}
