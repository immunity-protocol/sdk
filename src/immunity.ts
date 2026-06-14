import type { Provider, Signer } from "ethers";
import { AntibodyCache } from "./cache/cache.js";
import { type CheckDeps, resolveCheckConfig, runCheck } from "./check/orchestrator.js";
import type { SettlementRegistry } from "./check/settle.js";
import type { NovelVerifier } from "./check/verifier.js";
import { type CoreContracts, coreContracts } from "./contracts.js";
import { AddressMatcher } from "./matchers/address.js";
import { BytecodeMatcher, type CodeFetcher } from "./matchers/bytecode.js";
import { CallPatternMatcher } from "./matchers/call-pattern.js";
import { GraphMatcher } from "./matchers/graph.js";
import { MatcherRegistry } from "./matchers/matcher.js";
import { SemanticMatcher } from "./matchers/semantic.js";
import { resolveNetwork } from "./network.js";
import {
  type ChallengeManagerLike,
  type Erc20Like,
  type RegistrarLike,
  type RegistryLike,
  type StoragePort,
  type WriteDeps,
  balanceOf,
  deposit,
  deregister,
  isRegistered,
  registerPublisher,
  challenge as runChallenge,
  corroborate as runCorroborate,
  mature as runMature,
  publish as runPublish,
  withdraw,
} from "./publish/operations.js";
import type { PublishInput, PublishResult } from "./publish/params.js";
import { EnforcementResolver } from "./registry/enforcement.js";
import type { RegistryReads } from "./registry/lookup.js";
import { NegativeMatcherCache } from "./registry/negative-cache.js";
import { StorageClient } from "./storage/client.js";
import {
  CreNovelVerifier,
  type Erc20Like as VerifierErc20Like,
  type NovelVerificationLike,
} from "./tee/cre-verifier.js";
import { type RawVerdict, asVerdictEnum } from "./tee/parse.js";
import { seedFromTx } from "./tee/seed-from-tx.js";
import type { Address } from "./types/antibody.js";
import type { CheckOptions, CheckResult } from "./types/check.js";
import type { ImmunityConfig, NetworkConfig } from "./types/config.js";
import type { CheckContext, ProposedTx } from "./types/context.js";
import { MissingConfigError, NotStartedError } from "./types/errors.js";
import { createLogger } from "./util/logger.js";
import { resolveSigner } from "./wallet/signer.js";

const log = createLogger("immunity");

/**
 * Top-level SDK facade. Construct once per agent process.
 *
 *   const im = new Immunity({ wallet, network: "base-sepolia" });
 *   await im.start();   // connects signer, binds the live Base contracts
 *
 * `start()` connects to the live Base network and binds the typed contracts;
 * the full behavioural surface — `check()`, `publish()`, `corroborate()`,
 * `registerPublisher()`, `deposit()` — is implemented on this facade.
 */
export class Immunity {
  readonly #config: ImmunityConfig;
  readonly #network: NetworkConfig;

  #wallet?: Address;
  #signer?: Signer;
  #provider?: Provider;
  #contracts?: CoreContracts;
  #resolver?: EnforcementResolver;
  #reads?: RegistryReads;
  #storage?: StorageClient;
  #verifier: NovelVerifier | undefined;
  #started = false;

  constructor(config: ImmunityConfig) {
    if (!config.wallet) {
      throw new MissingConfigError("wallet", "ethers v6 Signer or 0x-prefixed private key");
    }
    this.#config = config;
    this.#network = resolveNetwork(config.network);
  }

