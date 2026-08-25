import { t } from '../lib/i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { api, ApiError, type Dashboard as DashboardData, type Task } from '../lib/api';
import { birthdayLabel, calendarName, type Occurrence } from '../lib/calendar';
import { loadLocal, saveLocal } from '../lib/storage';
import { reportFailure } from '../lib/failures';
import {
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  WIDGET_DEFS,
  boardUnits,
  normalizeLayout,
  packBoard,
  unitsFor,
  type PackedBox,
  type WidgetId,
  type WidgetSize,
  type WidgetSlot,
} from '../lib/dashboard';
import {
  WEEKDAYS_SHORT,
  addDays,
  dayNumber,
  endOfMonth,
  formatDate,
  monthTitle,
  startOfMonth,
  timeOf,
  weekdayIndex,
} from '../lib/format';
import { formatMoney, monthBounds, type Category, type Outlook, type Summary } from '../lib/money';
import { effectiveDate, projectTitle, today } from '../lib/tasks';
import { GoalBoard, hasGoal } from '../components/GoalBoard';
import { BalancePanel } from '../components/BalancePanel';
import { Page } from '../components/Page';

const PRIORITY_LABEL: Record<Task['priority'], string> = {
  low: t('Low'),
  normal: t('Normal'),
  high: t('High'),
  urgent: t('Urgent'),
};

/*
  Every dashboard row leads to where something can be done about it.
  A task opens its card, an event the calendar at the right date, a note
  the note itself. Showing a list with nowhere to go is a dead end.

  A task wears the hub's own task marker — a checkbox, tickable right
  here — while an event keeps its calendar-coloured dot. The two used to
  share the dot and were indistinguishable at a glance (the colours mean
  project vs calendar, which nobody remembers).
*/
// showDate: whether a date renders at all; overdue: whether it's alarming.
function TaskRow({
  task,
  showDate,
  overdue,
  detailed,
  onChanged,
}: {
  task: Task;
  showDate?: boolean;
  overdue?: boolean;
  /** Width permitting, unfold description/project/assignee under the title. */
  detailed?: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  // The row disappears on reload rather than flipping to a "done" state:
  // the agenda lists only open work. `checked` follows busy so the tick
  // is visible for the moment the save takes.
  async function toggle() {
    setBusy(true);
    try {
      await api.patch(`/tasks/${task.id}`, { status: 'done' });
      onChanged();
    } catch (err) {
      reportFailure(err instanceof Error ? err.message : t('Could not save'));
      setBusy(false);
    }
  }

  return (
    <li className="flex items-start border-b border-line last:border-0">
      <input
        type="checkbox"
        checked={busy}
        disabled={busy}
        onChange={() => void toggle()}
        aria-label={t('Mark as done')}
        className="mt-3 ml-4 size-4 shrink-0 accent-[var(--c-done)]"
      />
      <Link
        to={`/tasks?open=${task.id}`}
        className="min-w-0 flex-1 px-3 py-2.5 transition-colors hover:bg-surface-2">
      <span className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{task.title}</span>
        {task.priority === 'urgent' && (
          <span className="shrink-0 rounded-full border border-urgent/40 bg-urgent/10 px-2 py-0.5 font-mono text-[0.625rem] tracking-wide text-urgent uppercase">
            {PRIORITY_LABEL.urgent}
          </span>
        )}
        {showDate && effectiveDate(task) && (
          <span className={`shrink-0 font-mono text-xs ${overdue ? 'text-urgent' : 'text-muted'}`}>
            {formatDate(effectiveDate(task)!)}
          </span>
        )}
      </span>
      {/* The now column of a wide card has room to breathe, so the
          detail goes under the title, unhurried: the description in
          full, then the project and who the task is on. The week-ahead
          rows stay terse everywhere — a whole week of detail is noise. */}
      {detailed && (
        <span className="mt-1 hidden @4xl:block">
          {task.description && (
            <span className="block text-xs leading-relaxed text-muted">{task.description}</span>
          )}
          <span className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs text-muted">
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: task.project_color ?? 'var(--c-accent)' }}
                aria-hidden
              />
              {projectTitle(task.project_id, task.project_title ?? '')}
            </span>
            {task.assignee_name && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <span
                  className="grid size-4 place-items-center rounded-full text-[0.5625rem] font-medium text-white"
                  style={{ backgroundColor: task.assignee_color ?? 'var(--c-accent)' }}
                >
                  {task.assignee_name.slice(0, 1)}
                </span>
                {task.assignee_name}
              </span>
            )}
          </span>
        </span>
      )}
      </Link>
    </li>
  );
}

