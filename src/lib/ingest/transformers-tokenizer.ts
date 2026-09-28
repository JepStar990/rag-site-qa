/**
 * The bundled embedding model's own tokenizer, used for chunk sizing and
 * token accounting (docs/03). Tokenization is pure JS (no ONNX/WASM), so it
 * runs in the service worker; the tokenizer.json (~700KB) is fetched from
 * the extension package, never from the network (ADR-0002).
 */

import { EMBED_MODEL_ID } from '../embed/model-config';
import type { Tokenizer } from './tokenizer';

let cached: Promise<Tokenizer> | null = null;

/**
 * Lazy singleton per service-worker lifetime. Safe module state: it is only
 * a cache — an SW teardown drops it and the next wake reloads (ADR-0001).
 */
export function createTransformersTokenizer(modelPath: string): Promise<Tokenizer> {
  if (!cached) {
    cached = loadTokenizer(modelPath).catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function loadTokenizer(modelPath: string): Promise<Tokenizer> {
  try {
    const { AutoTokenizer, env } = await import('@huggingface/transformers');
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = modelPath;
    const tokenizer = await AutoTokenizer.from_pretrained(EMBED_MODEL_ID);
    return {
      encode: (text) => tokenizer.encode(text),
      decode: (ids) => tokenizer.decode(ids),
    };
  } catch (err) {
    throw new Error(
      `Embedding model not found. Run "npm run model:fetch" and rebuild the extension. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
