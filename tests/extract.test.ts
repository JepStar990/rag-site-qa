// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractArticle } from '../src/lib/ingest/extract.js';

// Readability demotes the h1 title to h2 in its output (h1 is reserved for
// the title), so the fixture uses h2/h3 for section nesting, which it
// preserves.
const PAGE = `<!doctype html>
<html>
<head><title>Test Doc</title></head>
<body>
  <nav><a href="/">Home</a> Navigation junk</nav>
  <main>
    <h1>Installation</h1>
    <p>First paragraph of the installation guide.</p>
    <h2>Requirements</h2>
    <p>Requirement <b>alpha</b> and requirement beta.</p>
    <ul><li>Item one</li><li>Item two</li></ul>
    <p>Installation is <em>simple</em>.</p>
    <h3>Deep point</h3>
    <p>Nested detail lives here.</p>
    <h2>Usage</h2>
    <pre>npm start</pre>
  </main>
  <footer>Footer junk</footer>
</body>
</html>`;

describe('extractArticle', () => {
  it('extracts the article with heading-path sections', () => {
    const article = extractArticle(PAGE);
    expect(article).not.toBeNull();
    expect(article!.title).toBe('Test Doc');
    expect(article!.headings).toEqual([
      'Installation',
      'Requirements',
      'Requirements > Deep point',
      'Usage',
    ]);
    expect(article!.sections.map((s) => s.headingPath)).toEqual(article!.headings);

    const install = article!.sections[0]!.text;
    expect(install).toContain('Installation');
    expect(install).toContain('First paragraph of the installation guide.');

    const reqs = article!.sections[1]!.text;
    expect(reqs).toContain('Requirement alpha and requirement beta.');
    expect(reqs).toContain('Item one');
    expect(reqs).toContain('Installation is simple.');

    expect(article!.sections[2]!.text).toContain('Nested detail lives here.');
    expect(article!.sections[3]!.text).toContain('npm start');
  });

  it('excludes boilerplate and includes all section text in the hash input', () => {
    const article = extractArticle(PAGE);
    expect(article!.text).not.toContain('Navigation junk');
    expect(article!.text).not.toContain('Footer junk');
    expect(article!.text).toContain('npm start');
  });

  it('returns null for empty pages but keeps genuinely tiny content', () => {
    expect(extractArticle('')).toBeNull();
    const tiny = extractArticle('<html><body><p>tiny</p></body></html>');
    expect(tiny).not.toBeNull();
    expect(tiny!.text).toBe('tiny');
  });
});
