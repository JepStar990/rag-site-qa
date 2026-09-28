/**
 * Citation validation (docs/04 client-side enforcement): the model's answer
 * may cite only `[n]` markers that exist in the assembled context. Every
 * valid marker is resolved to its stored provenance here; anything else in
 * the answer text is inert (the popup renders it as sanitized markdown, and
 * URLs in model output are never rendered as links).
 */

import type { QaCitation } from '../../shared/types';
import type { RetrievedDoc } from './retrieve';

/**
 * Extracts `[n]` markers from the finished answer, keeps the ones that map
 * to an actual retrieved document, and resolves them to URL, title, and
 * heading. First occurrence wins; order follows the answer text.
 */
export function parseCitations(answer: string, docs: RetrievedDoc[]): QaCitation[] {
  const byIndex = new Map<number, RetrievedDoc>();
  for (const doc of docs) byIndex.set(doc.index, doc);

  const seen = new Set<number>();
  const citations: QaCitation[] = [];
  const pattern = /\[(\d{1,3})\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(answer)) !== null) {
    const raw = match[1];
    if (raw === undefined) continue;
    const index = Number(raw);
    const doc = byIndex.get(index);
    if (!doc || seen.has(index)) continue;
    seen.add(index);
    citations.push({
      index,
      url: doc.url,
      title: doc.title,
      headingPath: doc.headingPath,
    });
  }
  return citations;
}
