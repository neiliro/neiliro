/*
  What a bill says about itself (#30, invoice → transaction). A letter's
  subject and body are scanned for the one thing the money form cannot
  guess — the amount — so the person confirms a number instead of typing
  it. Words the server never saw: the letter is opened in the browser.

  Deliberately conservative: an amount is taken only when it stands next
  to a currency (symbol or ISO code); a bare "12.50" in a paragraph is as
  likely a time or a reference number. When several amounts qualify, the
  one introduced by a total-like word wins, then the largest — a bill's
  total is usually its biggest number and is usually labelled.
*/

export interface DetectedAmount {
  /** Minor units, as the money module stores them. */
  minor: number;
  /** ISO code when it could be told: EUR, USD, GBP, RSD, PLN, CZK, CHF, SEK, HUF. */
  currency: string | null;
}

const SYMBOLS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP', 'zł': 'PLN', Kč: 'CZK', Ft: 'HUF', kr: 'SEK', Fr: 'CHF' };
const CODES = ['EUR', 'USD', 'GBP', 'RSD', 'PLN', 'CZK', 'CHF', 'SEK', 'HUF', 'DIN'];
const TOTAL_WORDS = /\b(total|amount due|balance due|to pay|due|итого|к оплате|сумма|всего|ukupno|za uplatu|summe|gesamt|betrag|montant|totale|importe)\b/i;

const NUMBER = String.raw`(\d{1,3}(?:[ ., ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const SYMBOL = String.raw`(€|\$|£|zł|Kč|Ft|kr|Fr)`;
const CODE = `(${CODES.join('|')})`;
const PATTERNS = [
  new RegExp(`${SYMBOL}\\s?${NUMBER}`, 'g'),
  new RegExp(`${NUMBER}\\s?${SYMBOL}`, 'g'),
  new RegExp(`${NUMBER}\\s?${CODE}\\b`, 'gi'),
  new RegExp(`\\b${CODE}\\s?${NUMBER}`, 'gi'),
];

function toMinor(raw: string): number | null {
  let s = raw.replace(/[\s ]/g, '');
  // Both separators: the rightmost is the decimal one
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
  } else if (lastComma >= 0) {
    // A single comma followed by exactly two digits is a decimal; otherwise a thousands mark
    s = /,\d{2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot >= 0 && !/\.\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return null;
  return Math.round(n * 100);
}

export function detectAmount(text: string): DetectedAmount | null {
  const candidates: { minor: number; currency: string | null; labelled: boolean }[] = [];
  const lines = text.split(/\n/);
  for (const line of lines) {
    const labelled = TOTAL_WORDS.test(line);
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const parts = m.slice(1).filter((p) => p !== undefined);
        const num = parts.find((p) => /\d/.test(p))!;
        const cur = parts.find((p) => !/\d/.test(p)) ?? '';
        const minor = toMinor(num);
        if (minor === null) continue;
        const currency = SYMBOLS[cur] ?? (cur.toUpperCase() === 'DIN' ? 'RSD' : cur.toUpperCase() || null);
        candidates.push({ minor, currency, labelled });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Number(b.labelled) - Number(a.labelled) || b.minor - a.minor);
  const best = candidates[0]!;
  return { minor: best.minor, currency: best.currency };
}

/** Attachments worth attaching as the receipt: the document itself, not a logo. */
export function looksLikeReceipt(mime: string | undefined, filename: string): boolean {
  const m = (mime ?? '').toLowerCase();
  return m === 'application/pdf' || m.startsWith('image/') || /\.(pdf|png|jpe?g|webp)$/i.test(filename);
}
