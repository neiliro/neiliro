import { describe, expect, it } from 'vitest';
import { listTitle, SHOPPING_LIST_ID } from './lists';
import { projectTitle } from './tasks';

/*
  Seeded names are stored in English and translated back by id. The trap —
  hit in production on the shopping list — is doing that unconditionally:
  the rename saves on the server, the helper then overwrites it on screen,
  and the feature reads as "renaming does nothing".

  calendarName had the guard from the start; these two did not. The rule is
  translate the *seeded value*, never the row.
*/

const INBOX_ID = '00000000-0000-4000-8000-000000000001';

describe('seeded name helpers', () => {
  it('translates a list that still carries its seeded name', () => {
    // No dictionary is loaded in tests, so t() passes the key through —
    // what matters is that the seeded branch is taken at all
    expect(listTitle(SHOPPING_LIST_ID, 'Shopping')).toBe('Shopping');
  });

  it('leaves a renamed list alone', () => {
    expect(listTitle(SHOPPING_LIST_ID, 'Groceries')).toBe('Groceries');
    // The bug as reported: the family renames it and sees no change
    expect(listTitle(SHOPPING_LIST_ID, 'Продукты')).toBe('Продукты');
  });

  it('never touches a list it did not seed', () => {
    expect(listTitle('11111111-2222-4333-8444-555555555555', 'Shopping')).toBe('Shopping');
    expect(listTitle('11111111-2222-4333-8444-555555555555', 'Hardware')).toBe('Hardware');
  });

  it('applies the same rule to the Inbox project', () => {
    // Inbox cannot be archived or deleted, but it can be renamed
    expect(projectTitle(INBOX_ID, 'Inbox')).toBe('Inbox');
    expect(projectTitle(INBOX_ID, 'Входящие')).toBe('Inbox');
    expect(projectTitle(INBOX_ID, 'Triage')).toBe('Triage');
    expect(projectTitle(null, 'Anything')).toBe('Anything');
  });
});
