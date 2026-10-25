import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

/** Markdown → safe HTML, with $…$ / $$…$$ math rendered by KaTeX. */
export function renderMarkdown(text) {
  const math = [];
  const stash = (tex, display) => {
    math.push(katex.renderToString(tex, { displayMode: display, throwOnError: false }));
    return `@@MATH${math.length - 1}@@`;
  };
  // Pull math out first so Markdown doesn't mangle underscores and asterisks inside it
  const src = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stash(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stash(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stash(t, false))
    .replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, pre, t) => pre + stash(t, false));
  const html = DOMPurify.sanitize(marked.parse(src, { breaks: true, async: false }));
  return html.replace(/@@MATH(\d+)@@/g, (_, i) => math[Number(i)]);
}
