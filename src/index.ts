// Public surface of @immunity-protocol/sdk.

export { Immunity } from "./immunity.js";

export { BASE_SEPOLIA, BASE_MAINNET, resolveNetwork } from "./network.js";

export {
  registryContract,
  reputationContract,
  registrarContract,
  protectedSetContract,
  challengeManagerContract,
  creReceiverContract,
  usdcContract,
  coreContracts,
} from "./contracts.js";
export type { CoreContracts } from "./contracts.js";

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
  formatImmId,
} from "./types/antibody.js";

export type { EnforcementInputs } from "./types/enforcement.js";

export { isLiveAntibody } from "./types/antibody.js";

export {
  classifyEnforcement,
  EnforcementResolver,
} from "./registry/enforcement.js";
export type {
  EnforcementTier,
  EnforcementResolution,
} from "./registry/enforcement.js";
export { ReputationClient } from "./registry/reputation.js";
export type { PublisherReputation, ReputationReads } from "./registry/reputation.js";
export { Tier2Lookup } from "./registry/lookup.js";
export type { RegistryReads } from "./registry/lookup.js";
export { NegativeMatcherCache } from "./registry/negative-cache.js";
export { decodeAntibody, decodeEnforcementInputs } from "./registry/decode.js";

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

export type { NovelVerifier } from "./check/verifier.js";

export { buildVerdictPrompt, distillBundle } from "./tee/prompt.js";
export { parseVerdict } from "./tee/parse.js";
export type { RawVerdict } from "./tee/parse.js";

export type {
  ConfidenceThresholds,
  CoreAddresses,
  EscalateHandler,
  EscalationContext,
  EscalationDecision,
  ImmunityConfig,
  NetworkConfig,
  NetworkPreset,
  UnverifiedAntibodyPolicy,
} from "./types/config.js";

export {
  AlreadyRegisteredError,
  AntibodyNotFoundError,
  BlockError,
  DuplicateAntibodyError,
  EscalationError,
  ImmunityError,
  InsufficientBalanceError,
  MissingConfigError,
  NetworkError,
  NotRegisteredError,
  NotStartedError,
  StakeLockedError,
  TeeAttestationError,
  TeeResponseError,
} from "./types/errors.js";

export type { PublishInput, PublishParams, PublishResult } from "./publish/params.js";

export { uploadPublicEnvelope, fetchPublicEnvelope } from "./storage/envelope.js";
export type { PublicEnvelopeV1, PublicMatcherSummary } from "./storage/envelope.js";
export { StorageClient, canonicalJson } from "./storage/client.js";
export type {
  GatewayRequestV1,
  GatewayPayloadV1,
  GatewayResponseV1,
  PutEvidenceResult,
  StorageClientOptions,
} from "./storage/client.js";
export {
  encryptContext,
  decryptContext,
  getPublicKeyFromPrivate,
} from "./storage/crypto.js";
export type { EciesBundle } from "./storage/crypto.js";
export { cidToHex32, hex32ToCid } from "./storage/cid.js";

export { computeKeccakId } from "./keccak/id.js";
export { hashAddressMatcher } from "./keccak/matchers/address.js";
export { hashBytecodeMatcher } from "./keccak/matchers/bytecode.js";
export { hashCallPatternMatcher } from "./keccak/matchers/call-pattern.js";
export { hashGraphMatcher, computeTaintSetId } from "./keccak/matchers/graph.js";
export { hashSemanticMatcher } from "./keccak/matchers/semantic.js";

export { parseUsdc, formatUsdc, USDC_DECIMALS } from "./util/usdc.js";
export { normalizeAddress, isAddress, chainAddressKey } from "./util/address.js";
