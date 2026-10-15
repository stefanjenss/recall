import MarkdownIt from 'markdown-it';

// Safe Markdown for prompts and answers: paragraphs, lists, emphasis, inline
// code, fenced code, and links. Raw HTML is escaped (html: false) and
// markdown-it's validateLink rejects javascript:, vbscript:, file:, and data:
// URLs. Images are disabled so card content never triggers network requests.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
md.disable(['image']);

const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Code blocks scroll horizontally inside their own region, so they must be
// reachable by keyboard.
for (const rule of ['fence', 'code_block'] as const) {
  const base = md.renderer.rules[rule]!;
  md.renderer.rules[rule] = (tokens, idx, options, env, self) =>
    base(tokens, idx, options, env, self).replace(/^<pre>/, '<pre tabindex="0">');
}

const ALLOWED_PROTOCOL = /^(https?:|mailto:|#|\/|\.)/i;
const baseValidate = md.validateLink.bind(md);
md.validateLink = (url: string) => baseValidate(url) && ALLOWED_PROTOCOL.test(url.trim());

export function renderMarkdown(source: string): string {
  return md.render(source);
}

export function renderInlineMarkdown(source: string): string {
  return md.renderInline(source);
}

// Multiple-choice options are rendered inside buttons, so they get inline
// formatting (code, emphasis) but never links.
const mdOption = new MarkdownIt({ html: false, linkify: false, typographer: false });
mdOption.disable(['image', 'link', 'autolink']);

export function renderOptionMarkdown(source: string): string {
  return mdOption.renderInline(source);
}

/** Plain-text excerpt for lists: strips the most common Markdown syntax. */
export function plainExcerpt(source: string, max = 180): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}
