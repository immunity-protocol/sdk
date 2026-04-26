import type { Address, Hex32 } from "./antibody.js";

/**
 * The agent action being checked. May be a real EVM transaction or `null`
 * for non-blockchain actions (sending a message, scraping a page, etc.).
 *
 * The shape is intentionally loose: only `to` is required for an EVM
 * action. The SDK derives selectors and arg fingerprints from `data`.
 */
export interface ProposedTx {
  to: Address;
  value?: bigint;
  data?: `0x${string}`;
  chainId?: number;
}

export interface ConversationTurn {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface ToolCall {
  tool: string;
  args: unknown;
  outputHash?: Hex32;
}

export interface Source {
  url: string;
  contentHash?: Hex32;
  extractedText?: string;
}

export interface Counterparty {
  id: string;
  ens?: string;
}

/**
 * Distillable context the SDK uses to (a) match locally and (b) hand to
 * the TEE if all matchers miss. Every field is optional: callers pass
 * what they have. The SDK derives matcher inputs from this.
 */
export interface CheckContext {
  conversation?: ConversationTurn[];
  toolTrace?: ToolCall[];
  sources?: Source[];
  counterparty?: Counterparty;
  metadata?: Record<string, unknown>;
}
