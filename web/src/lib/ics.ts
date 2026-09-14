/*
  The half of an invitation the calendar can use (#29, #30): a VEVENT's
  title, place, description and when. Parsed in the browser, because the
  file arrives sealed like every other attachment and the server never
  reads a person's words (ADR 0001).

  Deliberately small. It reads what school, doctor and booking systems
  send — one or a few VEVENTs, DTSTART/DTEND or DURATION, VALUE=DATE for
  all-day, "Z" for UTC — and turns each into the draft the event dialog
  already understands. What it does not do: time-zone tables (a TZID
  time is taken as wall-clock, which is what a family in that zone
  wants), recurrence (an RRULE is reported, not expanded — the person
  decides), attendee bookkeeping, REPLY/CANCEL methods.
*/

export interface IcsEvent {
  title: string;
  description: string;
  location: string;
  all_day: boolean;
  /** YYYY-MM-DD */
  start_date: string;
  /** YYYY-MM-DD, inclusive (an all-day DTEND is exclusive in the file and is moved back a day) */
  end_date: string;
  /** HH:MM, local wall-clock; empty for all-day */
  start_time: string;
  end_time: string;
  /** The RRULE line as written, or null — shown to the person, never applied blindly */
  rrule: string | null;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** RFC 5545 line folding: a line starting with a space or tab continues the previous one. */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out.filter((l) => l.length > 0);
}

function parseLine(line: string): Prop | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  // Parameters may themselves contain quoted colons (TZID="Europe/Berlin")
  let i = 0;
  let inQuotes = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) break;
  }
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...paramParts] = head.split(';');
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: (name ?? '').toUpperCase(), params, value };
}

/** TEXT values escape commas, semicolons, backslashes and newlines. */
function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
}

interface When {
  date: string;
  time: string;
  allDay: boolean;
  ms: number;
}

/** 20261015, 20261015T140000 or 20261015T120000Z → the family's wall-clock. */
function parseWhen(p: Prop): When | null {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = p.params.VALUE === 'DATE' || hh === undefined;
  if (allDay) {
    const local = new Date(Number(y), Number(mo) - 1, Number(d));
    return { date: `${y}-${mo}-${d}`, time: '', allDay: true, ms: local.getTime() };
  }
  const dt = z
    ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss ?? 0)))
    : new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss ?? 0));
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
    allDay: false,
    ms: dt.getTime(),
  };
}

/** PT1H30M, P1D, PT45M → milliseconds. */
function parseDuration(v: string): number | null {
  const m = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, w, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return ((((w ?? 0) * 7 + (d ?? 0)) * 24 + (h ?? 0)) * 60 + (mi ?? 0)) * 60_000 + (s ?? 0) * 1000;
}

function fromMs(ms: number, allDay: boolean): { date: string; time: string } {
  const dt = new Date(ms);
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    time: allDay ? '' : `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
  };
}

/** Every VEVENT in the file, in order. An unreadable one is skipped rather than failing the rest. */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: Prop[] | null = null;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      current = [];
      continue;
    }
    if (/^END:VEVENT$/i.test(line)) {
      if (current) {
        const ev = build(current);
        if (ev) events.push(ev);
      }
      current = null;
      continue;
    }
    if (current) {
      const p = parseLine(line);
      if (p) current.push(p);
    }
  }
  return events;
}

function build(props: Prop[]): IcsEvent | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const startProp = get('DTSTART');
  if (!startProp) return null;
  const start = parseWhen(startProp);
  if (!start) return null;

  let endMs: number;
  const endProp = get('DTEND');
  const durationProp = get('DURATION');
  const end = endProp ? parseWhen(endProp) : null;
  if (end) endMs = end.ms;
  else if (durationProp && parseDuration(durationProp.value) !== null) endMs = start.ms + parseDuration(durationProp.value)!;
  else endMs = start.allDay ? start.ms : start.ms + 60 * 60_000;
  // An all-day DTEND names the day after the last day; the dialog wants the last day
  if (start.allDay && endMs > start.ms) endMs -= 24 * 60 * 60_000;

  const endParts = fromMs(endMs, start.allDay);
  return {
    title: unescapeText(get('SUMMARY')?.value ?? '') || '(no title)',
    description: unescapeText(get('DESCRIPTION')?.value ?? ''),
    location: unescapeText(get('LOCATION')?.value ?? ''),
    all_day: start.allDay,
    start_date: start.date,
    end_date: endParts.date < start.date ? start.date : endParts.date,
    start_time: start.time,
    end_time: start.allDay ? '' : endParts.time,
    rrule: get('RRULE')?.value ?? null,
  };
}

/** Whether an attachment is worth offering the calendar button for. */
export function looksLikeIcs(mime: string | undefined, filename: string): boolean {
  const m = (mime ?? '').toLowerCase();
  return m === 'text/calendar' || m === 'application/ics' || /\.ics$/i.test(filename);
}
