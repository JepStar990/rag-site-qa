/**
 * Article extraction (ADR-0004): Readability over a DOMParser document,
 * then a heading-outline walk that yields sections for the chunker.
 *
 * Runs in the service worker: Readability 0.6 only touches the document it
 * is given (no window globals, no getComputedStyle), and DOMParser exists
 * in SW contexts on both platforms.
 */

import { Readability } from '@mozilla/readability';

export interface ArticleSection {
  /** Nearest heading path, e.g. "Installation > Requirements"; empty for lead text. */
  headingPath: string;
  text: string;
}

export interface ExtractedArticle {
  title: string;
  /** Unique heading paths in document order — the page's heading outline. */
  headings: string[];
  sections: ArticleSection[];
  /** Concatenated section text; the input to content hashing (docs/03). */
  text: string;
}

const HEADING_RE = /^H[1-6]$/;

/** Elements whose text is separated by newlines in section text. */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'TD', 'TH', 'TR', 'TABLE', 'SECTION',
  'ARTICLE', 'UL', 'OL', 'DL', 'DD', 'DT', 'FIGURE', 'FIGCAPTION', 'ADDRESS',
  'MAIN', 'ASIDE', 'FOOTER', 'HEADER', 'BR', 'HR',
]);

export function extractArticle(html: string): ExtractedArticle | null {
  let dom: Document;
  try {
    dom = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
  if (!dom.body) return null;

  const article = new Readability(dom, { charThreshold: 20 }).parse();
  if (!article?.content) return null;

  let contentDom: Document;
  try {
    contentDom = new DOMParser().parseFromString(article.content, 'text/html');
  } catch {
    return null;
  }
  if (!contentDom.body) return null;

  const sections = collectSections(contentDom.body);
  const text = sections
    .map((s) => s.text)
    .join('\n\n')
    .trim();
  if (!text) return null;

  return {
    title: article.title?.trim() || 'Untitled',
    headings: [...new Set(sections.map((s) => s.headingPath).filter(Boolean))],
    sections,
    text,
  };
}

/** Walk the extracted content in document order, splitting at h1-h6 boundaries. */
function collectSections(root: Element): ArticleSection[] {
  const sections: ArticleSection[] = [];
  let path: { level: number; text: string }[] = [];
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join('').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (text) sections.push({ headingPath: path.map((h) => h.text).join(' > '), text });
    buf = [];
  };

  const visit = (el: Element) => {
    const tag = el.tagName.toUpperCase();
    if (HEADING_RE.test(tag)) {
      flush();
      const level = Number(tag[1]);
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      path = [...path.filter((h) => h.level < level), { level, text }];
      if (text) buf.push(text);
      return;
    }

    const block = BLOCK_TAGS.has(tag);
    if (block) buf.push('\n');
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        buf.push((child.textContent ?? '').replace(/\s+/g, ' '));
      } else if (child.nodeType === 1) {
        visit(child as Element);
      }
    }
    if (block) buf.push('\n');
  };

  visit(root);
  flush();
  return sections;
}
