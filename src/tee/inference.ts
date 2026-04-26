import OpenAI from "openai";
import { TeeResponseError } from "../types/errors.js";
import { createLogger } from "../util/logger.js";
import type { TeeBroker } from "./broker.js";

const log = createLogger("tee:inference");

export interface InferenceResult {
  raw: string;
  chatId: string;
  signedAndValid: boolean;
  latencyMs: number;
}

/**
 * Run a single chat completion against the bound TEE service and verify
 * the per-response signature via `processResponse` (which also settles
 * the per-token payment).
 *
 * `getRequestHeaders` is single-use. We regenerate per call.
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
    log.warn("processResponse threw; treating as unverified", err);
  }
  if (!signedAndValid) {
    throw new TeeResponseError("processResponse rejected the TEE signature");
  }
  return { raw, chatId, signedAndValid, latencyMs };
}
