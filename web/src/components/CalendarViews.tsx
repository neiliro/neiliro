import { t } from '../lib/i18n';
import { birthdayLabel, type Occurrence } from '../lib/calendar';
import type { Task } from '../lib/api';
import {
  WEEKDAYS_SHORT,
  addDays,
  dayNumber,
  formatDate,
  isWeekend,
  startOfWeek,
  timeOf,
  weekdayIndex,
} from '../lib/format';

interface ViewProps {
  from: string;
  to: string;
  today: string;
  occurrences: Occurrence[];
  tasks: Task[];
  onPickDay: (date: string) => void;
  onOpen: (occurrence: Occurrence) => void;
}

function groupByDate(occurrences: Occurrence[], tasks: Task[]) {
  const map = new Map<string, { events: Occurrence[]; tasks: Task[] }>();
  const bucket = (date: string) => {
    let entry = map.get(date);
    if (!entry) {
      entry = { events: [], tasks: [] };
      map.set(date, entry);
    }
    return entry;
  };

  for (const o of occurrences) {
    // A multi-day event is shown on each of its days
    let cursor = o.date;
    const last = o.ends_at.slice(0, 10);
    for (let guard = 0; cursor <= last && guard < 400; guard++) {
      bucket(cursor).events.push(o);
      cursor = addDays(cursor, 1);
    }
  }
  for (const t of tasks) {
    // The effective day: an expected completion (when set) is the day
    // the task is actually going to happen — same rule as the dashboard
    const day = t.expected_date ?? t.due_date;
    if (day) bucket(day).tasks.push(t);
  }
  return map;
}

/** Attendee circles: without them the "who's going" choice is invisible outside the card. */
function Participants({
  people,
  compact,
}: {
  people: { id: string; name: string; color: string }[];
  compact?: boolean;
}) {
  if (people.length === 0) return null;
  return (
    <span className="flex shrink-0 -space-x-1" title={people.map((p) => p.name).join(', ')}>
      {people.slice(0, 3).map((p) => (
        <span
          key={p.id}
          className={`grid place-items-center rounded-full font-medium text-white ring-1 ring-surface ${
            compact ? 'size-3.5 text-[0.5rem]' : 'size-4 text-[0.5625rem]'
          }`}
          style={{ backgroundColor: p.color }}
        >
          {p.name.slice(0, 1)}
        </span>
      ))}
    </span>
  );
}

/** One event chip. Color always comes from the calendar; the project is a dot. */
function EventChip({
  occurrence,
  onOpen,
  compact,
}: {
  occurrence: Occurrence;
  onOpen: (o: Occurrence) => void;
  compact?: boolean;
}) {
  const time = timeOf(occurrence.starts_at);
  const birthday = birthdayLabel(occurrence);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(occurrence);
      }}
      title={birthday ?? undefined}
      style={{ borderLeftColor: occurrence.calendar_color }}
      className={`flex w-full items-center gap-1.5 rounded border-l-2 bg-surface-2 text-left transition-colors hover:bg-surface-3 ${
        compact ? 'px-1.5 py-0.5 text-[0.6875rem]' : 'px-2 py-1 text-xs'
      }`}
    >
      {time && <span className="shrink-0 font-mono text-muted">{time}</span>}
      {birthday && <span aria-hidden>🎂</span>}
      <span className="min-w-0 flex-1 truncate text-ink">{occurrence.title}</span>
      {occurrence.age !== null && (
        <span className="shrink-0 font-mono text-muted">{occurrence.age}</span>
      )}
      <Participants people={occurrence.participants} compact={compact} />
      {occurrence.project_id && (
        <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
      )}
    </button>
  );
}

/** Add button inside a day cell: clicking the cell itself isn't keyboard-friendly. */
function AddInDay({ date, onPickDay }: { date: string; onPickDay: (d: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onPickDay(date);
      }}
      aria-label={t('Add an event on {date}', { date })}
      className="rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
    >
      +
    </button>
  );
}

function TaskChip({ task, compact }: { task: Task; compact?: boolean }) {
  const done = task.status === 'done' || task.status === 'cancelled';
  return (
    <span
      className={`flex w-full items-center gap-1.5 rounded border border-dashed border-line ${
        compact ? 'px-1.5 py-0.5 text-[0.6875rem]' : 'px-2 py-1 text-xs'
      }`}
      title={t('Task: {project}', { project: task.project_title ?? '' })}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: task.project_color ?? 'var(--c-text-muted)' }}
        aria-hidden
      />
      <span className={`min-w-0 flex-1 truncate ${done ? 'text-muted line-through' : 'text-muted'}`}>
        {task.title}
      </span>
    </span>
  );
}

// ── Week ──────────────────────────────────────────────────────────────────

