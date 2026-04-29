import { generateKeyPairSync } from "node:crypto";
import { Gossip, type GossipOptions, parseKeyPairFromPem } from "axl-pubsub";
import type { Signer } from "ethers";
import { bootstrapCacheFromRegistry } from "./cache/bootstrap.js";
import { AntibodyCache } from "./cache/cache.js";
import { type TeeVerifyOutcome, runCheck } from "./check-flow.js";
import { GossipPublisher } from "./gossip/publisher.js";
import { GossipSubscriber } from "./gossip/subscriber.js";
import { AddressMatcher } from "./matchers/address.js";
import { BytecodeMatcher, type CodeFetcher } from "./matchers/bytecode.js";
import { CallPatternMatcher } from "./matchers/call-pattern.js";
import { GraphMatcher } from "./matchers/graph.js";
import { MatcherRegistry } from "./matchers/matcher.js";
import { SemanticMatcher } from "./matchers/semantic.js";
import { TESTNET, resolveNetwork } from "./network.js";
import { NegativeMatcherCache } from "./registry/negative-cache.js";
import { Tier2LookupClient } from "./registry/lookup.js";
import {
  type PublisherStats,
  balanceOf as balanceOfRegistry,
  publisherStats as publisherStatsRegistry,
} from "./settlement/balance.js";
import {
  type ApproveMode,
  deposit as depositToRegistry,
  withdraw as withdrawFromRegistry,
} from "./settlement/deposit.js";
import { mintTestUsdc as mintTestUsdcImpl } from "./settlement/mint-test-usdc.js";
import {
  type PublishInput,
  type PublishResult,
  publish as publishAntibody,
} from "./settlement/publish.js";
import { getAntibody as getAntibodyById, getAntibodyByImmSeq } from "./settlement/read-antibody.js";
import { type RegistryClient, createRegistryClient } from "./settlement/registry-client.js";
import { type SweepResult, sweepExpired } from "./settlement/sweep.js";
import { type UsdcClient, createUsdcClient } from "./settlement/usdc-client.js";
import { type StorageClient, createStorageClient } from "./storage/indexer.js";
import type { Antibody, Hex32 } from "./types/antibody.js";
import type { Address } from "./types/antibody.js";
import type { CheckOptions, CheckResult } from "./types/check.js";
import type { ImmunityConfig, NetworkConfig } from "./types/config.js";
import type { CheckContext, ProposedTx } from "./types/context.js";
import { MissingConfigError, NotStartedError } from "./types/errors.js";
import { createLogger } from "./util/logger.js";
import { resolveSigner } from "./wallet/signer.js";

const log = createLogger("immunity");

const ZERO_BYTES32: Hex32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

function synthAntibodyForPublish(
  result: PublishResult,
  publisher: Address,
  input: PublishInput,
): Antibody {
  const flavor = result.params.flavor;
  return {
    keccakId: result.keccakId,
    immSeq: result.immSeq,
    immId: `IMM-${new Date().getUTCFullYear()}-${String(result.immSeq).padStart(4, "0")}`,
    abType: input.seed.abType,
    flavor,
    verdict: input.verdict,
    status: "ACTIVE",
    confidence: input.confidence,
    severity: input.severity,
    primaryMatcherHash: result.params.primaryMatcherHash,
    evidenceCid: result.evidenceCid,
    contextHash: result.contextHash ?? ZERO_BYTES32,
    embeddingHash: input.embeddingHash ?? ZERO_BYTES32,
    attestation: input.attestation ?? ZERO_BYTES32,
    publisher,
    reviewer: input.reviewer ?? publisher,
    stakeAmount: 1_000_000n,
    stakeLockUntil: 0n,
    expiresAt: input.expiresAt ?? 0n,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
    isSeeded: false,
    seed: input.seed,
  };
}

/**
 * Top-level SDK facade. Construct once per agent process.
 *
 * Lifecycle:
 *   const im = new Immunity({...});
 *   await im.start();   // connects signer, attaches matchers, opens gossip
 *   const r = await im.check(tx, ctx);
 *   await im.stop();
 */
export class Immunity {
  readonly #config: ImmunityConfig;
  readonly #network: NetworkConfig;

