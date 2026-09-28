/**
 * Answer rendering (docs/04 client-side enforcement): model output is inert.
 *
 * Markdown passes through marked into DOMPurify with an allowlist of block
 * tags and zero attributes — no inline handlers, no styles, no classes, no
 * links. The only links in a rendered answer are the citation chips, built
 * after sanitization with createElement/textContent (never innerHTML with
 * model output) and only for `[n]` markers that resolve to a real crawled
 * URL (http/https, normalized during the crawl).
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { QaCitation } from '../shared/types';

/** Minimal markdown output set; everything else is stripped (docs/04). */
const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del',
  'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

export function markdownToSafeHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: [] });
}

const isCitableUrl = (url: string): boolean => /^https?:\/\//.test(url);

function citationChip(citation: QaCitation): HTMLElement {
  const chip = document.createElement('sup');
  chip.className = 'cite';
  if (isCitableUrl(citation.url)) {
    const link = document.createElement('a');
    link.href = citation.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = String(citation.index);
    link.title = citation.headingPath
      ? `${citation.title} — ${citation.headingPath}`
      : citation.title;
    chip.appendChild(link);
  } else {
    chip.textContent = String(citation.index);
  }
  return chip;
}

/** Replaces valid `[n]` markers in one text node with citation chips. */
function applyToTextNode(node: Text, byIndex: Map<number, QaCitation>): void {
  let current = node;
  for (;;) {
    const text = current.nodeValue ?? '';
    const match = /\[(\d{1,3})\]/.exec(text);
    if (!match || match.index === undefined || match[1] === undefined) return;
    const citation = byIndex.get(Number(match[1]));
    if (!citation) {
      // Out-of-range marker: not a citation, left as literal text (04).
      current = current.splitText(match.index + match[0].length);
      continue;
    }
    // splitText returns the tail; the original node keeps the prefix.
    const tail = current.splitText(match.index);
    current = tail.splitText(match[0].length);
    tail.replaceWith(citationChip(citation));
  }
}

function applyCitations(root: HTMLElement, citations: QaCitation[]): void {
  if (citations.length === 0) return;
  const byIndex = new Map<number, QaCitation>();
  for (const citation of citations) byIndex.set(citation.index, citation);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    // Literal `[n]` inside code stays literal — it is not prose.
    if (node.parentElement?.closest('pre, code')) continue;
    applyToTextNode(node, byIndex);
  }
}

/** Renders a (possibly streaming) answer into `container`, citation chips included. */
export function renderAnswerInto(
  container: HTMLElement,
  markdown: string,
  citations: QaCitation[],
): void {
  container.textContent = '';
  const wrapper = document.createElement('div');
  wrapper.innerHTML = markdownToSafeHtml(markdown);
  applyCitations(wrapper, citations);
  container.appendChild(wrapper);
}
