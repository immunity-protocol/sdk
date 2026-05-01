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
export {
  AntibodyTypeValue,
  SemanticFlavorValue,
  StatusValue,
  VerdictValue,
} from "./types/antibody.js";

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

export { extractFacts } from "./tx/extractFacts.js";
export type { TxFacts } from "./tx/extractFacts.js";

export type { TeeVerifyFn, TeeVerifyOutcome } from "./check-flow.js";
export { buildVerdictPrompt, distillBundle } from "./tee/prompt.js";
export { parseVerdict } from "./tee/parse.js";
export type { RawVerdict } from "./tee/parse.js";

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

export { createStorageClient } from "./storage/indexer.js";
export type { StorageClient, StorageClientOptions } from "./storage/indexer.js";
export { uploadPublicEnvelope, fetchPublicEnvelope } from "./storage/envelope.js";
export type { PublicEnvelopeV1, PublicMatcherSummary } from "./storage/envelope.js";
export { uploadEncryptedContext } from "./storage/upload.js";
export type { ContextUpload } from "./storage/upload.js";

export { computeKeccakId } from "./keccak/id.js";
export { hashAddressMatcher } from "./keccak/matchers/address.js";
export { hashBytecodeMatcher } from "./keccak/matchers/bytecode.js";
export { hashCallPatternMatcher } from "./keccak/matchers/call-pattern.js";
export { hashGraphMatcher, computeTaintSetId } from "./keccak/matchers/graph.js";
export { hashSemanticMatcher } from "./keccak/matchers/semantic.js";

export { parseUsdc, formatUsdc, USDC_DECIMALS } from "./util/usdc.js";
export { normalizeAddress, isAddress, chainAddressKey } from "./util/address.js";