  #wallet?: Address;
  #signer?: Signer;
  #registry?: RegistryClient;
  #usdc?: UsdcClient;
  #cache?: AntibodyCache;
  #matchers?: MatcherRegistry;
  #gossip?: Gossip;
  #subscriber?: GossipSubscriber;
  #publisher?: GossipPublisher;
  #lookup?: Tier2LookupClient;
  #storage?: StorageClient;
  #teeVerifierPromise?: Promise<
    ((tx: ProposedTx | null, ctx: CheckContext) => Promise<TeeVerifyOutcome | null>) | null
  >;
  #started = false;

  constructor(config: ImmunityConfig) {
    if (!config.axlUrl) {
      throw new MissingConfigError(
        "axlUrl",
        "see infra/axl-mesh/README.md for a 2-node compose template",
      );
    }
    if (!config.wallet) {
      throw new MissingConfigError("wallet", "ethers v6 Signer or 0x-prefixed private key");
    }
    this.#config = config;
    this.#network = resolveNetwork(config.network);
  }

  async start(): Promise<void> {
    if (this.#started) return;

    const resolved = await resolveSigner(this.#config.wallet, this.#network.rpcUrl);
    this.#wallet = resolved.address;
    this.#signer = resolved.signer;
    this.#registry = createRegistryClient(this.#network.registryAddress, resolved.signer);
    this.#usdc = createUsdcClient(this.#network.usdcAddress, resolved.signer);

    this.#cache = new AntibodyCache();
    this.#matchers = new MatcherRegistry();
    const codeFetcher: CodeFetcher = async (_chain, addr) => {
      const code = await resolved.provider.getCode(addr);
      return code as `0x${string}`;
    };
    const ms: ReadonlyArray<{ attach: (c: AntibodyCache) => void } & object> = [
      new AddressMatcher(this.#network.chainId),
      new CallPatternMatcher(this.#network.chainId),
      new GraphMatcher(this.#network.chainId),
      new BytecodeMatcher(this.#network.chainId, codeFetcher),
      new SemanticMatcher(),
    ];
    for (const m of ms) {
      m.attach(this.#cache);
      // biome-ignore lint/suspicious/noExplicitAny: m is structurally a Matcher
      this.#matchers.register(m as any);
    }

    const gossipOpts: GossipOptions = { axlUrl: this.#config.axlUrl };
    if (this.#config.axlIdentityPath) {
      gossipOpts.privateKeyPath = this.#config.axlIdentityPath;
    } else {
      log.warn(
        "axlIdentityPath not configured; generating ephemeral keypair (peer id will not persist across restarts)",
      );
      const { privateKey } = generateKeyPairSync("ed25519");
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      gossipOpts.keyPair = await parseKeyPairFromPem(pem);
    }
    const negativeCache = new NegativeMatcherCache();
    this.#lookup = new Tier2LookupClient(this.#registry, this.#network.chainId, negativeCache);

    this.#gossip = new Gossip(gossipOpts);
    await this.#gossip.start();
    this.#subscriber = new GossipSubscriber(this.#gossip, this.#cache, negativeCache);
    await this.#subscriber.start();
    this.#publisher = new GossipPublisher(this.#gossip);

    // Hydrate the local cache from the on-chain Registry so late joiners
    // (anyone who wasn't subscribed when the catalog was originally
    // gossipped) see existing antibodies before their first check(). The
    // gossip subscriber is already running, so any concurrent live
    // publishes are absorbed in parallel; cache.put() is idempotent so
    // overlap between bootstrap and a fresh gossip notify on the same
    // antibody is harmless.
    if (this.#config.bootstrapCacheOnStart !== false) {
      try {
        await bootstrapCacheFromRegistry(this.#registry, this.#cache, this.#config.bootstrap);
      } catch (err) {
        log.warn("cache bootstrap failed; continuing without prefetch", { err: String(err) });
      }
    }

    this.#started = true;
    log.info("started", {
      wallet: this.#wallet,
      registry: this.#network.registryAddress,
      chainId: this.#network.chainId,
      cache_size: this.#cache.size(),
    });

    // Lazy-init the TEE verifier in the background. start() returns fast;
    // the first novel-threat check pays the broker-handshake latency.
    if ((this.#config.novelThreatPolicy ?? "verify") === "verify") {
      this.#teeVerifierPromise = this.#initTeeVerifier();
    }
  }

  async #initTeeVerifier(): Promise<
    ((tx: ProposedTx | null, ctx: CheckContext) => Promise<TeeVerifyOutcome | null>) | null
  > {
    if (!this.#signer) return null;
    const computeProvider = this.#network.computeProvider ?? TESTNET.computeProvider;
    const storageIndexerUrl = this.#network.storageIndexerUrl ?? TESTNET.storageIndexerUrl;
    if (!computeProvider || !storageIndexerUrl) {
      log.warn(
        "novelThreatPolicy=verify but network preset has no computeProvider/storageIndexerUrl; falling back to trust-cache",
      );
      return null;
    }
    try {
      // Lazy import: pulls in @0glabs/0g-serving-broker only when a caller
      // actually requests TEE-backed novel-threat verification. Keeps the
      // SDK light for publishers and trust-cache callers (the broker's
      // ESM bundle has historically tripped tsx's loader on cold start).
      const { createTeeVerifier } = await import("./tee/verifier.js");
      return await createTeeVerifier({
        signer: this.#signer,
        rpcUrl: this.#network.rpcUrl,
        storageIndexerUrl,
        preferredProvider: computeProvider,
        blockThreshold: this.#config.confidenceThresholds?.block ?? 85,
        escalateThreshold: this.#config.confidenceThresholds?.escalate ?? 60,
        defaultChainId: this.#network.chainId,
        semanticAutoMint: this.#config.semanticAutoMint ?? false,
        ...(this.#config.minLedgerOg !== undefined ? { minLedgerOg: this.#config.minLedgerOg } : {}),
        ...(this.#config.minProviderOg !== undefined ? { minProviderOg: this.#config.minProviderOg } : {}),
      });
    } catch (err) {
      log.warn(
        "TEE verifier init failed; novel-threat path falls back to trust-cache for this session",
        err,
      );
      return null;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    try {
      if (this.#subscriber) await this.#subscriber.stop();
    } finally {
      if (this.#gossip) await this.#gossip.stop();
      this.#started = false;
    }
  }

  async check(
    tx: ProposedTx | null,
    context: CheckContext,
    options?: CheckOptions,
  ): Promise<CheckResult> {
    const s = this.ensureStarted();
    const teeVerify = this.#teeVerifierPromise ? await this.#teeVerifierPromise : null;
    return runCheck(tx, context, options, {
      wallet: s.wallet,
      registry: s.registry,
      storage: this.#getStorage(s.signer),
      cache: s.cache,
      matchers: s.matchers,
      publisher: s.publisher,
      lookup: s.lookup,
      defaultChainId: s.network.chainId,
      policy: this.#config.novelThreatPolicy ?? "verify",
      ...(this.#config.onEscalate ? { onEscalate: this.#config.onEscalate } : {}),
      ...(teeVerify ? { teeVerify } : {}),
    });
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = this.ensureStarted();
    const storage = this.#getStorage(s.signer);
    const result = await publishAntibody(s.registry, storage, s.wallet, input, s.lookup);
    // Mint side-effect: gossip the antibody and prime the local cache so
    // peers learn about it without waiting for an on-chain event scan and
    // future check() calls on the same publisher hit cache directly.
    const minted = synthAntibodyForPublish(result, s.wallet, input);
    s.cache.put(minted);
    s.publisher
      .announce(minted)
      .catch((err) =>
        log.warn("gossip announce failed; on-chain publish is still authoritative", err),
      );
    return result;
  }

  /**
   * Lazy 0G Storage client. Built on first `publish()` call so callers that
   * never publish do not pay the indexer connection cost.
   */
  #getStorage(signer: Signer): StorageClient {
    if (this.#storage) return this.#storage;
    const indexerUrl = this.#network.storageIndexerUrl ?? TESTNET.storageIndexerUrl;
    if (!indexerUrl) {
      throw new MissingConfigError(
        "network.storageIndexerUrl",
        "publish() needs a 0G Storage indexer URL to upload the envelope",
      );
    }
    this.#storage = createStorageClient({
      indexerUrl,
      rpcUrl: this.#network.rpcUrl,
      signer,
    });
    return this.#storage;
  }

  async deposit(
    amount: bigint,
    approveMode: ApproveMode = "exact",
  ): Promise<{ depositTx: Hex32; approveTx?: Hex32 }> {
    const s = this.ensureStarted();
    return depositToRegistry(s.registry, s.usdc, s.wallet, amount, approveMode);
  }

  async withdraw(amount: bigint): Promise<Hex32> {
    const s = this.ensureStarted();
    return withdrawFromRegistry(s.registry, amount);
  }

  async balance(): Promise<bigint> {
    const s = this.ensureStarted();
    return balanceOfRegistry(s.registry, s.wallet);
  }

  /**
   * Bring up the 0G Compute broker for this wallet and ensure the ledger
   * + provider sub-account hold the requested 0G floor. Idempotent: a
   * second call after a successful first does nothing on chain.
   *
   * Useful for callers who want to pre-fund ledgers from operator code
   * (e.g. an agent's boot sequence) rather than waiting for the lazy
   * TEE init triggered by the first novel-threat check. Honors
   * `ImmunityConfig.minLedgerOg` / `minProviderOg` when explicit args
   * are not supplied.
   */
  async ensureTeeFunded(opts?: {
    minLedgerOg?: number;
    minProviderOg?: number;
  }): Promise<{ ledgerOg: number; providerOg: number }> {
    const s = this.ensureStarted();
    const minLedger = opts?.minLedgerOg ?? this.#config.minLedgerOg ?? 3;
    const minProvider = opts?.minProviderOg ?? this.#config.minProviderOg ?? 1;
    const computeProvider = this.#network.computeProvider ?? TESTNET.computeProvider;
    if (!computeProvider) {
      throw new MissingConfigError(
        "network.computeProvider",
        "ensureTeeFunded() needs a TEE compute provider configured on the network preset",
      );
    }
    // Lazy import to keep the broker SDK out of consumers that never call
    // TEE-related code (matches the pattern already used by #initTeeVerifier).
    const { initTeeBroker } = await import("./tee/broker.js");
    await initTeeBroker({
      signer: s.signer,
      preferredProvider: computeProvider,
      ensureFunded: true,
      minLedgerOg: minLedger,
      minProviderOg: minProvider,
    });
    return { ledgerOg: minLedger, providerOg: minProvider };
  }

  async publisherStats(): Promise<PublisherStats> {
    const s = this.ensureStarted();
    return publisherStatsRegistry(s.registry, s.wallet);
  }

  async getAntibody(idOrSeq: Hex32 | number): Promise<Antibody> {
    const s = this.ensureStarted();
    return typeof idOrSeq === "number"
      ? getAntibodyByImmSeq(s.registry, idOrSeq)
      : getAntibodyById(s.registry, idOrSeq);
  }

  async sweep(): Promise<SweepResult> {
    const s = this.ensureStarted();
    return sweepExpired(s.registry);
  }

  /**
   * Testnet bootstrap: mint MockUSDC to the operator's wallet. Throws
   * runtime-side if pointed at a non-Mock USDC address.
   */
  async mintTestUsdc(amount: bigint): Promise<Hex32> {
    const s = this.ensureStarted();
    return mintTestUsdcImpl(s.usdc, s.wallet, amount);
  }

  /** Internal accessors for the facade's downstream methods. */
  protected ensureStarted(): {
    wallet: Address;
    signer: Signer;
    registry: RegistryClient;
    usdc: UsdcClient;
    cache: AntibodyCache;
    matchers: MatcherRegistry;
    gossip: Gossip;
    publisher: GossipPublisher;
    lookup: Tier2LookupClient;
    network: NetworkConfig;
  } {
    if (
      !this.#started ||
      !this.#wallet ||
      !this.#signer ||
      !this.#registry ||
      !this.#usdc ||
      !this.#cache ||
      !this.#matchers ||
      !this.#gossip ||
      !this.#publisher ||
      !this.#lookup
    ) {
      throw new NotStartedError();
    }
    return {
      wallet: this.#wallet,
      signer: this.#signer,
      registry: this.#registry,
      usdc: this.#usdc,
      cache: this.#cache,
      matchers: this.#matchers,
      gossip: this.#gossip,
      publisher: this.#publisher,
      lookup: this.#lookup,
      network: this.#network,
    };
  }
}