export function WeekView({ from, today, occurrences, tasks, onPickDay, onOpen }: ViewProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(from), i));
  const grouped = groupByDate(occurrences, tasks);

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
      {days.map((date) => {
        const entry = grouped.get(date);
        const isToday = date === today;
        return (
          <div
            key={date}
            onClick={() => onPickDay(date)}
            className={`group min-h-40 cursor-pointer rounded-card border p-2 text-left align-top transition-colors ${
              isToday ? 'border-accent bg-accent-soft/30' : 'border-line bg-surface'
            } ${isWeekend(date) ? 'bg-surface-2' : ''} hover:border-accent`}
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="eyebrow">{WEEKDAYS_SHORT[weekdayIndex(date)]}</span>
              <AddInDay date={date} onPickDay={onPickDay} />
              <span
                className={`font-display text-lg font-semibold ${
                  isToday ? 'text-accent' : 'text-ink'
                }`}
              >
                {dayNumber(date)}
              </span>
            </div>

            <div className="space-y-1">
              {entry?.events.map((o) => (
                <EventChip key={`${o.id}-${date}`} occurrence={o} onOpen={onOpen} />
              ))}
              {entry?.tasks.map((t) => (
                <TaskChip key={t.id} task={t} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Month ─────────────────────────────────────────────────────────────────

export function MonthView({ from, to, today, occurrences, tasks, onPickDay, onOpen }: ViewProps) {
  const grouped = groupByDate(occurrences, tasks);
  const days: string[] = [];
  for (let date = from, guard = 0; date <= to && guard < 60; date = addDays(date, 1), guard++) {
    days.push(date);
  }
  const month = days[Math.floor(days.length / 2)]?.slice(0, 7);

  return (
    <div>
      {/* The month grid keeps 7 columns on every screen. It used to collapse
          to a single column on phones: a month became a strip of ~35 empty
          half-screen cards. On phones a cell is now compact — the day number
          and event dots; a tap opens the day. */}
      <div className="mb-1 grid grid-cols-7 gap-1 sm:gap-2">
        {WEEKDAYS_SHORT.map((label) => (
          <span key={label} className="eyebrow px-1 text-center sm:text-left">
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1 sm:gap-2">
        {days.map((date) => {
          const entry = grouped.get(date);
          const isToday = date === today;
          const outside = date.slice(0, 7) !== month;
          const items = [...(entry?.events ?? [])];

          return (
            <div
              key={date}
              onClick={() => onPickDay(date)}
              className={`group cursor-pointer rounded-lg border p-1 text-left align-top transition-colors sm:min-h-24 sm:p-1.5 ${
                isToday ? 'border-accent bg-accent-soft/30' : 'border-line bg-surface'
              } ${outside ? 'opacity-45' : ''} hover:border-accent`}
            >
              <span className="mb-0.5 flex items-baseline justify-center gap-1 sm:mb-1 sm:justify-between">
                <span className="hidden sm:inline-flex">
                  <AddInDay date={date} onPickDay={onPickDay} />
                </span>
                <span
                  className={`font-mono text-xs ${isToday ? 'text-accent' : 'text-muted'}`}
                >
                  {dayNumber(date)}
                </span>
              </span>

              {/* Phones: up to three dots in calendar colors + a task dot */}
              <span className="flex min-h-2 items-center justify-center gap-0.5 pb-0.5 sm:hidden">
                {items.slice(0, 3).map((o) => (
                  <span
                    key={`${o.id}-${date}-dot`}
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: o.calendar_color }}
                    aria-hidden
                  />
                ))}
                {(entry?.tasks.length ?? 0) > 0 && (
                  <span
                    className="size-1.5 rounded-full bg-[var(--c-text-muted)]"
                    aria-hidden
                  />
                )}
              </span>

              <div className="hidden space-y-0.5 sm:block">
                {items.slice(0, 3).map((o) => (
                  <EventChip key={`${o.id}-${date}`} occurrence={o} onOpen={onOpen} compact />
                ))}
                {items.length > 3 && (
                  <span className="block px-1 text-[0.6875rem] text-muted">
                    {t('more')} {items.length - 3}
                  </span>
                )}
                {entry?.tasks.slice(0, 2).map((t) => (
                  <TaskChip key={t.id} task={t} compact />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Day and agenda ────────────────────────────────────────────────────────

export function AgendaView({ from, to, today, occurrences, tasks, onPickDay, onOpen }: ViewProps) {
  const grouped = groupByDate(occurrences, tasks);
  const days: string[] = [];
  for (let date = from, guard = 0; date <= to && guard < 400; date = addDays(date, 1), guard++) {
    const entry = grouped.get(date);
    if (entry && (entry.events.length > 0 || entry.tasks.length > 0)) days.push(date);
  }

  if (days.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
        {t('Nothing is planned for this period.')}
        <br />
        {t('Click any day in the grid to add an event.')}
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {days.map((date) => {
        const entry = grouped.get(date)!;
        return (
          <li key={date} className="rounded-card border border-line bg-surface p-4">
            <button
              type="button"
              onClick={() => onPickDay(date)}
              className="mb-3 flex items-baseline gap-2 text-left"
            >
              <span
                className={`font-display text-base font-semibold ${
                  date === today ? 'text-accent' : 'text-ink'
                }`}
              >
                {formatDate(date)}
              </span>
              <span className="eyebrow">{WEEKDAYS_SHORT[weekdayIndex(date)]}</span>
            </button>

            <div className="space-y-1.5">
              {entry.events.map((o) => (
                <EventChip key={`${o.id}-${date}`} occurrence={o} onOpen={onOpen} />
              ))}
              {entry.tasks.map((t) => (
                <TaskChip key={t.id} task={t} />
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
