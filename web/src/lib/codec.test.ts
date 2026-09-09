import { beforeEach, describe, expect, it } from 'vitest';
import { decodeResponse, encodeRequest, noteIdByTitle, pendingPlaintext } from './codec';
import { generateFamilyKey, isEncrypted } from './crypto';
import { LOCKED_TEXT, setVault, VaultLockedError } from './vault';

/*
  The codec between the pages and the wire (#215): what leaves the tab is
  ciphertext plus what the server computes with; what arrives reads as
  before. Node 24's WebCrypto stands in for the browser's.
*/
type Row = Record<string, unknown>;

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const BODY = 'Buy **milk**, then see [[Repaint the hallway]] and [[Nowhere]]';

describe('encodeRequest with the family key at hand', () => {
  beforeEach(async () => setVault({ key: await generateFamilyKey(), familyHasKey: true }));

  it('seals title, body and the derived excerpt of a new note, and mints its id', async () => {
    const out = (await encodeRequest('POST', '/notes', { title: 'Groceries', body_md: BODY, folder_id: null })) as Row;
    expect(typeof out['id']).toBe('string');
    expect(isEncrypted(out['title'] as string)).toBe(true);
    expect(isEncrypted(out['body_md'] as string)).toBe(true);
    expect(isEncrypted(out['excerpt'] as string)).toBe(true);
    // Structure travels in the clear — the server files the note by it
    expect(out['folder_id']).toBeNull();
  });

  it('derives the link rows from the body and seals their titles too', async () => {
    const out = (await encodeRequest('PATCH', `/notes/${NOTE_ID}`, { body_md: BODY })) as Row;
    const links = out['links'] as { title: string; target_note_id: string | null }[];
    expect(links).toHaveLength(2);
    for (const link of links) expect(isEncrypted(link.title)).toBe(true);
  });

  it('round-trips through decodeResponse, links included', async () => {
    const sealed = (await encodeRequest('POST', '/notes', { id: NOTE_ID, title: 'Groceries', body_md: BODY })) as Row;
    const links = sealed['links'] as Row[];
    const fromServer = {
      id: NOTE_ID,
      title: sealed['title'],
      body_md: sealed['body_md'],
      excerpt: sealed['excerpt'],
      outgoing: links.map((l) => ({ target_title: l['title'], target_note_id: null, exists_now: 0 })),
      backlinks: [],
    };
    const opened = (await decodeResponse('GET', `/notes/${NOTE_ID}`, fromServer)) as Row;
    expect(opened['title']).toBe('Groceries');
    expect(opened['body_md']).toBe(BODY);
    expect(opened['excerpt']).toBe('Buy milk, then see Repaint the hallway and Nowhere');
    expect((opened['outgoing'] as Row[]).map((l) => l['target_title'])).toEqual(['Repaint the hallway', 'Nowhere']);
  });

  it('refuses to open a value bound to another row', async () => {
    const sealed = (await encodeRequest('PATCH', `/notes/${NOTE_ID}`, { title: 'Mine' })) as Row;
    const moved = (await decodeResponse('GET', `/notes/${OTHER_ID}`, { id: OTHER_ID, title: sealed['title'] })) as Row;
    expect(moved['title']).toBe(LOCKED_TEXT);
  });

  it('remembers titles from lists so [[links]] resolve here', async () => {
    const sealed = (await encodeRequest('PATCH', `/notes/${OTHER_ID}`, { title: 'Repaint the hallway' })) as Row;
    await decodeResponse('GET', '/notes?folder_id=x', [{ id: OTHER_ID, title: sealed['title'], excerpt: '' }]);
    expect(noteIdByTitle('repaint the HALLWAY')).toBe(OTHER_ID);
    const out = (await encodeRequest('PATCH', `/notes/${NOTE_ID}`, { body_md: BODY })) as Row;
    const links = out['links'] as { target_note_id: string | null }[];
    expect(links.map((l) => l.target_note_id)).toEqual([OTHER_ID, null]);
  });

  it('leaves plaintext rows from before the key readable and lists them for the job', async () => {
    const legacy = { id: OTHER_ID, title: 'Old note', body_md: 'plain', excerpt: null };
    const opened = (await decodeResponse('GET', '/notes', [legacy])) as Row[];
    expect(opened[0]!['title']).toBe('Old note');
    expect(pendingPlaintext('notes')).toContain(OTHER_ID);
  });
});

