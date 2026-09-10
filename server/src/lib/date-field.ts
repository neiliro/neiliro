import { z } from 'zod';

/*
  A date is not a shape (#250). `^\d{4}-\d{2}-\d{2}$` let `2026-13-45`
  through five routes, and the first `new Date(...).toISOString()` on it —
  in the recurrence expansion the dashboard and the calendar run — threw
  `RangeError: Invalid time value` for the whole family until the row was
  deleted. The browser's date inputs cannot produce such a value; the API
  can, and one member is enough.

  So the check parses and compares back: a real calendar date round-trips
  through the Date object unchanged, an impossible one does not.
*/

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^\d{2}:\d{2}$/;

export function isRealDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isRealTime(value: string): boolean {
  if (!TIME_SHAPE.test(value)) return false;
  const [h, m] = value.split(':').map(Number);
  return h! < 24 && m! < 60;
}

/** `YYYY-MM-DD`, and a day that exists. */
export const dateField = (message = 'Date must be YYYY-MM-DD') => z.string().refine(isRealDate, message);

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` — an event's wall-clock time. */
export const dateTimeField = (message = 'Date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM') =>
  z.string().refine((v) => {
    const [date, time, ...rest] = v.split('T');
    return rest.length === 0 && isRealDate(date!) && (time === undefined || isRealTime(time));
  }, message);

/** `YYYY-MM`, month 01–12. */
export const monthField = (message = 'Month must be YYYY-MM') =>
  z.string().refine((v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v), message);