function EventRow({ occurrence, detailed }: { occurrence: Occurrence; detailed?: boolean }) {
  const time = timeOf(occurrence.starts_at);
  const birthday = birthdayLabel(occurrence);
  return (
    <li className="border-b border-line last:border-0">
      <Link
        to={`/calendar?date=${occurrence.date}`}
        className="block px-4 py-2.5 transition-colors hover:bg-surface-2">
      <span className="flex items-center gap-3">
        {/* The dot sits in a checkbox-sized box: mixed lists put events
            and tasks under each other, and the titles must share a column */}
        <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: occurrence.calendar_color }}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink" title={birthday ?? undefined}>
          {birthday && <span aria-hidden>🎂 </span>}
          {occurrence.title}
          {occurrence.age !== null && <span className="ml-2 text-muted">{occurrence.age}</span>}
        </span>
        {occurrence.participants.length > 0 && (
          <span
            className="flex shrink-0 -space-x-1"
            title={occurrence.participants.map((p) => p.name).join(', ')}
          >
            {occurrence.participants.slice(0, 3).map((p) => (
              <span
                key={p.id}
                className="grid size-5 place-items-center rounded-full text-[0.625rem] font-medium text-white ring-1 ring-surface"
                style={{ backgroundColor: p.color }}
              >
                {p.name.slice(0, 1)}
              </span>
            ))}
          </span>
        )}
        {occurrence.location && (
          <span className="hidden truncate text-xs text-muted sm:inline">{occurrence.location}</span>
        )}
        <span className="shrink-0 font-mono text-xs text-muted">{time || t('all day')}</span>
      </span>
      {/* Same rule as the task row: today's rows on a wide card unfold. */}
      {detailed && (
        <span className="mt-1 hidden pl-7 @4xl:block">
          {occurrence.description && (
            <span className="block text-xs leading-relaxed text-muted">
              {occurrence.description}
            </span>
          )}
          <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs text-muted">
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: occurrence.calendar_color }}
              aria-hidden
            />
            {calendarName(occurrence.calendar_id, occurrence.calendar_name)}
          </span>
        </span>
      )}
      </Link>
    </li>
  );
}

/**
 * Quick actions — phone only. On the phone the home screen is opened to
 * jot something down on the go: a task, an expense, a note. Three big
 * buttons solve that in one tap; on wide screens Cmd+K and the section
 * buttons play that role.
 */
function QuickActions() {
  const navigate = useNavigate();
  const action =
    'flex flex-col items-center gap-2 rounded-card border border-line bg-surface py-4 text-sm text-ink transition-colors active:bg-surface-2';
  const iconProps = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <div className="grid grid-cols-3 gap-3 md:hidden">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event('hub:quick-add'))}
        className={action}
      >
        <svg viewBox="0 0 24 24" className="size-6 text-accent" {...iconProps}>
          <path d="M4 7h10M4 12h10M4 17h6" />
          <path d="M18 14v6M15 17h6" />
        </svg>
        {t('Task')}
      </button>
      <button type="button" onClick={() => navigate('/money?add=1')} className={action}>
        <svg viewBox="0 0 24 24" className="size-6 text-accent" {...iconProps}>
          <rect x="3" y="6.5" width="14" height="11" rx="2" />
          <circle cx="10" cy="12" r="2.2" />
          <path d="M19 12v6M16 15h6" />
        </svg>
        {t('Expense')}
      </button>
      <button type="button" onClick={() => navigate('/notes?new=1')} className={action}>
        <svg viewBox="0 0 24 24" className="size-6 text-accent" {...iconProps}>
          <path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5Z" />
          <path d="M9 12h6M12 9v6" />
        </svg>
        {t('Note')}
      </button>
    </div>
  );
}

