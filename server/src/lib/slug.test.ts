import { describe, expect, it } from 'vitest';
import { defaultSlug, slugBase, slugSuffix } from './slug.js';

describe('slugBase', () => {
  it('transliterates Cyrillic the way the operator script did', () => {
    expect(slugBase('Петровы')).toBe('petrovy');
    expect(slugBase('Ёжики и Щука')).toBe('yozhiki-i-schuka');
    expect(slugBase('Объявление')).toBe('obyavlenie');
  });

  it('keeps Latin, folds case and accents, turns spaces into dashes', () => {
    expect(slugBase('The Smiths!')).toBe('the-smiths');
    expect(slugBase('  Müller   Family ')).toBe('muller-family');
    expect(slugBase('O\'Brien & Co.')).toBe('obrien-co');
  });

  it('leaves room for the suffix and never ends on a dash', () => {
    const base = slugBase('a very long family name that goes on and on');
    expect(base.length).toBeLessThanOrEqual(25);
    expect(base.endsWith('-')).toBe(false);
  });

  it('gives back nothing for a name with no slug material', () => {
    expect(slugBase('🏠')).toBe('');
    expect(slugBase('李家')).toBe('');
  });
});

describe('defaultSlug', () => {
  it('is base-xxxx from the alphabet [a-z0-9]', () => {
    expect(defaultSlug('Петровы')).toMatch(/^petrovy-[a-z0-9]{4}$/);
    expect(slugSuffix()).toMatch(/^[a-z0-9]{4}$/);
  });

  it('falls back to "family" when the name spells nothing', () => {
    expect(defaultSlug('🏠')).toMatch(/^family-[a-z0-9]{4}$/);
    expect(defaultSlug('X')).toMatch(/^family-[a-z0-9]{4}$/);
  });

  it('fits createFamily\'s 30-character cap for any name', () => {
    expect(defaultSlug('a very long family name that goes on and on').length).toBeLessThanOrEqual(30);
  });
});
