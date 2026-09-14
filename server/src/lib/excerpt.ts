/**
 * Note preview for the list: markdown syntax is stripped, text remains.
 * A real markdown parser is overkill here — the preview lives on a single
 * line; it is enough to remove what catches the eye: images, links,
 * wiki-links, list markers and inline markers.
 */
export function excerptOf(body: string): string {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images — whole
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[wiki-link]] → its title
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [link](url) → text
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?/gm, '') // list markers and checkboxes
    .replace(/^\s*#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // quotes
    .replace(/[*_`~]/g, '') // bold/italic/code/strikethrough
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
