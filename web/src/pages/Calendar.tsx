import { t } from '../lib/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { EventPrefill } from '../components/EventDialog';
import { api, type HouseholdMember, type Project, type Task } from '../lib/api';
import {
  VIEW_LABEL,
  calendarName,
  loadLocal,
  saveLocal,
  type Calendar as CalendarModel,
  type CalendarView,
  type Occurrence,
} from '../lib/calendar';
import {
  addDays,
  addMonths,
  endOfMonth,
  monthTitle,
  rangeTitle,
  startOfMonth,
  plural,
  startOfWeek,
} from '../lib/format';
import { today as todayISO } from '../lib/tasks';
import { useLatest } from '../lib/latest';
import { Page } from '../components/Page';
import { AgendaView, MonthView, WeekView } from '../components/CalendarViews';
import { EventDialog } from '../components/EventDialog';
import { EntityDialog, PALETTE } from '../components/EntityDialog';

const chip = 'rounded-full border px-3 py-1.5 text-sm transition-colors';
const chipOn = 'border-accent bg-accent-soft text-accent';
const chipOff = 'border-line text-muted hover:text-ink';

/** Request bounds for the selected view. */
function rangeFor(view: CalendarView, anchor: string): { from: string; to: string } {
  if (view === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 6) };
  }
  if (view === 'month') {
    // The month grid also shows the tails of adjacent months
    return { from: startOfWeek(startOfMonth(anchor)), to: addDays(startOfWeek(endOfMonth(anchor)), 6) };
  }
  return { from: anchor, to: addDays(anchor, 45) };
}

