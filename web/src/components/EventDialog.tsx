import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { api, type HouseholdMember, type Project } from '../lib/api';
import { REMIND_OPTIONS, calendarName, type Calendar, type Occurrence } from '../lib/calendar';
import { RECURRENCE_OPTIONS } from '../lib/tasks';
import { onEnter } from '../lib/keys';
import { clearBlankOnBlur } from '../lib/forms';
import { timeOf } from '../lib/format';
import { dialogGhost, inlineDanger, Modal, useDialogs } from './Dialog';

const field =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent';
const label = 'mb-1.5 block text-sm font-medium text-ink';

interface Props {
  /** An existing occurrence or a date for a new event. */
  occurrence: Occurrence | null;
  defaultDate: string;
  calendars: Calendar[];
  members: HouseholdMember[];
  projects: Project[];
  onSaved: () => void;
  onClose: () => void;
}

export function EventDialog({
  occurrence,
  defaultDate,
  calendars,
  members,
  projects,
  onSaved,
  onClose,
}: Props) {
  const editing = occurrence !== null;
  // The public link for this event, once it exists. Fetched lazily — most
  // events are never shared, and the dialog opens on every click.
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const dialogs = useDialogs();

  const [draft, setDraft] = useState(() => ({
    calendar_id: occurrence?.calendar_id ?? calendars[0]?.id ?? '',
    title: occurrence?.title ?? '',
    description: occurrence?.description ?? '',
    location: occurrence?.location ?? '',
    all_day: occurrence ? occurrence.all_day === 1 : true,
    start_date: occurrence?.date ?? defaultDate,
    end_date: occurrence?.ends_at.slice(0, 10) ?? defaultDate,
    start_time: occurrence ? timeOf(occurrence.starts_at) || '10:00' : '10:00',
    end_time: occurrence ? timeOf(occurrence.ends_at) || '11:00' : '11:00',
    // Fetched below: a series occurrence carries no recurrence rule
    recurrence_rule: '',
    project_id: occurrence?.project_id ?? '',
    remind_days_before:
      occurrence?.remind_days_before !== null && occurrence?.remind_days_before !== undefined
        ? String(occurrence.remind_days_before)
        : '',
    birth_year: '',
    participants: occurrence?.participants.map((p) => p.id) ?? [],
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The recurrence rule and birth year only come with the full event
  useEffect(() => {
    if (!occurrence) return;
    void api
      .get<{ recurrence_rule: string | null; birth_year: number | null }>(
        `/events/${occurrence.event_id}`,
      )
      .then((full) =>
        setDraft((d) => ({
          ...d,
          recurrence_rule: full.recurrence_rule ?? '',
          birth_year: full.birth_year ? String(full.birth_year) : '',
        })),
      )
      .catch(() => {});
  }, [occurrence]);

  function payload() {
    return {
      calendar_id: draft.calendar_id,
      title: draft.title,
      description: draft.description || null,
      location: draft.location || null,
      all_day: draft.all_day,
      starts_at: draft.all_day ? draft.start_date : `${draft.start_date}T${draft.start_time}`,
      ends_at: draft.all_day ? draft.end_date : `${draft.end_date}T${draft.end_time}`,
      recurrence_rule: draft.recurrence_rule || null,
      project_id: draft.project_id || null,
      remind_days_before: draft.remind_days_before ? Number(draft.remind_days_before) : null,
      birth_year: draft.birth_year ? Number(draft.birth_year) : null,
      participants: draft.participants,
    };
  }

  async function share() {
    if (!occurrence) return;
    const res = await api.post<{ path: string }>(`/events/${occurrence.event_id}/share`, {});
    setSharePath(res.path);
    setShareCopied(false);
  }

  async function unshare() {
    if (!occurrence) return;
    await api.delete(`/events/${occurrence.event_id}/share`);
    setSharePath(null);
  }

  async function save() {
    if (!draft.title.trim()) {
      setError(t('Enter an event name'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) await api.patch(`/events/${occurrence.event_id}`, payload());
      else await api.post('/events', payload());
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
  }

  /** For a recurring event, deletion is two distinct actions. */
  async function removeOne() {
    if (!occurrence) return;
    await api.delete(`/events/${occurrence.event_id}/occurrences/${occurrence.date}`);
    onSaved();
    onClose();
  }

  async function removeAll() {
    if (!occurrence) return;
    const ok = await dialogs.confirm({
      title: occurrence.is_recurring ? t('Delete series') : t('Delete event'),
      message: occurrence.is_recurring
        ? t('“{title}” will disappear from all dates, including past ones.', { title: occurrence.title })
        : t('“{title}” will be deleted.', { title: occurrence.title }),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/events/${occurrence.event_id}`);
    onSaved();
    onClose();
  }

  /*
    Through Modal, like every other dialog (#84): the hand-rolled shell
    here is where the dialog defects kept landing — no way to close a new
    event on a phone (#83), no scroll lock (#71). Cancel comes with the
    footer convention; the inline onSubmit closure re-subscribes Modal's
    key handler every render, so save always sees the current draft —
    exactly what the old no-dependency-list effect did.
  */
  return (
    <Modal
      title={editing ? t('Event') : t('New event')}
      width="max-w-lg"
      onClose={onClose}
      onSubmit={() => {
        if (!busy) void save();
      }}
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          {editing && occurrence.is_recurring && (
            <button
              type="button"
              onClick={() => void removeOne()}
              className="text-sm text-muted underline underline-offset-2 hover:text-ink"
            >
              {t('Skip this occurrence')}
            </button>
          )}
          {editing && (
            <button
              type="button"
              onClick={() => void removeAll()}
              className={`${inlineDanger} text-sm`}
            >
              {occurrence.is_recurring ? t('Delete series') : t('Delete')}
            </button>
          )}

          {/* The always-present way out (#83): on a phone the backdrop
              shrinks to slivers once the panel scrolls, and a new event
              used to leave Save alone in this row */}
          <button type="button" onClick={onClose} className={`ml-auto ${dialogGhost}`}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('Saving') : t('Save')}
          </button>
        </div>
      }
    >
        <div className="space-y-4">
          {editing && (
            <div className="rounded-lg border border-line bg-surface-2 p-3">
              {sharePath ? (
                <>
                  <p className="break-all font-mono text-xs text-ink">
                    {window.location.origin}
                    {sharePath}
                  </p>
                  <p className="mt-1.5 text-xs text-muted">
                    {t('Anyone with this link sees this event only — not the calendar it is in.')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(`${window.location.origin}${sharePath}`);
                        setShareCopied(true);
                      }}
                      className="text-sm text-accent underline underline-offset-2"
                    >
                      {shareCopied ? t('Copied') : t('Copy')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void unshare()}
                      className={`${inlineDanger} text-sm`}
                    >
                      {t('Revoke the link')}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void share()}
                  className="text-sm text-accent underline underline-offset-2"
                >
                  {t('Share this event by link')}
                </button>
              )}
            </div>
          )}
          <label className="block">
            <span className={label}>{t('Title')}</span>
            <input
              autoFocus
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              onBlur={clearBlankOnBlur(() => setDraft({ ...draft, title: '' }))}
              onKeyDown={onEnter(() => void save())}
              className={field}
            />
          </label>

          <div className="grid grid-cols-2 gap-3 *:min-w-0">
            <label className="block">
              <span className={label}>{t('Calendar')}</span>
              <select
                value={draft.calendar_id}
                onChange={(e) => setDraft({ ...draft, calendar_id: e.target.value })}
                className={field}
              >
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {calendarName(c.id, c.name)}
                    {c.shared ? '' : t(' (personal)')}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={label}>{t('Place')}</span>
              <input
                value={draft.location}
                onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                onBlur={clearBlankOnBlur(() => setDraft({ ...draft, location: '' }))}
                className={field}
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={draft.all_day}
              onChange={(e) => setDraft({ ...draft, all_day: e.target.checked })}
              className="size-4 accent-[var(--c-accent)]"
            />
            {t('All day')}
          </label>

          <div className="grid grid-cols-2 gap-3 *:min-w-0">
            <label className="block">
              <span className={label}>{t('Start')}</span>
              <input
                type="date"
                value={draft.start_date}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    start_date: e.target.value,
                    end_date:
                      draft.end_date < e.target.value ? e.target.value : draft.end_date,
                  })
                }
                className={field}
              />
            </label>

            <label className="block">
              <span className={label}>{t('End')}</span>
              <input
                type="date"
                value={draft.end_date}
                onChange={(e) => setDraft({ ...draft, end_date: e.target.value })}
                className={field}
              />
            </label>

            {!draft.all_day && (
              <>
                <label className="block">
                  <span className={label}>{t('Start time')}</span>
                  <input
                    type="time"
                    value={draft.start_time}
                    onChange={(e) => setDraft({ ...draft, start_time: e.target.value })}
                    className={field}
                  />
                </label>
                <label className="block">
                  <span className={label}>{t('End time')}</span>
                  <input
                    type="time"
                    value={draft.end_time}
                    onChange={(e) => setDraft({ ...draft, end_time: e.target.value })}
                    className={field}
                  />
                </label>
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 *:min-w-0">
            <label className="block">
              <span className={label}>{t('Recurrence')}</span>
              <select
                value={draft.recurrence_rule}
                onChange={(e) => setDraft({ ...draft, recurrence_rule: e.target.value })}
                className={field}
              >
                {RECURRENCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={label}>{t('Remind')}</span>
              <select
                value={draft.remind_days_before}
                onChange={(e) => setDraft({ ...draft, remind_days_before: e.target.value })}
                className={field}
              >
                {REMIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {draft.recurrence_rule === 'FREQ=YEARLY' && (
            <label className="block">
              <span className={label}>{t('Year of birth')}</span>
              <input
                type="number"
                placeholder={t('Optional — shows the age')}
                value={draft.birth_year}
                onChange={(e) => setDraft({ ...draft, birth_year: e.target.value })}
                className={field}
              />
            </label>
          )}

          <label className="block">
            <span className={label}>{t('Project')}</span>
            <select
              value={draft.project_id}
              onChange={(e) => setDraft({ ...draft, project_id: e.target.value })}
              className={field}
            >
              <option value="">{t('No project')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className={label}>{t('Who is going')}</span>
            {members.length < 2 && (
              <p className="mb-2 text-xs text-muted">
                {t('Nobody to pick yet: the hub has a single account. Create personal accounts in People — everyone will show up here.')}
              </p>
            )}
              <div className="flex flex-wrap gap-2">
                {members.map((m) => {
                  const on = draft.participants.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      data-chip
                      onClick={() =>
                        setDraft({
                          ...draft,
                          participants: on
                            ? draft.participants.filter((p) => p !== m.id)
                            : [...draft.participants, m.id],
                        })
                      }
                      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                        on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
                      }`}
                    >
                      {m.name}
                    </button>
                  );
                })}
            </div>
          </div>

          <label className="block">
            <span className={label}>{t('Description')}</span>
            <textarea
              rows={3}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              onBlur={clearBlankOnBlur(() => setDraft({ ...draft, description: '' }))}
              className={`${field} resize-y`}
            />
          </label>

          {error && <p className="text-sm text-urgent">{error}</p>}
        </div>
    </Modal>
  );
}
