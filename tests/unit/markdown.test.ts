import { describe, expect, it } from 'vitest';
import { plainExcerpt, renderMarkdown } from '../../src/ui/markdown';

describe('safe Markdown', () => {
  it('escapes raw HTML instead of rendering it', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops unsafe link protocols and opens safe links in a new tab', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript');
    expect(renderMarkdown('[x](data:text/html,hi)')).not.toContain('href="data');
    expect(renderMarkdown('[x](vbscript:msgbox)')).not.toContain('href="vbscript');
    expect(renderMarkdown('[docs](https://example.com)')).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it('does not load images', () => {
    expect(renderMarkdown('![tracker](https://example.com/p.png)')).not.toContain('<img');
  });

  it('renders lists, inline code, and fenced code in a keyboard-scrollable block', () => {
    const html = renderMarkdown('- one\n- `two`\n\n```sql\nSELECT 1;\n```');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code>two</code>');
    expect(html).toContain('<pre tabindex="0"><code class="language-sql">SELECT 1;\n</code></pre>');
  });

  it('makes plain excerpts for lists', () => {
    expect(plainExcerpt('Use `LEFT JOIN`:\n\n```sql\nSELECT 1;\n```')).toBe('Use LEFT JOIN: [code]');
  });
});
