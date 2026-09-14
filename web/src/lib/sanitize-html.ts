/*
  A letter's HTML, made safe to show (#30). The rule is an allowlist built
  into a fresh tree, never a blocklist over the sender's markup:

  - the source is parsed by DOMParser into an inert document (nothing in it
    runs), then walked; for every element that is on the list a new element
    is created and only the attributes named for it are copied. Everything
    else — scripts, styles, forms, iframes, event handlers, ids, classes,
    inline styles — never exists in the output, so there is nothing to
    re-serialize and nothing for a parser quirk to reinterpret;
  - links keep an http(s) or mailto target and open in a new tab without a
    referrer;
  - images keep only data: URIs of images — a remote <img> is a tracking
    pixel by another name, so it is dropped and the reader is told; the
    hub's CSP would block the request anyway, this stops the attempt;
  - text is text.

  The result is DOM nodes to attach, not a string: the string round-trip is
  exactly where mutation-XSS lives.
*/

const ALLOWED: Record<string, string[]> = {
  a: ['href'],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  p: [],
  br: [],
  hr: [],
  div: [],
  span: [],
  blockquote: [],
  pre: [],
  code: [],
  ul: [],
  ol: [],
  li: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  table: [],
  thead: [],
  tbody: [],
  tfoot: [],
  tr: [],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  img: ['src', 'alt', 'width', 'height'],
  font: [],
  center: [],
  small: [],
  sub: [],
  sup: [],
};

/** Everything inside these is gone, words included: it was never meant to be read. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'select', 'textarea', 'canvas', 'audio', 'video']);

export interface SanitizedHtml {
  /** A detached fragment to attach with replaceChildren; empty when the letter has no readable HTML. */
  fragment: DocumentFragment;
  /** Remote images that were dropped. */
  blockedImages: number;
  /** Whether anything at all survived. */
  empty: boolean;
}

function safeHref(value: string): string | null {
  const v = value.trim();
  if (/^(https?:\/\/|mailto:)/i.test(v)) return v;
  return null;
}

function safeImageSrc(value: string): string | null {
  const v = value.trim();
  return /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(v) ? v : null;
}

export function sanitizeHtml(source: string, doc: Document = document): SanitizedHtml {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const fragment = doc.createDocumentFragment();
  let blockedImages = 0;

  const walk = (from: Node, into: Node) => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === 3) {
        // Text node: the words, and only the words
        if (child.textContent) into.appendChild(doc.createTextNode(child.textContent));
        continue;
      }
      if (child.nodeType !== 1) continue; // comments, processing instructions
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) continue;
      if (!(tag in ALLOWED)) {
        // A structural wrapper (body, section…) or an unknown tag: keep the
        // words inside, lose the wrapper itself
        walk(el, into);
        continue;
      }
      if (tag === 'img') {
        const src = safeImageSrc(el.getAttribute('src') ?? '');
        if (!src) {
          blockedImages += 1;
          continue;
        }
        const img = doc.createElement('img');
        img.setAttribute('src', src);
        const alt = el.getAttribute('alt');
        if (alt) img.setAttribute('alt', alt);
        img.setAttribute('loading', 'lazy');
        into.appendChild(img);
        continue;
      }
      const fresh = doc.createElement(tag);
      for (const attr of ALLOWED[tag] ?? []) {
        const value = el.getAttribute(attr);
        if (value === null) continue;
        if (attr === 'href') {
          const href = safeHref(value);
          if (!href) continue;
          fresh.setAttribute('href', href);
          fresh.setAttribute('target', '_blank');
          fresh.setAttribute('rel', 'noopener noreferrer nofollow');
        } else if (attr === 'colspan' || attr === 'rowspan') {
          if (/^\d{1,2}$/.test(value)) fresh.setAttribute(attr, value);
        }
      }
      walk(el, fresh);
      into.appendChild(fresh);
    }
  };

  walk(parsed.body ?? parsed, fragment);
  const empty = (fragment.textContent ?? '').trim() === '' && fragment.querySelector('img') === null;
  return { fragment, blockedImages, empty };
}

/** Whether a letter's HTML says anything the text part does not — a wrapper around the same words is not worth rendering. */
export function htmlWorthShowing(html: string | null | undefined): boolean {
  return typeof html === 'string' && /<(table|img|a |ul|ol|h[1-6]|b>|strong|blockquote)/i.test(html);
}
