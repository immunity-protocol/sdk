import type { Provider, Signer } from "ethers";
import { type CoreContracts, coreContracts } from "./contracts.js";
import { resolveNetwork } from "./network.js";
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
    this.#started = true;
    log.info("started", {
      wallet: this.#wallet,
      chainId: this.#network.chainId,
      registry: this.#network.addresses.registry,
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

  // TODO(check-package): rebuilt on Base read-side enforcement
  // (corroboration ≥ K OR isSeeded; mandatory fee; ignore|escalate|block|corroborate).
  async check(
    _tx: ProposedTx | null,
    _context: CheckContext,
    _options?: CheckOptions,
  ): Promise<CheckResult> {
    throw new Error(`check(): ${NOT_IMPL}`);
  }

  // TODO(write-package): rebuilt with Lighthouse evidence + bonded publish.
  async publish(): Promise<never> {
    throw new Error(`publish(): ${NOT_IMPL}`);
  }
}
