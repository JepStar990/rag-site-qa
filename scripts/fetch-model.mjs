/**
 * Downloads the bundled embedding model into public/models/ (ADR-0002).
 *
 * Every file is pinned by size and sha256:
 * - onnx/model_quantized.onnx is pinned to the sha256 published by the
 *   Hugging Face API for the repo's LFS object (lfs.oid) — the artifact's
 *   own integrity record, not a hash of whatever a first download returned.
 * - the small tokenizer/config files are pinned to the hashes of one
 *   inspected download (config.json and tokenizer.json are additionally
 *   parsed before acceptance — a tampered file would not decode).
 *
 * Model files are never committed; `.gitignore` excludes public/models/.
 * Rerun after changing model-config.ts or deleting the directory. Existing
 * files that verify are skipped, so reruns are incremental. Use
 * `node scripts/fetch-model.mjs --verify` to check without downloading.
 *
 * Requires Node >= 18 (global fetch + webcrypto).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MODEL = 'Xenova/bge-small-en-v1.5';
const BASE = `https://huggingface.co/${MODEL}/resolve/main/`;
const OUT_DIR = fileURLToPath(new URL('../public/models/bge-small-en-v1.5/', import.meta.url));

/** Pinned artifacts: the exact runtime inputs of the embedder and tokenizer. */
const FILES = [
  // Small files: pinned after one inspected download (see header).
  { path: 'config.json', sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350', size: 683 },
  { path: 'quantize_config.json', sha256: '0e60fbafb996a0ff2656cf0e41c13fdf81c8f21faf564840c3b9d478c6e78479', size: 674 },
  { path: 'special_tokens_map.json', sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3', size: 125 },
  { path: 'tokenizer.json', sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66', size: 711396 },
  { path: 'tokenizer_config.json', sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3', size: 366 },
  { path: 'vocab.txt', sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3', size: 231508 },
  // LFS object: sha256 from https://huggingface.co/api/models/Xenova/bge-small-en-v1.5/tree/main/onnx?blobs=true
  { path: 'onnx/model_quantized.onnx', sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4', size: 34014426 },
];

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

async function main() {
  const verifyOnly = process.argv.includes('--verify');
  await mkdir(OUT_DIR, { recursive: true });

  let failures = 0;
  for (const file of FILES) {
    const target = `${OUT_DIR}/${file.path}`;
    const existing = await readFile(target).catch(() => null);
    if (existing && existing.length === file.size && sha256Hex(existing) === file.sha256) {
      console.log(`ok   ${file.path}`);
      continue;
    }
    if (verifyOnly) {
      console.error(`FAIL ${file.path}: missing or hash mismatch`);
      failures++;
      continue;
    }

    console.log(`fetch ${file.path}`);
    const res = await fetch(`${BASE}${file.path}`);
    if (!res.ok) {
      console.error(`FAIL ${file.path}: HTTP ${res.status}`);
      failures++;
      continue;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== file.size) {
      console.error(`FAIL ${file.path}: size ${bytes.length}, expected ${file.size}`);
      failures++;
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== file.sha256) {
      console.error(`FAIL ${file.path}: sha256 ${actual}, expected ${file.sha256}`);
      failures++;
      continue;
    }
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    await writeFile(target, bytes);
    console.log(`ok   ${file.path}`);
  }

  if (failures === 0) {
    // Structural sanity: the two JSON blobs the embedder parses at load time.
    const config = JSON.parse(await readFile(`${OUT_DIR}/config.json`, 'utf8'));
    if (config.model_type !== 'bert' || config.hidden_size !== 384) {
      throw new Error(`config.json declares unexpected model: ${config.model_type} / ${config.hidden_size}`);
    }
    JSON.parse(await readFile(`${OUT_DIR}/tokenizer.json`, 'utf8'));
    console.log('verified: config.json declares bert / 384-dim; tokenizer.json parses');
  } else {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
