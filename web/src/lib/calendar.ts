import { t } from './i18n';
import { loadLocal as loadStored, saveLocal as saveStored } from './storage';

/** The default calendar — the only one with an id known in advance (migration 006). */
export const SHARED_CALENDAR_ID = '00000000-0000-4000-8000-000000000201';

/**
 * Calendar name for display. The seeded name is data, not UI, so the t()
 * dictionary never sees it. There is one such calendar with a fixed id —
 * translate in place, same as projectTitle does for the Inbox in tasks.ts.
 * 'Общий' is matched for databases that predate migration 013; a calendar
 * renamed by the user keeps its custom name.
 */
export function calendarName(id: string, name: string): string {
  return id === SHARED_CALENDAR_ID && (name === 'Shared' || name === 'Общий')
    ? t('Shared')
    : name;
}

export interface Calendar {
  id: string;
  name: string;
  color: string;
  owner_id: string | null;
  shared: number;
  position: number;
  event_count: number;
}

export interface Participant {
  id: string;
  name: string;
  color: string;
}

/** One instance of an event: a recurring series has many. */
export interface Occurrence {
  id: string;
  event_id: string;
  date: string;
  starts_at: string;
  ends_at: string;
  title: string;
  description: string | null;
  location: string | null;
  all_day: number;
  is_recurring: boolean;
  calendar_id: string;
  calendar_name: string;
  calendar_color: string;
  project_id: string | null;
  project_title: string | null;
  remind_days_before: number | null;
  age: number | null;
  participants: Participant[];
}

/**
 * A birthday occurrence is a person's name plus an age, and the age renders as
 * a bare number beside the title: 'Alex  38' is a riddle in a month cell. The
 * cake solves it at a glance; this label says the same for hover and for
 * screen readers, out of keys the dictionary already has.
 */
export function birthdayLabel(o: Pick<Occurrence, 'title' | 'age'>): string | null {
  if (o.age === null) return null;
  return `${t('Birthday')}: ${o.title}, ${t('{n} years old', { n: o.age })}`;
}

export type CalendarView = 'week' | 'month' | 'agenda';

export const VIEW_LABEL: Record<CalendarView, string> = {
  week: t('Week'),
  month: t('Month'),
  agenda: t('Agenda'),
};

export const REMIND_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: t('No reminder') },
  { value: '1', label: t('A day before') },
  { value: '3', label: t('Three days before') },
  { value: '7', label: t('A week before') },
  { value: '14', label: t('Two weeks before') },
  { value: '30', label: t('A month before') },
];

/**
 * View settings live on the device, not in the DB.
 * The kiosk always shows the week, the phone is better with the agenda —
 * these are different preferences of the same person, not one shared one.
 */
export function loadLocal<T>(key: string, fallback: T): T {
  return loadStored(`hub.calendar.${key}`, fallback);
}

export function saveLocal(key: string, value: unknown): void {
  saveStored(`hub.calendar.${key}`, value);
}
