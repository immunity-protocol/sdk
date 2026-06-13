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
import { EnforcementResolver } from "./registry/enforcement.js";
import type { RegistryReads } from "./registry/lookup.js";
import { NegativeMatcherCache } from "./registry/negative-cache.js";
import type { Address } from "./types/antibody.js";
import type { CheckOptions, CheckResult } from "./types/check.js";
import type { ImmunityConfig, NetworkConfig } from "./types/config.js";
import type { CheckContext, ProposedTx } from "./types/context.js";
import { MissingConfigError, NotStartedError } from "./types/errors.js";
import { createLogger } from "./util/logger.js";
import { resolveSigner } from "./wallet/signer.js";

const log = createLogger("immunity");
const NOT_IMPL = "not implemented in v1 yet";

/**
 * Top-level SDK facade. Construct once per agent process.
 *
 *   const im = new Immunity({ wallet, network: "base-sepolia" });
 *   await im.start();   // connects signer, binds the live Base contracts
 *
 * S0/S1 foundation: `start()` connects to the live Base network and exposes the
 * typed contract bindings via `contracts`. The behavioural surface
 * (`check()` / `publish()`) is rebuilt in later packages — see the TODOs.
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
    this.#verifier = this.#config.verifier;
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
    };
    return runCheck(deps, tx, context, options);
  }

  // TODO(write-package): rebuilt with Lighthouse evidence + bonded publish.
  async publish(): Promise<never> {
    throw new Error(`publish(): ${NOT_IMPL}`);
  }
}
