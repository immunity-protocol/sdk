// Public surface of @immunity-protocol/sdk.

export { Immunity } from "./immunity.js";

export { TESTNET, resolveNetwork } from "./network.js";

export type {
  Antibody,
  AntibodySeed,
  AntibodyType,
  AntibodyTypeCode,
  Address,
  Hex32,
  SemanticFlavor,
  Status,
  Verdict,
} from "./types/antibody.js";
export { AntibodyTypeValue, SemanticFlavorValue, StatusValue, VerdictValue } from "./types/antibody.js";

export type {
  CheckContext,
  ConversationTurn,
  Counterparty,
  ProposedTx,
  Source,
  ToolCall,
} from "./types/context.js";

export type {
  CheckOptions,
  CheckResult,
  Decision,
  DecisionSource,
  NovelThreatPolicy,
} from "./types/check.js";

export type {
  ConfidenceThresholds,
  EscalateHandler,
  EscalationContext,
  EscalationDecision,
  ImmunityConfig,
  NetworkConfig,
  NetworkPreset,
} from "./types/config.js";

export {
  AntibodyNotFoundError,
  BlockError,
  DuplicateAntibodyError,
  EscalationError,
  ImmunityError,
  InsufficientBalanceError,
  MissingConfigError,
  NetworkError,
  NotStartedError,
  StakeLockedError,
  TeeAttestationError,
  TeeResponseError,
} from "./types/errors.js";

export type { PublishInput, PublishResult } from "./settlement/publish.js";
export type { PublisherStats } from "./settlement/balance.js";
export type { SweepResult } from "./settlement/sweep.js";

export { computeKeccakId } from "./keccak/id.js";
export { hashAddressMatcher } from "./keccak/matchers/address.js";
export { hashBytecodeMatcher } from "./keccak/matchers/bytecode.js";
export { hashCallPatternMatcher } from "./keccak/matchers/call-pattern.js";
export { hashGraphMatcher, computeTaintSetId } from "./keccak/matchers/graph.js";
export { hashSemanticMatcher } from "./keccak/matchers/semantic.js";

export { parseUsdc, formatUsdc, USDC_DECIMALS } from "./util/usdc.js";
export { normalizeAddress, isAddress, chainAddressKey } from "./util/address.js";