/** A group divider inside the agenda: "Today · 21 August", "Overdue"… */
function GroupHeader({
  label,
  date,
  count,
  alarm,
}: {
  label: string;
  date?: string;
  count?: number;
  alarm?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line bg-surface-2/40 px-4 py-2">
      <h3 className={`eyebrow ${alarm ? 'text-urgent' : ''}`}>{label}</h3>
      {date && <span className="font-mono text-xs text-muted">{formatDate(date)}</span>}
      {count !== undefined && count > 0 && (
        <span className="ml-auto font-mono text-xs text-muted tabular-nums">{count}</span>
      )}
    </div>
  );
}

/**
 * The whole week in one card instead of four look-alike lists: overdue,
 * then today (events and tasks together), then only the days that
 * actually hold something. An empty day is silence, not an empty panel.
 */
function Agenda({
  data,
  monthEvents,
  today: t0,
  onChanged,
}: {
  data: DashboardData;
  monthEvents: Occurrence[];
  today: string;
  onChanged: () => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(t0, i + 1)).map((date) => ({
    date,
    events: monthEvents.filter((o) => o.date === date),
    tasks: data.upcoming.filter((task) => effectiveDate(task) === date),
  }));
  const busyDays = days.filter((d) => d.events.length + d.tasks.length > 0);
  const nothingToday = data.dueToday.length === 0 && data.todayEvents.length === 0;

  const now = (
    <div>
      {data.overdue.length > 0 && (
        <>
          <GroupHeader label={t('Overdue')} count={data.overdue.length} alarm />
          <ul>
            {data.overdue.map((task) => (
              <TaskRow key={task.id} task={task} showDate overdue detailed onChanged={onChanged} />
            ))}
          </ul>
        </>
      )}

      <GroupHeader
        label={t('Today')}
        date={t0}
        count={data.todayEvents.length + data.dueToday.length}
      />
      {nothingToday ? (
        <p className="border-b border-line px-4 py-3 text-sm text-muted last:border-0">
          {data.overdue.length > 0 ? t('Nothing planned for today.') : t('Everything for today is done.')}
        </p>
      ) : (
        <ul>
          {data.todayEvents.map((o) => (
            <EventRow key={o.id} occurrence={o} detailed />
          ))}
          {data.dueToday.map((task) => (
            <TaskRow key={task.id} task={task} detailed onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  );

  const ahead = (
    <div>
      {busyDays.map((d, i) => (
        <div key={d.date}>
          <GroupHeader
            label={
              i === 0 && d.date === addDays(t0, 1)
                ? t('Tomorrow')
                : (WEEKDAYS_SHORT[weekdayIndex(d.date)] ?? '')
            }
            date={d.date}
          />
          <ul>
            {d.events.map((o) => (
              <EventRow key={o.id} occurrence={o} />
            ))}
            {d.tasks.map((task) => (
              <TaskRow key={task.id} task={task} onChanged={onChanged} />
            ))}
          </ul>
        </div>
      ))}
      {busyDays.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted">{t('The week ahead is clear.')}</p>
      )}
    </div>
  );

  return (
    <section className="@container overflow-hidden rounded-card border border-line bg-surface">
      {/* Width buys structure, not just wider rows: once the card itself
          is wide enough (the full row of a big screen), the now and the
          week ahead sit side by side. A container query, not a viewport
          one — the same widget can be a half-row on the same screen. */}
      <div className="@4xl:grid @4xl:grid-cols-2 @4xl:divide-x @4xl:divide-line">
        {now}
        {ahead}
      </div>
    </section>
  );
}

/** Month at a glance: dots are calendar colours, a day click opens that day. */
function MiniMonth({ today: t0, occurrences }: { today: string; occurrences: Occurrence[] }) {
  const first = startOfMonth(t0);
  const lead = weekdayIndex(first);
  const total = dayNumber(endOfMonth(t0));

  const dots = new Map<string, string[]>();
  for (const o of occurrences) {
    const list = dots.get(o.date) ?? [];
    if (list.length < 3 && !list.includes(o.calendar_color)) list.push(o.calendar_color);
    dots.set(o.date, list);
  }

  return (
    <section className="rounded-card border border-line bg-surface px-4 py-3">
      <header className="flex items-baseline justify-between">
        <h2 className="eyebrow">{monthTitle(t0)}</h2>
        <Link to="/calendar" className="font-mono text-xs text-muted transition-colors hover:text-ink">
          {t('Calendar')} →
        </Link>
      </header>
      <div className="mt-2 grid grid-cols-7 text-center">
        {WEEKDAYS_SHORT.map((w) => (
          <span key={w} className="py-1 font-mono text-[0.625rem] text-muted uppercase">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} />
        ))}
        {Array.from({ length: total }, (_, i) => {
          const date = addDays(first, i);
          const isToday = date === t0;
          const dayDots = dots.get(date) ?? [];
          return (
            <Link
              key={date}
              to={`/calendar?date=${date}`}
              className="group flex flex-col items-center pb-1"
            >
              <span
                className={`grid size-6 place-items-center rounded-full text-xs tabular-nums transition-colors ${
                  isToday
                    ? 'bg-accent font-semibold text-white'
                    : date < t0
                      ? 'text-muted group-hover:bg-surface-2'
                      : 'text-ink group-hover:bg-surface-2'
                }`}
              >
                {i + 1}
              </span>
              <span className="flex h-1 gap-0.5">
                {dayDots.map((color, j) => (
                  <span key={j} className="size-1 rounded-full" style={{ backgroundColor: color }} />
                ))}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Month money pulse: totals per currency and the three heaviest
 * categories. Subcategories roll up into their parent — same semantics
 * as the Money summary, without the expandable rows.
 */
function MoneyMonth({ summary, categories }: { summary: Summary; categories: Category[] }) {
  const expenses = summary.byCurrency.filter((r) => r.kind === 'expense');
  const income = summary.byCurrency.filter((r) => r.kind === 'income');

  const byId = new Map(categories.map((c) => [c.id, c]));
  const topByCurrency = new Map<
    string,
    Map<string, { name: string | null; color: string | null; total: number }>
  >();
  for (const r of summary.byCategory) {
    if (r.kind !== 'expense') continue;
    const bucket =
      topByCurrency.get(r.currency) ??
      new Map<string, { name: string | null; color: string | null; total: number }>();
    topByCurrency.set(r.currency, bucket);
    // A subcategory counts towards its parent only while the parent is
    // visible — same rule as the Money summary.
    const parent = r.parent_id ? byId.get(r.parent_id) : undefined;
    const key = parent?.id ?? r.category_id ?? 'none';
    const entry = bucket.get(key) ?? {
      name: parent?.name ?? r.category_name,
      color: parent?.color ?? r.color,
      total: 0,
    };
    entry.total += r.total;
    bucket.set(key, entry);
  }

  return (
    <section className="rounded-card border border-line bg-surface px-4 py-3">
      <header className="flex items-baseline justify-between">
        <h2 className="eyebrow">{t('Spending')}</h2>
        <Link to="/money" className="font-mono text-xs text-muted transition-colors hover:text-ink">
          {t('Money')} →
        </Link>
      </header>
      {expenses.length === 0 && income.length === 0 ? (
        <p className="mt-2 pb-1 text-sm text-muted">{t('No spending this month.')}</p>
      ) : (
        <div className="mt-2 space-y-4 pb-1">
          {expenses.map((r) => {
            const top = [...(topByCurrency.get(r.currency)?.values() ?? [])]
              .sort((a, b) => b.total - a.total)
              .slice(0, 3);
            const max = top[0]?.total ?? 1;
            const inc = income.find((i) => i.currency === r.currency);
            return (
              <div key={r.currency}>
                <p className="flex items-baseline gap-2">
                  <span className="font-display text-2xl font-bold tabular-nums">
                    {formatMoney(r.total, r.currency)}
                  </span>
                  {inc && (
                    <span className="font-mono text-xs text-done">
                      +{formatMoney(inc.total, inc.currency)}
                    </span>
                  )}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {top.map((c) => (
                    <li key={c.name ?? 'none'} className="text-xs">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-muted">
                          {c.name ?? t('No category')}
                        </span>
                        <span className="font-mono text-muted tabular-nums">
                          {formatMoney(c.total, r.currency)}
                        </span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(4, Math.round((c.total / max) * 100))}%`,
                            backgroundColor: c.color ?? 'var(--c-accent)',
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {expenses.length === 0 &&
            income.map((r) => (
              <p key={r.currency} className="font-mono text-sm text-done">
                +{formatMoney(r.total, r.currency)}
              </p>
            ))}
        </div>
      )}
    </section>
  );
}

function SidePanel({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface">
      <header className="flex items-baseline justify-between px-4 pt-3 pb-2">
        <h2 className="eyebrow">{title}</h2>
        {count !== undefined && count > 0 && (
          <span className="font-mono text-xs text-muted tabular-nums">{count}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function SoonPanel({ items }: { items: Occurrence[] }) {
  return (
    <SidePanel title={t('Soon')} count={items.length}>
      <ul>
        {items.map((o) => (
          <li key={o.id} className="border-b border-line last:border-0">
            <Link
              to={`/calendar?date=${o.date}`}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: o.calendar_color }}
                aria-hidden
              />
              <span
                className="min-w-0 flex-1 truncate text-sm text-ink"
                title={birthdayLabel(o) ?? undefined}
              >
                {birthdayLabel(o) && <span aria-hidden>🎂 </span>}
                {o.title}
              </span>
              <span className="font-mono text-xs text-urgent">{formatDate(o.date)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </SidePanel>
  );
}

function NotesPanel({ notes }: { notes: DashboardData['recentNotes'] }) {
  return (
    <SidePanel title={t('Recent notes')}>
      {notes.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-muted">{t('No notes yet.')}</p>
      ) : (
        <ul>
          {notes.map((n) => (
            <li key={n.id} className="border-b border-line last:border-0">
              <Link
                to={`/notes?open=${n.id}`}
                className="block truncate px-4 py-2.5 text-sm text-ink transition-colors hover:bg-surface-2"
              >
                {n.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  );
}

/** The board's gap, px — lives in the packer's math, not in CSS. */
const BOARD_GAP = 20;

function BoardWidget({
  slot,
  editing,
  box,
  onHeight,
  onSize,
  onHide,
  children,
}: {
  slot: WidgetSlot;
  editing: boolean;
  box: PackedBox;
  onHeight: (id: WidgetId, height: number) => void;
  onSize: (size: WidgetSize) => void;
  onHide: () => void;
  children: React.ReactNode;
}) {
  // Free placement: no sortable machinery, no drop targets. The widget is
  // only a drag source; where it lands is pure pointer geometry computed
  // in onDragMove, previewed by the dashed box, committed on drop.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: slot.id,
    disabled: !editing,
  });
  const def = WIDGET_DEFS[slot.id];

  const innerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => onHeight(slot.id, el.offsetHeight);
    measure();
    // Content height is alive: the agenda grows as the week fills,
    // the edit strip appears and disappears, the width changes on resize.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [slot.id, onHeight]);

  return (
    <div
      ref={setNodeRef}
      style={{ position: 'absolute', left: box.left, top: box.top, width: box.width }}
      className={isDragging ? 'opacity-40' : ''}
    >
      <div ref={innerRef} className="rounded-card">
        {editing && (
          // The strip is the drag handle: the widget below is inert while
          // editing, so its links cannot swallow the gesture.
          <div
            className="mb-2 flex cursor-grab touch-none items-center gap-2 rounded-card border border-dashed border-line bg-surface-2 px-3 py-1.5 active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <svg
              viewBox="0 0 24 24"
              className="size-4 shrink-0 text-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <path d="M4 9h16M4 15h16" />
            </svg>
            <span className="eyebrow">{def.title}</span>
            <span className="ml-auto flex items-center gap-1">
              {def.sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSize(s)}
                  title={`${s}/8`}
                  className={`rounded px-1.5 py-0.5 font-mono text-xs tabular-nums transition-colors ${
                    s === slot.size ? 'bg-accent text-white' : 'text-muted hover:bg-surface-3'
                  }`}
                >
                  {s}
                </button>
              ))}
              <button
                type="button"
                onClick={onHide}
                aria-label={t('Hide')}
                className="ml-1 rounded p-1 text-muted transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c7 0 10 7 10 7a17.4 17.4 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3 7 10 7c1.4 0 2.7-.3 3.8-.8" />
                </svg>
              </button>
            </span>
          </div>
        )}
        <div className={editing ? 'pointer-events-none select-none' : ''}>{children}</div>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [monthEvents, setMonthEvents] = useState<Occurrence[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [outlook, setOutlook] = useState<Outlook | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<WidgetSlot[]>(() =>
    normalizeLayout(loadLocal<unknown>(LAYOUT_KEY, null)),
  );
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<WidgetId | null>(null);
  // Where the dragged widget would land: the column under the pointer and
  // the widget it would push down (null = bottom of the stack).
  const [dropTarget, setDropTarget] = useState<{ col: number; beforeId: WidgetId | null } | null>(
    null,
  );

  // The packer needs the board's width and every widget's height; both
  // are observed, so the board re-packs itself on resize and as content
  // grows. A callback ref because the board mounts only after the data
  // arrives — a plain ref would leave the first mount unobserved.
  const [boardEl, setBoardEl] = useState<HTMLDivElement | null>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  const [heights, setHeights] = useState<Partial<Record<WidgetId, number>>>({});
  useLayoutEffect(() => {
    if (!boardEl) return;
    const measure = () => setBoardWidth(boardEl.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(boardEl);
    return () => observer.disconnect();
  }, [boardEl]);
  const onHeight = useCallback((id: WidgetId, height: number) => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }));
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
  );

  /*
    A bill posted from the balance widget changes two widgets at once:
    the balance it left and this month's spending it joined. Refetching
    both is cheaper than teaching the widget to patch its own numbers,
    and it cannot drift from what the server would have said.
  */
  const refreshMoney = useCallback(() => {
    const bounds = monthBounds(today());
    void Promise.all([
      api.get<Outlook>('/money/outlook'),
      api.get<Summary>(`/money/summary?from=${bounds.from}&to=${bounds.to}`),
    ])
      .then(([out, sum]) => {
        setOutlook(out);
        setSummary(sum);
      })
      .catch((err: Error) => reportFailure(err.message || t('Could not save')));
  }, []);

  function updateLayout(next: WidgetSlot[]) {
    setLayout(next);
    saveLocal(LAYOUT_KEY, next);
  }

  function onDragStart(event: DragStartEvent) {
    setDragging(event.active.id as WidgetId);
  }

  // Back onto the board, at the end of the list — gravity settles it at
  // the bottom of its column, from where it can be dragged into place.
  function addWidget(id: WidgetId) {
    const slot = layout.find((s) => s.id === id);
    if (!slot) return;
    updateLayout([...layout.filter((s) => s.id !== id), { ...slot, hidden: false }]);
    setAdding(false);
  }

  // Ticking a task off the agenda changes every bucket at once (overdue,
  // today, the week). Bumping the tick re-runs the loading effect — one
  // refetch, and the interval restarts with it.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      // The events range serves both the mini month and the week agenda —
      // near the month's end the agenda spills into the next month.
      const t0 = today();
      const weekEnd = addDays(t0, 7);
      const gridEnd = endOfMonth(t0);
      const bounds = monthBounds(t0);
      return Promise.all([
        api.get<DashboardData>('/dashboard'),
        api.get<Occurrence[]>(
          `/events?from=${startOfMonth(t0)}&to=${gridEnd > weekEnd ? gridEnd : weekEnd}`,
        ),
        api.get<Summary>(`/money/summary?from=${bounds.from}&to=${bounds.to}`),
        api.get<Category[]>('/categories'),
        api.get<Outlook>('/money/outlook'),
      ])
        .then(([d, events, sum, cats, out]) => {
          if (!alive) return;
          setData(d);
          setMonthEvents(events);
          setSummary(sum);
          setCategories(cats);
          setOutlook(out);
          setError(null);
        })
        .catch((e: Error) => {
          if (!alive) return;
          // A transient failure is what the interval exists for — a kiosk
          // that loses Wi-Fi for a minute must recover on its own. A 401
          // is not transient: the session is gone, retrying only hammers
          // the server (and re-runs the cache cleanup in api.ts) once a
          // minute for as long as the dead tab stays open. Stop; the auth
          // layer owns taking the person to the sign-in screen. (#58)
          if (e instanceof ApiError && e.status === 401) clearInterval(timer);
          setError(e.message);
        });
    };

    void load();
    // The kiosk stays open for days — refresh ourselves, no page reload.
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tick]);

  if (error && !data) {
    return (
      <Page title={t('Today')}>
        <div className="rounded-card border border-urgent/40 bg-urgent/10 px-4 py-3 text-sm text-ink">
          {error}. {t('Check that the hub server is running, then reload the page.')}
        </div>
      </Page>
    );
  }

  if (!data) {
    return (
      <Page title={t('Today')}>
        <div className="h-28 animate-pulse rounded-card bg-surface-3" />
      </Page>
    );
  }

  const soon = data.reminders.filter((o) => o.date > addDays(data.today, 7));

  // A widget with nothing to say renders nothing — unless the board is
  // being edited: then every widget must be visible to be arrangeable.
  const content: Record<WidgetId, React.ReactNode | null> = {
    goal: hasGoal(data.settings) ? (
      <GoalBoard
        settings={data.settings}
        onChange={(patch) =>
          setData((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d))
        }
      />
    ) : null,
    agenda: <Agenda data={data} monthEvents={monthEvents} today={data.today} onChanged={refresh} />,
    month: <MiniMonth today={data.today} occurrences={monthEvents} />,
    balance:
      outlook && outlook.currencies.length > 0 ? (
        <BalancePanel outlook={outlook} onPosted={refreshMoney} />
      ) : null,
    money: summary ? <MoneyMonth summary={summary} categories={categories} /> : null,
    soon: soon.length > 0 ? <SoonPanel items={soon} /> : null,
    notes: <NotesPanel notes={data.recentNotes} />,
  };

  // On the board: not hidden, and either it has something to show or the
  // board is being edited (an empty widget must stay arrangeable).
  const onBoard = (s: WidgetSlot) => !s.hidden && (editing || content[s.id] !== null);
  const visible = layout.filter(onBoard);
  const hidden = layout.filter((s) => s.hidden);

  const totalUnits = boardUnits(boardWidth);
  const colWidth = (boardWidth - (totalUnits - 1) * BOARD_GAP) / totalUnits;

  // Recomputed every render on purpose: six items of pure arithmetic is
  // cheaper than getting a memo's dependency list wrong.
  const toPackItems = (slots: WidgetSlot[]) =>
    slots.map((s) => ({
      id: s.id,
      units: unitsFor(s.size, totalUnits),
      col: s.col,
      // Before the first measurement any positive height keeps the
      // packer sane; one layout-effect later the real one arrives.
      height: heights[s.id] ?? 160,
    }));
  const packed = packBoard(toPackItems(visible), totalUnits, boardWidth, BOARD_GAP);

  /**
   * Free drag: the drop spot is pure pointer geometry — the column under
   * the dragged card and the widget whose place it takes in that column's
   * stack. No drop zones, no collision detection: those were tried and
   * either oscillated (live reorder) or overrode the person's intent
   * (nearest-target rules).
   */
  function targetFrom(event: DragMoveEvent): { col: number; beforeId: WidgetId | null } | null {
    const translated = event.active.rect.current.translated;
    if (!boardEl || !translated) return null;
    const rect = boardEl.getBoundingClientRect();
    const slot = layout.find((s) => s.id === event.active.id);
    if (!slot) return null;
    const units = unitsFor(slot.size, totalUnits);
    const x = translated.left - rect.left;
    const y = translated.top - rect.top;
    const col = Math.max(0, Math.min(Math.round(x / (colWidth + BOARD_GAP)), totalUnits - units));
    // Who gets pushed down: the first widget in the target window whose
    // middle lies below the dragged card's top edge.
    const below = visible
      .filter((s) => s.id !== slot.id)
      .map((s) => ({ id: s.id, box: packed.boxes.get(s.id) }))
      .filter((e): e is { id: WidgetId; box: PackedBox } => e.box !== undefined)
      .filter(({ box }) => box.col < col + units && box.col + box.units > col)
      .sort((a, b) => a.box.top - b.box.top)
      .find(({ id, box }) => box.top + (heights[id] ?? 160) / 2 > y);
    return { col, beforeId: below?.id ?? null };
  }

  function onDragMove(event: DragMoveEvent) {
    const target = targetFrom(event);
    setDropTarget((prev) =>
      prev?.col === target?.col && prev?.beforeId === target?.beforeId ? prev : target,
    );
  }

  /** The layout as it will be if the drag ends now. */
  function layoutWithDrop(): WidgetSlot[] | null {
    if (!dragging || !dropTarget) return null;
    const active = layout.find((s) => s.id === dragging);
    if (!active) return null;
    const rest = layout.filter((s) => s.id !== dragging);
    const moved = { ...active, col: dropTarget.col };
    const at = dropTarget.beforeId ? rest.findIndex((s) => s.id === dropTarget.beforeId) : -1;
    if (at < 0) rest.push(moved);
    else rest.splice(at, 0, moved);
    return rest;
  }

  function onDragEnd() {
    const next = layoutWithDrop();
    setDragging(null);
    setDropTarget(null);
    if (next) updateLayout(next);
  }

  // The dashed box previews the exact landing spot: the hypothetical
  // layout is packed for real, so what you see is what you drop.
  const dropPreview = (() => {
    const next = layoutWithDrop();
    if (!next || !dragging) return null;
    return packBoard(toPackItems(next.filter(onBoard)), totalUnits, boardWidth, BOARD_GAP).boxes.get(
      dragging,
    );
  })();

  return (
    <Page
      title={t('Today')}
      eyebrow={formatDate(data.today)}
      action={
        editing ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => updateLayout(DEFAULT_LAYOUT.map((s) => ({ ...s })))}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink"
            >
              {t('Reset')}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setAdding(false);
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              {t('Done')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink"
          >
            {t('Customize')}
          </button>
        )
      }
    >
      <div className="space-y-5">
        <QuickActions />

        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setDragging(null);
            setDropTarget(null);
          }}
        >
          <div ref={setBoardEl} className="relative" style={{ height: packed.height }}>
            {boardWidth > 0 &&
              visible.map((slot) => {
                const box = packed.boxes.get(slot.id);
                if (!box) return null;
                return (
                  <BoardWidget
                    key={slot.id}
                    slot={slot}
                    editing={editing}
                    box={box}
                    onHeight={onHeight}
                    onSize={(size) =>
                      updateLayout(layout.map((s) => (s.id === slot.id ? { ...s, size } : s)))
                    }
                    onHide={() =>
                      updateLayout(
                        layout.map((s) => (s.id === slot.id ? { ...s, hidden: true } : s)),
                      )
                    }
                  >
                    {content[slot.id] ?? (
                      <div className="rounded-card border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
                        {t('Nothing here yet.')}
                      </div>
                    )}
                  </BoardWidget>
                );
              })}
            {dragging && dropPreview && (
              <div
                className="pointer-events-none absolute rounded-card border-2 border-dashed border-accent bg-accent/5"
                style={{
                  left: dropPreview.left,
                  top: dropPreview.top,
                  width: dropPreview.width,
                  height: heights[dragging] ?? 160,
                }}
              />
            )}
          </div>
          <DragOverlay>
            {dragging && (
              <div className="flex items-center gap-2 rounded-card border border-line bg-surface px-3 py-1.5 shadow-md">
                <svg
                  viewBox="0 0 24 24"
                  className="size-4 shrink-0 text-muted"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <path d="M4 9h16M4 15h16" />
                </svg>
                <span className="eyebrow">{WIDGET_DEFS[dragging].title}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {/* Always present while editing: a button that only appears once
            something can be added is a button nobody finds. */}
        {editing && (
          <div className="rounded-card border border-dashed border-line">
            {!adding ? (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="flex w-full items-center justify-center gap-2 px-4 py-3 text-sm text-muted transition-colors hover:text-ink"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
                {t('Add widget')}
              </button>
            ) : hidden.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                {hidden.map((slot) => (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => addWidget(slot.id)}
                    className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink transition-colors hover:border-accent"
                  >
                    + {WIDGET_DEFS[slot.id].title}
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-4 py-3 text-center text-sm text-muted">
                {t('All widgets are already on the board.')}
              </p>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
