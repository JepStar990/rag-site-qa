// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markdownToSafeHtml, renderAnswerInto } from '../src/popup/qa-render.js';
import type { QaCitation } from '../src/shared/types.js';

const citation = (index: number, url = `https://example.com/${index}`): QaCitation => ({
  index,
  url,
  title: `Title ${index}`,
  headingPath: `Head ${index}`,
});

const render = (markdown: string, citations: QaCitation[] = []): HTMLElement => {
  const container = document.createElement('div');
  renderAnswerInto(container, markdown, citations);
  return container;
};

describe('markdownToSafeHtml', () => {
  it('renders basic markdown but strips scripts, handlers, styles, and links', () => {
    const html = markdownToSafeHtml(
      '**bold** and <script>alert(1)</script> <a href="https://evil.com" onclick="x()">link</a> <img src="x" onerror="alert(1)"> <p style="color:red">x</p>',
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('style=');
  });

  it('never renders URLs from model output as links', () => {
    const html = markdownToSafeHtml('visit https://evil.example.com now');
    expect(html).not.toContain('href=');
    expect(html).toContain('evil.example.com');
  });
});

describe('renderAnswerInto', () => {
  it('turns valid [n] markers into citation chips with real URLs', () => {
    const el = render('Answer [1] and again [2].', [citation(1), citation(2)]);
    const chips = el.querySelectorAll('sup.cite');
    expect(chips).toHaveLength(2);
    const first = chips[0]?.querySelector('a');
    expect(first?.textContent).toBe('1');
    expect(first?.getAttribute('href')).toBe('https://example.com/1');
    expect(first?.getAttribute('rel')).toContain('noopener');
    expect(first?.getAttribute('title')).toContain('Head 1');
    expect(el.textContent).toContain('Answer');
  });

  it('leaves out-of-range markers as literal text', () => {
    const el = render('Answer [99] and [1].', [citation(1)]);
    expect(el.querySelectorAll('sup.cite')).toHaveLength(1);
    expect(el.textContent).toContain('[99]');
  });

  it('does not chip markers inside code blocks', () => {
    const el = render('See [1].\n\n```\nuse [2] here\n```', [citation(1), citation(2)]);
    const chips = el.querySelectorAll('sup.cite');
    expect(chips).toHaveLength(1);
    const code = el.querySelector('pre code');
    expect(code?.textContent).toContain('[2]');
    expect(code?.querySelector('sup.cite')).toBeNull();
  });

  it('refuses to link a citation whose URL is not http(s)', () => {
    const el = render('Answer [1].', [citation(1, 'javascript:alert(1)')]);
    const chip = el.querySelector('sup.cite');
    expect(chip?.textContent).toBe('1');
    expect(chip?.querySelector('a')).toBeNull();
  });

  it('replaces container content on re-render (streaming updates)', () => {
    const container = document.createElement('div');
    renderAnswerInto(container, 'first', []);
    renderAnswerInto(container, 'second [1]', [citation(1)]);
    expect(container.textContent).toContain('second');
    expect(container.textContent).not.toContain('first');
    expect(container.querySelectorAll('sup.cite')).toHaveLength(1);
  });
});
