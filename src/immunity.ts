import { Gossip } from "axl-pubsub";
import { AntibodyCache } from "./cache/cache.js";
import { runCheck } from "./check-flow.js";
import {
  publish as publishAntibody,
  type PublishInput,
  type PublishResult,
} from "./settlement/publish.js";
import type { CheckOptions, CheckResult } from "./types/check.js";
import type { CheckContext, ProposedTx } from "./types/context.js";
import { AddressMatcher } from "./matchers/address.js";
import { BytecodeMatcher, type CodeFetcher } from "./matchers/bytecode.js";
import { CallPatternMatcher } from "./matchers/call-pattern.js";
import { GraphMatcher } from "./matchers/graph.js";
import { MatcherRegistry } from "./matchers/matcher.js";
import { SemanticMatcher } from "./matchers/semantic.js";
import { GossipPublisher } from "./gossip/publisher.js";
import { GossipSubscriber } from "./gossip/subscriber.js";
import { resolveNetwork } from "./network.js";
import { createRegistryClient, type RegistryClient } from "./settlement/registry-client.js";
import { createUsdcClient, type UsdcClient } from "./settlement/usdc-client.js";
import type { Address } from "./types/antibody.js";
import type { ImmunityConfig, NetworkConfig } from "./types/config.js";
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
      ...(this.#config.axlIdentityPath
        ? { privateKeyPath: this.#config.axlIdentityPath }
        : {}),
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
