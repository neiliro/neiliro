/*
  Service letters, laid out (#30 follow-up, decided 2026-09-14).

  A letter is a list of blocks; the same list renders as the plain-text
  part and as the HTML part, so the two never say different things and a
  client that shows only one of them loses nothing but the layout.

  The HTML is deliberately poor by web standards and rich by e-mail ones:
  tables and inline styles, because that is what mail clients render;
  system fonts; no image, no stylesheet, no font, no script — nothing that
  would make a client fetch anything from anywhere. A fetch is an open
  receipt, and the privacy policy promises there is none. Links are the
  only outward reference, and Mailgun is told not to rewrite them
  (`o:tracking=no` in mail.ts). Every string a person or a family supplied
  is escaped before it becomes markup.
*/

export type LetterBlock =
  | { kind: 'p'; text: string }
  | { kind: 'muted'; text: string }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'steps'; items: { title: string; text: string }[] }
  | { kind: 'code'; text: string };

export interface Letter {
  /** The heading inside the letter; the subject line is set by the caller. */
  title: string;
  blocks: LetterBlock[];
  /** The small print under the letter: why it was sent. */
  footer: string;
  /** The wordmark and the brand link. */
  brand: { name: string; url: string };
}

const INK = '#131c24';
const MUTED = '#5a6a74';
const ACCENT = '#1f6e8c';
const LINE = '#e3e8ec';
const SURFACE = '#f6f8fa';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only http(s) targets become links; anything else is shown as text so a stray value cannot become javascript:. */
function safeUrl(url: string): string | null {
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

/** Wrap a paragraph at a width people read at; URLs are never split. */
function wrap(text: string, width = 72, indent = ''): string {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = indent;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line.trim() && (line + ' ' + word).length > width) {
        out.push(line.trimEnd());
        line = indent + word;
      } else line = line.trim() ? `${line} ${word}` : indent + word;
    }
    out.push(line.trimEnd());
  }
  return out.join('\n');
}

export function renderLetterText(letter: Letter): string {
  const lines: string[] = ['Hello.', ''];
  for (const b of letter.blocks) {
    switch (b.kind) {
      case 'p':
      case 'muted':
        lines.push(wrap(b.text), '');
        break;
      case 'button':
        lines.push(`${b.label}:`, b.url, '');
        break;
      case 'link':
        lines.push(wrap(b.text), b.url, '');
        break;
      case 'code':
        lines.push(`  ${b.text}`, '');
        break;
      case 'steps':
        b.items.forEach((it, i) => {
          lines.push(wrap(`${i + 1}. ${it.title}`, 72), wrap(it.text, 72, '   '), '');
        });
        break;
    }
  }
  lines.push(wrap(letter.footer));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function renderLetterHtml(letter: Letter): string {
  const p = (text: string, color = INK, size = 15) =>
    `<p style="margin:0 0 16px;font-size:${size}px;line-height:1.55;color:${color};">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  const parts: string[] = [];
  for (const b of letter.blocks) {
    switch (b.kind) {
      case 'p':
        parts.push(p(b.text));
        break;
      case 'muted':
        parts.push(p(b.text, MUTED, 14));
        break;
      case 'code':
        parts.push(
          `<p style="margin:0 0 16px;padding:10px 14px;background:${SURFACE};border:1px solid ${LINE};border-radius:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:${INK};word-break:break-all;">${escapeHtml(b.text)}</p>`,
        );
        break;
      case 'link': {
        const url = safeUrl(b.url);
        parts.push(
          url
            ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${INK};">${escapeHtml(b.text)} <a href="${escapeHtml(url)}" style="color:${ACCENT};text-decoration:underline;">${escapeHtml(url)}</a></p>`
            : p(`${b.text} ${b.url}`),
        );
        break;
      }
      case 'button': {
        const url = safeUrl(b.url);
        if (!url) {
          parts.push(p(`${b.label}: ${b.url}`));
          break;
        }
        parts.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr><td style="background:${ACCENT};border-radius:10px;">` +
            `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(b.label)}</a>` +
            `</td></tr></table>` +
            `<p style="margin:-8px 0 20px;font-size:12px;line-height:1.5;color:${MUTED};word-break:break-all;">${escapeHtml(url)}</p>`,
        );
        break;
      }
      case 'steps':
        parts.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%;">` +
            b.items
              .map(
                (it, i) =>
                  `<tr><td valign="top" style="width:32px;padding:0 0 14px;font-size:15px;font-weight:600;color:${ACCENT};">${i + 1}.</td>` +
                  `<td valign="top" style="padding:0 0 14px;font-size:15px;line-height:1.5;color:${INK};"><span style="font-weight:600;">${escapeHtml(it.title)}</span><br>` +
                  `<span style="color:${MUTED};">${escapeHtml(it.text)}</span></td></tr>`,
              )
              .join('') +
            `</table>`,
        );
        break;
    }
  }
  const brandUrl = safeUrl(letter.brand.url) ?? '#';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${escapeHtml(letter.title)}</title></head>` +
    `<body style="margin:0;padding:0;background:${SURFACE};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${SURFACE};"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;font-family:${FONT};">` +
    `<tr><td style="padding:0 8px 18px;"><a href="${escapeHtml(brandUrl)}" style="font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${INK};text-decoration:none;">${escapeHtml(letter.brand.name)}</a></td></tr>` +
    `<tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;padding:32px 32px 20px;">` +
    `<h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(letter.title)}</h1>` +
    parts.join('') +
    `</td></tr>` +
    `<tr><td style="padding:18px 8px 0;font-size:12px;line-height:1.5;color:${MUTED};">${escapeHtml(letter.footer)}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
