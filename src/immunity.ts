import { Gossip } from "axl-pubsub";
import { AntibodyCache } from "./cache/cache.js";
import { runCheck } from "./check-flow.js";
import { GossipPublisher } from "./gossip/publisher.js";
import { GossipSubscriber } from "./gossip/subscriber.js";
import { AddressMatcher } from "./matchers/address.js";
import { BytecodeMatcher, type CodeFetcher } from "./matchers/bytecode.js";
import { CallPatternMatcher } from "./matchers/call-pattern.js";
import { GraphMatcher } from "./matchers/graph.js";
import { MatcherRegistry } from "./matchers/matcher.js";
import { SemanticMatcher } from "./matchers/semantic.js";
import { resolveNetwork } from "./network.js";
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
import type { Antibody, Hex32 } from "./types/antibody.js";
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
  #registry?: RegistryClient;
  #usdc?: UsdcClient;
  #cache?: AntibodyCache;
  #matchers?: MatcherRegistry;
  #gossip?: Gossip;
  #subscriber?: GossipSubscriber;
  #publisher?: GossipPublisher;
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

    this.#gossip = new Gossip({
      axlUrl: this.#config.axlUrl,
      ...(this.#config.axlIdentityPath ? { privateKeyPath: this.#config.axlIdentityPath } : {}),
    });
    await this.#gossip.start();
    this.#subscriber = new GossipSubscriber(this.#gossip, this.#cache);
    await this.#subscriber.start();
    this.#publisher = new GossipPublisher(this.#gossip);

    this.#started = true;
    log.info("started", {
      wallet: this.#wallet,
      registry: this.#network.registryAddress,
      chainId: this.#network.chainId,
    });
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
    return runCheck(tx, context, options, {
      wallet: s.wallet,
      registry: s.registry,
      cache: s.cache,
      matchers: s.matchers,
      publisher: s.publisher,
      defaultChainId: s.network.chainId,
      policy: this.#config.novelThreatPolicy ?? "verify",
      ...(this.#config.onEscalate ? { onEscalate: this.#config.onEscalate } : {}),
      // teeVerify is wired in a follow-up commit when the TEE module lands.
    });
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = this.ensureStarted();
    return publishAntibody(s.registry, s.wallet, input);
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
    registry: RegistryClient;
    usdc: UsdcClient;
    cache: AntibodyCache;
    matchers: MatcherRegistry;
    gossip: Gossip;
    publisher: GossipPublisher;
    network: NetworkConfig;
  } {
    if (
      !this.#started ||
      !this.#wallet ||
      !this.#registry ||
      !this.#usdc ||
      !this.#cache ||
      !this.#matchers ||
      !this.#gossip ||
      !this.#publisher
    ) {
      throw new NotStartedError();
    }
    return {
      wallet: this.#wallet,
      registry: this.#registry,
      usdc: this.#usdc,
      cache: this.#cache,
      matchers: this.#matchers,
      gossip: this.#gossip,
      publisher: this.#publisher,
      network: this.#network,
    };
  }
}
