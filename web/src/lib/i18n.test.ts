import { afterEach, describe, expect, it, vi } from 'vitest';

/*
  i18n is module-level state (the language is read once at import), so each
  case stubs its inputs and imports a fresh copy of the module.

  navigator is stubbed too, and deliberately: with no stored choice the
  language now comes from the browser's preference, so leaving it to the
  real environment would make these cases pass or fail by whatever locale
  the machine running them happens to have.
*/
async function loadI18n(language: string | null, browser: string[] = ['en-US']) {
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: () => language,
    setItem: () => {},
  });
  vi.stubGlobal('navigator', { languages: browser, language: browser[0] });
  return import('./i18n');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('t', () => {
  it('English is the identity, unknown keys pass through', async () => {
    const { t } = await loadI18n(null);
    expect(t('Save')).toBe('Save');
    expect(t('Never seen before')).toBe('Never seen before');
  });

  it('Russian comes from the dictionary, unknown keys fall back to English', async () => {
    const { t } = await loadI18n('ru');
    expect(t('Save')).toBe('Сохранить');
    expect(t('Never seen before')).toBe('Never seen before');
  });

  it('params substitute in both languages', async () => {
    const en = await loadI18n(null);
    expect(en.t('{n} B', { n: 42 })).toBe('42 B');
    const ru = await loadI18n('ru');
    expect(ru.t('{n} B', { n: 42 })).toBe('42 Б');
  });
});

describe('tPlural', () => {
  it('English pair: 1 is singular, everything else plural', async () => {
    const { tPlural } = await loadI18n(null);
    expect(tPlural(1, ['day', 'days'])).toBe('day');
    expect(tPlural(2, ['day', 'days'])).toBe('days');
    expect(tPlural(21, ['day', 'days'])).toBe('days');
  });

  it('Russian gets the full three-form declension', async () => {
    const { tPlural } = await loadI18n('ru');
    expect(tPlural(1, ['day', 'days'])).toBe('день');
    expect(tPlural(2, ['day', 'days'])).toBe('дня');
    expect(tPlural(5, ['day', 'days'])).toBe('дней');
    expect(tPlural(11, ['day', 'days'])).toBe('дней');
    expect(tPlural(21, ['day', 'days'])).toBe('день');
    expect(tPlural(102, ['task', 'tasks'])).toBe('задачи');
  });
});

/*
  Until this existed, a visitor whose browser asked for Russian met an
  English hub and had to find the switch. On the public demo most never
  did, which made the whole Russian half of the product invisible.
*/
describe('language detection', () => {
  it('takes the browser preference when nothing was ever chosen', async () => {
    const { t } = await loadI18n(null, ['ru-RU']);
    expect(t('Save')).toBe('Сохранить');
  });

  it('ignores the region subtag', async () => {
    const { t } = await loadI18n(null, ['ru-BY']);
    expect(t('Save')).toBe('Сохранить');
  });

  it('takes the first preference it can actually speak', async () => {
    // Asked for German, then Russian: German is not on offer, Russian is
    const { t } = await loadI18n(null, ['de-DE', 'ru-RU']);
    expect(t('Save')).toBe('Сохранить');
  });

  it('falls back to English for a language the hub does not speak', async () => {
    const { t } = await loadI18n(null, ['ja-JP']);
    expect(t('Save')).toBe('Save');
  });

  it('lets an explicit choice beat the browser', async () => {
    const { t } = await loadI18n('en', ['ru-RU']);
    expect(t('Save')).toBe('Save');
  });

  it('survives a browser that reports no languages at all', async () => {
    const { t } = await loadI18n(null, []);
    expect(t('Save')).toBe('Save');
  });
});
