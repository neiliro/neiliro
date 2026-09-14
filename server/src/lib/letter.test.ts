import { describe, expect, it } from 'vitest';
import { renderLetterHtml, renderLetterText, type Letter } from './letter.js';

/*
  The letter renderer's two promises: the HTML part fetches nothing (no
  image, stylesheet, font or script — an open receipt by any other name),
  and nothing a family typed becomes markup. Plus the boring one: the text
  part and the HTML part say the same things.
*/
const letter: Letter = {
  title: 'Your family is ready',
  brand: { name: 'Neiliro', url: 'https://neiliro.test/' },
  blocks: [
    { kind: 'p', text: 'Hub for the <Smiths> & "friends" family.' },
    { kind: 'button', label: 'Set up your family', url: 'https://smiths.neiliro.test/join?token=abc' },
    { kind: 'steps', items: [{ title: 'Choose the address.', text: 'Once, within a day.' }] },
    { kind: 'link', text: 'Terms:', url: 'https://neiliro.test/terms' },
    { kind: 'button', label: 'Nope', url: 'javascript:alert(1)' },
    { kind: 'code', text: 'smiths@mail.neiliro.test' },
  ],
  footer: 'Sent because a family was created with this address.',
};

describe('renderLetterHtml', () => {
  const html = renderLetterHtml(letter);

  it('fetches nothing and runs nothing', () => {
    expect(html).not.toMatch(/<img|<link|<script|<style|@import|url\(/i);
    const outward = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(outward.every((u) => u!.startsWith('https://') || u === '#')).toBe(true);
  });

  it('escapes what people typed and refuses non-https targets', () => {
    expect(html).toContain('&lt;Smiths&gt; &amp; &quot;friends&quot;');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('Nope: javascript:alert(1)'); // shown as text, not as a link
    expect(html).toContain('href="https://smiths.neiliro.test/join?token=abc"');
  });

  it('is a complete, self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('Set up your family');
    expect(html).toContain('1.');
  });
});

describe('renderLetterText', () => {
  const text = renderLetterText(letter);

  it('carries every word and every link the HTML does, in plain lines', () => {
    expect(text).toContain('Hello.');
    expect(text).toContain('Set up your family:\nhttps://smiths.neiliro.test/join?token=abc');
    expect(text).toContain('1. Choose the address.');
    expect(text).toContain('   Once, within a day.');
    expect(text).toContain('https://neiliro.test/terms');
    expect(text).toContain('  smiths@mail.neiliro.test');
    expect(text.trimEnd().endsWith('Sent because a family was created with this address.')).toBe(true);
    expect(text).not.toMatch(/<[a-z]/);
  });

  it('wraps prose but never a URL', () => {
    const long: Letter = { ...letter, blocks: [{ kind: 'p', text: 'word '.repeat(40).trim() }, { kind: 'button', label: 'Go', url: 'https://x.test/' + 'a'.repeat(120) }] };
    const out = renderLetterText(long);
    for (const line of out.split('\n')) {
      if (!line.startsWith('https://')) expect(line.length).toBeLessThanOrEqual(72);
    }
    expect(out).toContain('https://x.test/' + 'a'.repeat(120));
  });
});
