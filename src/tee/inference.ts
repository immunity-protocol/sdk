import OpenAI from "openai";
import { TeeResponseError } from "../types/errors.js";
import { createLogger } from "../util/logger.js";
import type { TeeBroker } from "./broker.js";

const log = createLogger("tee:inference");

export interface InferenceResult {
  raw: string;
  chatId: string;
  /**
   * `true` when `processResponse` confirmed the per-response TEE signature.
   * `false` when it rejected (notably in Centralized-architecture providers
   * where the LLM is not itself in a TEE; only the broker is). The caller
   * decides whether to trust the response anyway: attestation of the broker
   * during init is the harder gate, and the broker is the only thing that
   * could have produced this response over its attested endpoint.
   */
  signedAndValid: boolean;
  latencyMs: number;
}

/**
 * Run a single chat completion against the bound TEE service and call
 * `processResponse` (which also settles the per-token payment).
 *
 * `getRequestHeaders` is single-use. We regenerate per call.
 *
 * `processResponse` returning `false` does NOT abort. As of 2026-04 the
 * Galileo testnet provider 0xa48f01...62E67836 reports
 * "Architecture: Centralized" (broker in TEE, LLM via centralized provider),
 * which means there is no per-response LLM-TEE signature to verify even
 * though the broker itself is attested. Treating `false` as fatal would
 * make the SDK unusable on every Centralized provider. The signedAndValid
 * flag is surfaced on the result so policy layers can choose whether to
 * gate on it (production with Separated providers will get true).
 */
export async function runInference(broker: TeeBroker, prompt: string): Promise<InferenceResult> {
  const headers = await broker.raw.inference.getRequestHeaders(broker.service.provider, prompt);
  const openai = new OpenAI({ baseURL: broker.service.endpoint, apiKey: "" });

  const start = Date.now();
  const completion = await openai.chat.completions.create(
    {
      model: broker.service.model,
      messages: [{ role: "user", content: prompt }],
    },
    { headers: headers as unknown as Record<string, string> },
  );
  const latencyMs = Date.now() - start;

  const raw = completion.choices[0]?.message?.content ?? "";
  const chatId = completion.id;
  if (!raw) throw new TeeResponseError("TEE returned empty content");

  log.debug("inference complete", { chatId, latencyMs, length: raw.length });

  let signedAndValid = false;
  try {
    const result = await broker.raw.inference.processResponse(broker.service.provider, chatId, raw);
    signedAndValid = result === true;
  } catch (err) {
    log.warn("processResponse threw; continuing without per-response sig gate", err);
  }
  if (!signedAndValid) {
    log.warn(
      "processResponse rejected the per-response signature; provider is likely Centralized-architecture, broker attestation remains the gate",
      { chatId, provider: broker.service.provider },
    );
  }
  return { raw, chatId, signedAndValid, latencyMs };
}
