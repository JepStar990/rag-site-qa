/**
 * Embedding runtime (docs/03-component-design.md) — runs in the runtime
 * host: the offscreen document on Chromium, the background event page on
 * Firefox (ADR-0001). transformers.js loads the bundled model from the
 * extension package via `env.localModelPath`; nothing is fetched at runtime
 * (ADR-0002). WebGPU when available, single-threaded WASM otherwise
 * (extension pages cannot be crossOriginIsolated, so threaded WASM is out).
 */

import { EMBED_DIM } from '../../shared/types';
import { openSiteDbNamed, putChunkVecs } from '../db/site-db';
import { EMBED_MODEL_ID } from './model-config';

export type EmbedDevice = 'webgpu' | 'wasm' | 'auto';

export interface Embedder {
  /** One 384-dim L2-normalized vector per input text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** L2-normalizes a vector in place and returns it (shared with the retriever). */
export function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0 || !Number.isFinite(norm)) return vec;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (v === undefined) return vec; // unreachable for dense arrays; satisfies noUncheckedIndexedAccess
    vec[i] = v / norm;
  }
  return vec;
}

/**
 * Feature-extraction seam. The production loader is transformers.js; tests
 * inject a fake with the same contract (batch in, 384-dim rows out).
 */
export type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'cls'; normalize: boolean },
) => Promise<Float32Array[]>;

const embedderCache = new Map<string, Promise<Embedder>>();

/**
 * Returns a cached embedder per model path + device. The cache is module
 * state in the runtime host, not the service worker: a host teardown simply
 * reloads the model lazily on the next call.
 */
export function createEmbedder(
  opts: { modelPath: string; device?: EmbedDevice },
  extractor?: FeatureExtractor,
): Promise<Embedder> {
  const device = resolveDevice(opts.device ?? 'auto');
  const key = `${opts.modelPath}|${device}`;
  let cached = embedderCache.get(key);
  if (!cached) {
    cached = loadEmbedder(opts.modelPath, device, extractor).catch((err) => {
      embedderCache.delete(key);
      throw err;
    });
    embedderCache.set(key, cached);
  }
  return cached;
}

function resolveDevice(device: EmbedDevice): 'webgpu' | 'wasm' {
  if (device !== 'auto') return device;
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
}

async function loadEmbedder(
  modelPath: string,
  device: 'webgpu' | 'wasm',
  extractor?: FeatureExtractor,
): Promise<Embedder> {
  const extract = extractor ?? (await loadPipeline(modelPath, device));
  return {
    embed: async (texts: string[]): Promise<Float32Array[]> => {
      if (texts.length === 0) return [];
      const rows = await extract(texts, { pooling: 'cls', normalize: true });
      // Defense in depth: the stored-vector invariant is normalized 384-dim.
      return rows.map(normalize);
    },
  };
}

async function loadPipeline(modelPath: string, device: 'webgpu' | 'wasm'): Promise<FeatureExtractor> {
  try {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = modelPath;
    const extractor = await pipeline('feature-extraction', EMBED_MODEL_ID, { dtype: 'q8', device });
    return async (texts, options): Promise<Float32Array[]> => {
      const output = await extractor(texts, options);
      // Tensor.data is a wide typed-array union; the pipeline's dtype is q8
      // and its output is numeric, never BigInt, so the conversion is safe.
      const raw = output.data;
      const data = Array.isArray(raw) ? Float32Array.from(raw) : Float32Array.from(raw as ArrayLike<number>);
      const rowSize = Math.floor(data.length / texts.length);
      if (rowSize !== EMBED_DIM || rowSize * texts.length !== data.length) {
        throw new Error(`Embedding model returned an unexpected shape: ${data.length} values for ${texts.length} texts.`);
      }
      const rows: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) rows.push(new Float32Array(data.slice(i * rowSize, (i + 1) * rowSize)));
      return rows;
    };
  } catch (err) {
    throw new Error(
      `Embedding model not found. Run "npm run model:fetch" and rebuild the extension. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Embed one batch and merge the vectors into the site database. The
 * transaction commit is the checkpoint the crawl orchestrator waits for
 * (docs/03): on kill, at most this one un-acked batch is re-embedded.
 */
export async function runEmbedBatch(
  args: { dbName: string; chunks: { chunkId: string; text: string }[] },
  opts: { modelPath: string; device?: EmbedDevice },
): Promise<void> {
  if (args.chunks.length === 0) return;
  const embedder = await createEmbedder(opts);
  const vecs = await embedder.embed(args.chunks.map((c) => c.text));
  const updates = args.chunks.map((c, i) => {
    const vec = vecs[i];
    if (!vec) throw new Error(`Embedder returned ${vecs.length} vectors for ${args.chunks.length} chunks.`);
    return { chunkId: c.chunkId, vec };
  });
  const db = await openSiteDbNamed(args.dbName);
  try {
    await putChunkVecs(db, updates);
  } finally {
    db.close();
  }
}
