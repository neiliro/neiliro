import { describe, expect, it } from 'vitest';
import { applyPlaceholders, excerptOf, extractLinks, normalizeWikiLinks } from './notes';

/*
  The server's note helpers, moved into the browser (#215) — the fixtures
  are the server's own (server/src/routes/notes.test.ts) so the two copies
  cannot drift apart unnoticed while plaintext rows still exist.
*/
describe('excerptOf', () => {
  it('strips markdown and keeps the words', () => {
    expect(excerptOf('**500 g** flour · `10 g` salt')).toBe('500 g flour · 10 g salt');
    expect(excerptOf('- Milk\n- Eggs\n- Paint tape (see [[Repaint the hallway]])')).toBe(
      'Milk Eggs Paint tape (see Repaint the hallway)',
    );
    expect(excerptOf('# Заголовок\n> цитата\n1. пункт [ссылка](https://x.y)')).toBe('Заголовок цитата пункт ссылка');
    expect(excerptOf('![фото](img.png) текст после картинки')).toBe('текст после картинки');
    expect(excerptOf('- [ ] купить\n- [x] сделано')).toBe('купить сделано');
  });

  it('collapses whitespace and caps the length', () => {
    expect(excerptOf(`а${'  \n'.repeat(10)}б`)).toBe('а б');
    expect(excerptOf('я'.repeat(500))).toHaveLength(120);
  });
});

describe('links', () => {
  it('extracts titles as written, escaped brackets normalised first', () => {
    const body = normalizeWikiLinks('see \\[\\[A\\]\\] and [[B]] and [[a]]');
    expect(extractLinks(body)).toEqual(['A', 'B', 'a']);
  });
});

describe('applyPlaceholders', () => {
  it('expands both languages of keys and leaves unknown ones alone', () => {
    expect(applyPlaceholders('{{автор}} / {{author}} / {{nope}}', 'Alex')).toBe('Alex / Alex / {{nope}}');
    expect(applyPlaceholders('{{iso}}', 'Alex')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('survives a locale tag it cannot parse', () => {
    expect(() => applyPlaceholders('{{date}}', 'Alex', 'not a tag')).not.toThrow();
  });
});