  /** The resolved network config (addresses, rpc, gateway). */
  get network(): NetworkConfig {
    return this.#network;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const resolved = await resolveSigner(this.#config.wallet, this.#network.rpcUrl);
    this.#wallet = resolved.address;
    this.#signer = resolved.signer;
    this.#provider = resolved.provider;
    this.#contracts = coreContracts(this.#network, resolved.signer);
    this.#storage = new StorageClient({
      storageGatewayUrl: this.#network.storageGatewayUrl,
      lighthouseGateway: this.#network.lighthouseGateway,
      signer: resolved.signer,
    });
    this.#buildCheckPipeline(resolved.provider);
    this.#started = true;
    log.info("started", {
      wallet: this.#wallet,
      chainId: this.#network.chainId,
      registry: this.#network.addresses.registry,
    });
  }

  /**
   * Build the read-side enforcement pipeline: a `RegistryReads` adapter over the
   * signer-bound registry, a provider-backed `CodeFetcher`, the cache + all five
   * matchers, and the `EnforcementResolver`. The Tier-3 verifier is taken from
   * config (optional; S6 supplies a concrete one).
   */
  #buildCheckPipeline(provider: Provider): void {
    // The signer-bound registry exposes the read view methods by name from its
    // ABI; `RegistryReads` is exactly that subset. Methods stay bound to the
    // contract instance, so the cast is safe at runtime.
    const reads = this.contracts.registry as unknown as RegistryReads;
    const codeFetcher: CodeFetcher = async (_chainId, address) =>
      (await provider.getCode(address)) as `0x${string}`;

    const chainId = this.#network.chainId;
    const cache = new AntibodyCache();
    const matchers = new MatcherRegistry();
    const all = [
      new AddressMatcher(chainId),
      new CallPatternMatcher(chainId),
      new GraphMatcher(chainId),
      new BytecodeMatcher(chainId, codeFetcher),
      new SemanticMatcher(),
    ];
    for (const m of all) {
      m.attach(cache);
      matchers.register(m);
    }

    this.#reads = reads;
    // An explicitly-injected verifier wins (tests / custom backends); otherwise
    // build the CRE on-chain-trigger verifier from the signer-bound contracts.
    // No signer ⇒ no contracts ⇒ no verifier ⇒ S5 fails closed on verify.
    this.#verifier = this.#config.verifier ?? this.#buildCreVerifier();
    this.#resolver = new EnforcementResolver({
      reads,
      matchers,
      cache,
      negativeCache: new NegativeMatcherCache(),
      codeFetcher,
      chainId,
      denyKeccakIds: this.#config.denyKeccakIds,
    });
  }

  /**
   * Construct the Tier-3 CRE verifier (Path B) from the signer-bound contracts.
   * Triggers CRE by an on-chain `requestVerification` tx (the agent's wallet
   * pays the fee) and awaits the DON-signed verdict. Returns undefined if the
   * signer/contracts/storage are not ready, so S5 fails closed on verify.
   */
  #buildCreVerifier(): NovelVerifier | undefined {
    if (!this.#contracts || !this.#wallet || !this.#storage) return undefined;
    const storage = this.#storage;
    const requester = this.#wallet;
    return new CreNovelVerifier({
      requester,
      contract: this.#contracts.novelVerification as unknown as NovelVerificationLike,
      contractAddress: this.#network.addresses.novelVerification,
      usdc: this.#contracts.usdc as unknown as VerifierErc20Like,
      oraclePublicKey: this.#network.creOraclePublicKey,
      upload: async ({ envelope, encryptedContext }) => {
        // The gateway pins the public envelope + encrypted context as separate
        // IPFS objects and returns both digests. Reuse the publish-evidence path.
        const res = await storage.putEvidence(
          envelope as unknown as Parameters<typeof storage.putEvidence>[0],
          encryptedContext,
        );
        if (!res.contextHash) {
          throw new Error("storage gateway did not pin the encrypted context");
        }
        return { evidenceCid: res.evidenceCid, contextHash: res.contextHash };
      },
    });
  }

  async stop(): Promise<void> {
    this.#started = false;
  }

  /** Connected wallet address. Throws if not started. */
  get wallet(): Address {
    if (!this.#wallet) throw new NotStartedError();
    return this.#wallet;
  }

  /** Live core contract bindings (read/write) to the deployed Base network. */
  get contracts(): CoreContracts {
    if (!this.#contracts) throw new NotStartedError();
    return this.#contracts;
  }

  /**
   * Screen a proposed action across Tier-1 (cache) + Tier-2 (registry), apply
   * the consumer policies, and settle the mandatory fee on-chain. The protective
   * decision is read-side (corroboration ≥ K OR isSeeded → hard-block) and
   * independent of settlement confirmation.
   */
  async check(
    tx: ProposedTx | null,
    context: CheckContext,
    options?: CheckOptions,
  ): Promise<CheckResult> {
    if (!this.#started || !this.#resolver || !this.#reads || !this.#contracts) {
      throw new NotStartedError();
    }
    const reads = this.#reads;
    const deps: CheckDeps = {
      resolver: this.#resolver,
      registry: this.#contracts.registry as unknown as SettlementRegistry,
      corroborationK: () => reads.corroborationK().then(Number),
      config: resolveCheckConfig(this.#config),
      verifier: this.#verifier,
      publishConfirmedThreat: (args) => this.#autoPublish(args),
    };
    return runCheck(deps, tx, context, options);
  }

  /**
   * The auto-publish seam target: write an antibody for a Tier-3-confirmed
   * threat. Only reached when `autoPublishConfirmedThreats` is on (the
   * orchestrator gates the flag). Skips (→ null) when not registered or the
   * balance can't cover the bond — so `check()` never sends a doomed publish.
   */
  async #autoPublish(args: {
    verdict: RawVerdict;
    tx: ProposedTx | null;
    context: CheckContext;
    mode: "verify" | "corroborate";
  }): Promise<PublishResult | null> {
    const deps = this.#writeDeps();
    if (!(await isRegistered(deps))) return null;
    // Enabling auto-publish opts into SEMANTIC auto-mint too: a CRE-confirmed
    // novel injection mints a marker-based SEMANTIC antibody (the marker is
    // validated by seedFromTx's guardrails before it is trusted).
    const seed = seedFromTx(args.verdict, args.tx, args.context, this.#network.chainId, true);
    if (!seed) return null;

    const target =
      seed.abType === "ADDRESS"
        ? seed.target
        : ("0x0000000000000000000000000000000000000000" as Address);
    const bond = await deps.registry.computeBond(args.verdict.severity, target);
    if ((await deps.registry.balances(deps.publisher)) < bond) return null;

    const input: PublishInput = {
      seed,
      verdict: asVerdictEnum(args.verdict) ?? "MALICIOUS",
      confidence: args.verdict.confidence,
      severity: args.verdict.severity,
      reasonSummary: args.verdict.reasoning,
      // Carry the CRE attestation (set by the CRE-backed verifier after it
      // verifies the DON signature binds this verdict) so a confirmed novel
      // threat mints an attested antibody. Absent for non-attested verifiers.
      ...(args.verdict.attestation ? { attestation: args.verdict.attestation } : {}),
    };
    return args.mode === "corroborate" ? runCorroborate(deps, input) : runPublish(deps, input);
  }

  /** Assemble the injected write-surface deps from the bound contracts + wallet. */
  #writeDeps(): WriteDeps {
    if (!this.#started || !this.#contracts || !this.#wallet || !this.#storage) {
      throw new NotStartedError();
    }
    return {
      publisher: this.#wallet,
      network: this.#network,
      registrar: this.#contracts.registrar as unknown as RegistrarLike,
      registry: this.#contracts.registry as unknown as RegistryLike,
      challengeManager: this.#contracts.challengeManager as unknown as ChallengeManagerLike,
      storage: this.#storage as StoragePort,
      usdc: this.#contracts.usdc as unknown as Erc20Like,
    };
  }

  /** Register the publisher's ENS identity, locking the registration bond. */
  async registerPublisher(label: string): Promise<{ txHash: string; bond: bigint }> {
    return registerPublisher(this.#writeDeps(), label);
  }

  /** Release the registration and refund the bond. */
  async deregister(): Promise<{ txHash: string }> {
    return deregister(this.#writeDeps());
  }

  /** Whether the connected wallet is a registered publisher. */
  async isRegistered(): Promise<boolean> {
    return isRegistered(this.#writeDeps());
  }

  /** Deposit USDC into the operator balance (funds check fees + publish bonds). */
  async deposit(amount: bigint): Promise<{ txHash: string }> {
    return deposit(this.#writeDeps(), amount);
  }

  /** Withdraw USDC from the operator balance back to the wallet. */
  async withdraw(amount: bigint): Promise<{ txHash: string }> {
    return withdraw(this.#writeDeps(), amount);
  }

  /** The operator's current deposited balance (USDC, 6dp). */
  async balanceOf(): Promise<bigint> {
    return balanceOf(this.#writeDeps());
  }

  /**
   * Publish an antibody: derive the matcher, upload evidence (ECIES-encrypting
   * the optional context) to the gateway, and lock the bond from the deposited
   * balance. Requires the publisher to be registered + the balance funded.
   */
  async publish(input: PublishInput): Promise<PublishResult> {
    return runPublish(this.#writeDeps(), input);
  }

  /**
   * Corroborate an existing matcher by publishing the same seed under this
   * wallet's identity — strengthens the signal toward maturation (corroboration
   * ≥ K). Distinct from the original (the on-chain id includes the publisher).
   */
  async corroborate(input: PublishInput): Promise<PublishResult> {
    return runCorroborate(this.#writeDeps(), input);
  }

  /** Challenge an antibody, posting the computed bond. Returns the bond staked. */
  async challenge(antibodyId: string): Promise<{ bond: bigint; txHash: string }> {
    return runChallenge(this.#writeDeps(), antibodyId);
  }

  /** Permissionless poke to promote a matured PROBATION antibody to ACTIVE. */
  async mature(antibodyId: string): Promise<{ txHash: string }> {
    return runMature(this.#writeDeps(), antibodyId);
  }
}