describe('encodeRequest on a device without the key', () => {
  it('refuses to write when the family has a key this device lacks', async () => {
    setVault({ key: null, familyHasKey: true });
    await expect(encodeRequest('PATCH', `/notes/${NOTE_ID}`, { title: 'x' })).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('writes plaintext when the family has no key at all — the pre-key behaviour', async () => {
    setVault({ key: null, familyHasKey: false });
    const out = (await encodeRequest('PATCH', `/notes/${NOTE_ID}`, { title: 'x', body_md: BODY })) as Row;
    expect(out['title']).toBe('x');
    expect(out['excerpt']).toBe('Buy milk, then see Repaint the hallway and Nowhere');
  });

  it('shows a placeholder for ciphertext it cannot open', async () => {
    setVault({ key: await generateFamilyKey(), familyHasKey: true });
    const sealed = (await encodeRequest('PATCH', `/notes/${NOTE_ID}`, { title: 'Secret' })) as Row;
    setVault({ key: null, familyHasKey: true });
    const opened = (await decodeResponse('GET', `/notes/${NOTE_ID}`, { id: NOTE_ID, title: sealed['title'], body_md: '' })) as Row;
    expect(opened['title']).toBe(LOCKED_TEXT);
  });
});

describe('tasks and projects (#217)', () => {
  const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
  const TASK_ID = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => setVault({ key: await generateFamilyKey(), familyHasKey: true }));

  it('seals a task and opens the joined project title under the project id', async () => {
    const project = (await encodeRequest('POST', '/projects', { id: PROJECT_ID, title: 'Garden' })) as Row;
    const task = (await encodeRequest('POST', '/tasks', { id: TASK_ID, project_id: PROJECT_ID, title: 'Mow', description: 'Back lawn', status: 'todo' })) as Row;
    expect(isEncrypted(task['title'] as string)).toBe(true);
    expect(isEncrypted(task['description'] as string)).toBe(true);
    expect(task['status']).toBe('todo');

    const opened = (await decodeResponse('GET', '/tasks?project_id=x', [
      { ...task, project_title: project['title'], project_color: '#123456' },
    ])) as Row[];
    expect(opened[0]!['title']).toBe('Mow');
    expect(opened[0]!['description']).toBe('Back lawn');
    expect(opened[0]!['project_title']).toBe('Garden');
  });

  it('creates the next occurrence itself when the server answers next_due', async () => {
    const task = (await encodeRequest('PATCH', `/tasks/${TASK_ID}`, { title: 'Water plants' })) as Row;
    const calls: { path: string; method: string; body: Row }[] = [];
    const request = async (path: string, method: string, body?: unknown) => {
      calls.push({ path, method, body: body as Row });
      return { id: 'new', ...(body as Row) };
    };
    const out = (await decodeResponse(
      'PATCH',
      `/tasks/${TASK_ID}`,
      {
        task: { id: TASK_ID, project_id: PROJECT_ID, title: task['title'], recurrence_rule: 'FREQ=WEEKLY', priority: 'normal', recurrence_parent_id: null },
        spawned: null,
        next_due: '2026-09-08',
      },
      request,
    )) as Row;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/tasks');
    // The page-level requester seals on its own way out; the codec hands it the words
    expect(calls[0]!.body).toMatchObject({ title: 'Water plants', due_date: '2026-09-08', recurrence_parent_id: TASK_ID });
    expect((out['spawned'] as Row)['due_date']).toBe('2026-09-08');
  });

  it('opens the project title on the dashboard buckets and on calendar occurrences', async () => {
    const project = (await encodeRequest('PATCH', `/projects/${PROJECT_ID}`, { title: 'Garden' })) as Row;
    const dashboard = (await decodeResponse('GET', '/dashboard', {
      dueToday: [{ id: TASK_ID, title: 'plain old task', project_id: PROJECT_ID, project_title: project['title'] }],
      overdue: [],
      upcoming: [],
      recentNotes: [],
      todayEvents: [{ id: 'e1', title: 'Event', project_id: PROJECT_ID, project_title: project['title'] }],
    })) as Row;
    expect((dashboard['dueToday'] as Row[])[0]!['project_title']).toBe('Garden');
    expect((dashboard['dueToday'] as Row[])[0]!['title']).toBe('plain old task');
    expect((dashboard['todayEvents'] as Row[])[0]!['project_title']).toBe('Garden');
    expect(pendingPlaintext('tasks')).toContain(TASK_ID);
  });
});

describe('events and calendars (#218)', () => {
  const CALENDAR_ID = '55555555-5555-4555-8555-555555555555';
  const EVENT_ID = '66666666-6666-4666-8666-666666666666';

  beforeEach(async () => setVault({ key: await generateFamilyKey(), familyHasKey: true }));

  it('opens an occurrence under its event id, with the calendar name under the calendar id', async () => {
    const calendar = (await encodeRequest('POST', '/calendars', { id: CALENDAR_ID, name: 'School' })) as Row;
    const event = (await encodeRequest('POST', '/events', {
      id: EVENT_ID, calendar_id: CALENDAR_ID, title: 'Concert', location: 'Hall', starts_at: '2026-09-20T18:00', ends_at: '2026-09-20T20:00',
    })) as Row;
    expect(isEncrypted(event['title'] as string)).toBe(true);
    expect(event['starts_at']).toBe('2026-09-20T18:00');

    const occurrences = (await decodeResponse('GET', '/events?from=a&to=b', [
      {
        id: `${EVENT_ID}#2026-09-20`, event_id: EVENT_ID, date: '2026-09-20',
        title: event['title'], description: null, location: event['location'],
        calendar_id: CALENDAR_ID, calendar_name: calendar['name'], project_id: null, project_title: null,
      },
    ])) as Row[];
    expect(occurrences[0]).toMatchObject({ title: 'Concert', location: 'Hall', calendar_name: 'School' });
    expect(pendingPlaintext('events')).not.toContain(EVENT_ID);
  });
});

describe('money (#219)', () => {
  const ACCOUNT_ID = '77777777-7777-4777-8777-777777777777';
  const CATEGORY_ID = '88888888-8888-4888-8888-888888888888';
  const RULE_ID = '99999999-9999-4999-8999-999999999999';
  const TX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  beforeEach(async () => setVault({ key: await generateFamilyKey(), familyHasKey: true }));

  it('seals the words and leaves every amount in the clear', async () => {
    const tx = (await encodeRequest('POST', '/transactions', {
      id: TX_ID, kind: 'expense', occurred_on: '2026-09-01', account_id: ACCOUNT_ID, amount: 1250, note: 'Bread', place: 'Bakery',
    })) as Row;
    expect(isEncrypted(tx['note'] as string)).toBe(true);
    expect(isEncrypted(tx['place'] as string)).toBe(true);
    expect(tx['amount']).toBe(1250);
    expect(tx['occurred_on']).toBe('2026-09-01');
  });

  it('opens joined names under their own ids and inherits a rule’s words', async () => {
    const account = (await encodeRequest('POST', '/accounts', { id: ACCOUNT_ID, name: 'Wallet', currency: 'EUR' })) as Row;
    const category = (await encodeRequest('POST', '/categories', { id: CATEGORY_ID, name: 'Food', kind: 'expense' })) as Row;
    const rule = (await encodeRequest('POST', '/recurring', { id: RULE_ID, title: 'Rent', note: 'Flat', place: 'Landlord', kind: 'expense', amount: 5 })) as Row;

    const rows = (await decodeResponse('GET', '/transactions?limit=500', [
      {
        id: TX_ID, kind: 'expense', amount: 50000, note: null, place: null,
        account_id: ACCOUNT_ID, account_name: account['name'], category_id: CATEGORY_ID, category_name: category['name'],
        to_account_id: null, to_account_name: 'Personal account',
        recurring_id: RULE_ID, recurring_title: rule['title'], recurring_note: rule['note'], recurring_place: rule['place'],
      },
    ])) as Row[];
    expect(rows[0]).toMatchObject({ account_name: 'Wallet', category_name: 'Food', note: 'Flat', place: 'Landlord', recurring_title: 'Rent', to_account_name: 'Personal account' });
  });

  it('binds a reconciliation note to the account and the day', async () => {
    const out = (await encodeRequest('POST', `/accounts/${ACCOUNT_ID}/reconcile`, { checked_on: '2026-09-01', actual_balance: 100, note: 'Bank says so' })) as Row;
    expect(isEncrypted(out['note'] as string)).toBe(true);
    expect(out['actual_balance']).toBe(100);
  });

  it('opens the outlook and the due list under the rule id', async () => {
    const rule = (await encodeRequest('PATCH', `/recurring/${RULE_ID}`, { title: 'Salary' })) as Row;
    const outlook = (await decodeResponse('GET', '/money/outlook', {
      today: '2026-09-09',
      currencies: [{ currency: 'EUR', bills: [{ recurring_id: RULE_ID, title: rule['title'], amount: 1 }], next_income: { recurring_id: RULE_ID, title: rule['title'] } }],
    })) as Row;
    const eur = (outlook['currencies'] as Row[])[0]!;
    expect((eur['bills'] as Row[])[0]!['title']).toBe('Salary');
    expect((eur['next_income'] as Row)['title']).toBe('Salary');

    const due = (await decodeResponse('GET', '/recurring/due', [{ recurring_id: RULE_ID, occurred_on: '2026-09-10', title: rule['title'], account_id: ACCOUNT_ID, account_name: 'plain' }])) as Row[];
    expect(due[0]!['title']).toBe('Salary');
  });
});