export function Calendar() {
  const today = todayISO();
  const [params, setParams] = useSearchParams();
  const isLatest = useLatest();

  const [view, setView] = useState<CalendarView>(() => loadLocal<CalendarView>('view', 'week'));
  const [anchor, setAnchor] = useState(today);
  const [calendars, setCalendars] = useState<CalendarModel[]>([]);
  const [hidden, setHidden] = useState<string[]>(() => loadLocal<string[]>('hidden', []));
  const [showTasks, setShowTasks] = useState(() => loadLocal('showTasks', true));

  const [occurrences, setOccurrences] = useState<Occurrence[] | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Occurrence | null>(null);
  const [creatingOn, setCreatingOn] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<EventPrefill | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [editingCalendar, setEditingCalendar] = useState<CalendarModel | null>(null);
  const [creatingCalendar, setCreatingCalendar] = useState(false);

  const { from, to } = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const reloadCalendars = useCallback(async () => {
    setCalendars(await api.get<CalendarModel[]>('/calendars'));
  }, []);

  const load = useCallback(async () => {
    const fresh = isLatest();
    try {
      const [events, dueTasks] = await Promise.all([
        api.get<Occurrence[]>(`/events?from=${from}&to=${to}`),
        showTasks
          ? api.get<Task[]>(`/tasks?due_after=${from}&due_before=${to}&include_done=true`)
          : Promise.resolve([]),
      ]);
      // The range may have changed while waiting — then this response is stale
      if (!fresh()) return;
      setOccurrences(events);
      setTasks(dueTasks);
      setError(null);
    } catch (err) {
      if (!fresh()) return;
      setError(err instanceof Error ? err.message : t('Could not load the calendar'));
    }
  }, [from, to, showTasks, isLatest]);

  useEffect(() => {
    void api.get<CalendarModel[]>('/calendars').then(setCalendars);
    void api.get<HouseholdMember[]>('/household').then(setMembers);
    void api.get<Project[]>('/projects').then(setProjects);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Arriving from global search: /calendar?date=<YYYY-MM-DD>
  useEffect(() => {
    const date = params.get('date');
    if (!date) return;
    setAnchor(date);
    setParams({}, { replace: true });
  }, [params, setParams]);

  // Arriving from Mail with an invitation (#30): the dialog opens already
  // written, on the invitation's day; the person picks the calendar and
  // saves. Carried in router state, not the URL — it is words, and the
  // URL is what ends up in history and screenshots.
  useEffect(() => {
    const incoming = (location.state as { prefill?: EventPrefill } | null)?.prefill;
    if (!incoming) return;
    setPrefill(incoming);
    setAnchor(incoming.start_date);
    setCreatingOn(incoming.start_date);
    void navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  useEffect(() => saveLocal('view', view), [view]);
  useEffect(() => saveLocal('hidden', hidden), [hidden]);
  useEffect(() => saveLocal('showTasks', showTasks), [showTasks]);

  const visible = useMemo(
    () => (occurrences ?? []).filter((o) => !hidden.includes(o.calendar_id)),
    [occurrences, hidden],
  );

  function step(direction: -1 | 1) {
    if (view === 'week') setAnchor(addDays(anchor, 7 * direction));
    else if (view === 'month') setAnchor(addMonths(anchor, direction));
    else setAnchor(addDays(anchor, 30 * direction));
  }

  const title =
    view === 'month' ? monthTitle(anchor) : view === 'week' ? rangeTitle(from, to) : t('Coming up');

  const viewProps = {
    from,
    to,
    today,
    occurrences: visible,
    tasks: showTasks ? tasks : [],
    onPickDay: (date: string) => setCreatingOn(date),
    onOpen: (occurrence: Occurrence) => setEditing(occurrence),
  };

  return (
    <Page
      title={t('Calendar')}
      eyebrow={t('What and when')}
      action={
        <div className="flex gap-1 rounded-lg border border-line p-0.5">
          {(Object.keys(VIEW_LABEL) as CalendarView[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                view === v ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      }
    >
      {/* Navigation */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label={t('Back')}
            className="grid size-8 place-items-center rounded-lg border border-line text-muted hover:text-ink"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setAnchor(today)}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:text-ink"
          >
            {t('Today')}
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label={t('Forward')}
            className="grid size-8 place-items-center rounded-lg border border-line text-muted hover:text-ink"
          >
            ›
          </button>
        </div>

        <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>

        <button
          type="button"
          onClick={() => setCreatingOn(today)}
          className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          {t('New event')}
        </button>
      </div>

      {/* Layers */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {calendars.map((c) => {
          const on = !hidden.includes(c.id);
          return (
            <span
              key={c.id}
              className={`${chip} flex items-center gap-2 ${on ? chipOn : chipOff}`}
            >
              <button
                type="button"
                onClick={() =>
                  setHidden(on ? [...hidden, c.id] : hidden.filter((id) => id !== c.id))
                }
                aria-label={on ? t('Hide calendar {name}', { name: calendarName(c.id, c.name) }) : t('Show calendar {name}', { name: calendarName(c.id, c.name) })}
                className="flex items-center gap-2 hover:text-ink"
              >
                <span
                  className="size-2 rounded-full"
                  style={{
                    backgroundColor: on ? c.color : 'transparent',
                    boxShadow: `inset 0 0 0 1px ${c.color}`,
                  }}
                  aria-hidden
                />
                {calendarName(c.id, c.name)}
                {!c.shared && <span className="text-xs opacity-60">{t('personal')}</span>}
              </button>

              <button
                type="button"
                onClick={() => setEditingCalendar(c)}
                aria-label={t('Configure calendar {name}', { name: calendarName(c.id, c.name) })}
                className="opacity-60 hover:opacity-100"
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 4v2M12 18v2M20 12h-2M6 12H4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4M17.7 17.7l-1.4-1.4M7.7 7.7 6.3 6.3" />
                </svg>
              </button>
            </span>
          );
        })}

        <button
          type="button"
          onClick={() => setShowTasks(!showTasks)}
          className={`${chip} ${showTasks ? chipOn : chipOff}`}
        >
          {t('Tasks with a due date')}
        </button>

        <button
          type="button"
          onClick={() => setCreatingCalendar(true)}
          className={`${chip} border-dashed border-line text-muted hover:text-ink`}
        >
          {t('+ calendar')}
        </button>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-urgent bg-urgent/10 px-4 py-2.5 text-sm text-ink">
          {error}
        </p>
      )}

      {occurrences === null ? (
        <div className="h-64 animate-pulse rounded-card bg-surface-3" />
      ) : view === 'week' ? (
        <WeekView {...viewProps} />
      ) : view === 'month' ? (
        <MonthView {...viewProps} />
      ) : (
        <AgendaView {...viewProps} />
      )}

      {creatingCalendar && (
        <EntityDialog
          title={t('New calendar')}
          initial={{ name: '', color: PALETTE[1], flag: false }}
          flagLabel={t('Personal')}
          flagHint={t('Only you can see its events — not even the administrator')}
          onSave={async (draft) => {
            await api.post('/calendars', {
              name: draft.name,
              color: draft.color,
              shared: !draft.flag,
            });
            await reloadCalendars();
          }}
          onClose={() => setCreatingCalendar(false)}
        />
      )}

      {editingCalendar && (
        <EntityDialog
          title={t('Calendar')}
          initial={{
            name: editingCalendar.name,
            color: editingCalendar.color,
            flag: editingCalendar.shared === 0,
          }}
          flagLabel={t('Personal')}
          flagHint={t('Only you can see its events — not even the administrator')}
          deletable={editingCalendar.event_count === 0}
          deleteHint={t('The calendar has {n} {unit}. Deleting the calendar deletes its events too.', {
            n: editingCalendar.event_count,
            unit: plural(editingCalendar.event_count, 'event', 'events'),
          })}
          onSave={async (draft) => {
            await api.patch(`/calendars/${editingCalendar.id}`, {
              name: draft.name,
              color: draft.color,
              shared: !draft.flag,
            });
            await reloadCalendars();
            void load();
          }}
          onDelete={async () => {
            await api.delete(`/calendars/${editingCalendar.id}`);
            await reloadCalendars();
          }}
          onClose={() => setEditingCalendar(null)}
        />
      )}

      {(editing || creatingOn) && (
        <EventDialog
          occurrence={editing}
          defaultDate={creatingOn ?? today}
          prefill={editing ? null : prefill}
          calendars={calendars}
          members={members}
          projects={projects}
          onSaved={() => void load()}
          onClose={() => {
            setEditing(null);
            setCreatingOn(null);
            setPrefill(null);
          }}
        />
      )}
    </Page>
  );
}
