import { describe, expect, it } from 'vitest';
import { looksLikeIcs, parseIcs } from './ics';

/*
  The shapes real invitations take: a Google-style timed event in UTC, an
  all-day event with the exclusive DTEND, a DURATION instead of DTEND, a
  folded and escaped DESCRIPTION, and a recurring one whose rule is only
  reported. Times in UTC are asserted through Date so the test does not
  depend on the machine's zone.
*/

const pad = (n: number) => String(n).padStart(2, '0');
function local(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

const GOOGLE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'DTSTART:20261015T120000Z',
  'DTEND:20261015T130000Z',
  'DTSTAMP:20260914T100000Z',
  'UID:abc123@google.com',
  'SUMMARY:Parent-teacher meeting\\, 3B',
  'LOCATION:Riverside School\; room 12',
  'DESCRIPTION:Please bring the consent form.\\nSecond line that is long en',
  ' ough to be folded onto the next line by the sender.',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcs', () => {
  it('reads a Google-style invitation, unfolding and unescaping on the way', () => {
    const [ev] = parseIcs(GOOGLE);
    expect(ev).toBeDefined();
    const start = local('2026-10-15T12:00:00Z');
    const end = local('2026-10-15T13:00:00Z');
    expect(ev!.title).toBe('Parent-teacher meeting, 3B');
    expect(ev!.location).toBe('Riverside School; room 12');
    expect(ev!.description).toBe(
      'Please bring the consent form.\nSecond line that is long enough to be folded onto the next line by the sender.',
    );
    expect(ev!.all_day).toBe(false);
    expect(ev!.start_date).toBe(start.date);
    expect(ev!.start_time).toBe(start.time);
    expect(ev!.end_time).toBe(end.time);
    expect(ev!.rrule).toBeNull();
  });

  it('turns an all-day range into inclusive dates', () => {
    const [ev] = parseIcs(
      'BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261224\nDTEND;VALUE=DATE:20261227\nSUMMARY:Ski camp\nEND:VEVENT',
    );
    expect(ev).toMatchObject({ all_day: true, start_date: '2026-12-24', end_date: '2026-12-26', start_time: '', end_time: '' });
  });

  it('takes a TZID time as wall-clock and a DURATION as the end', () => {
    const [ev] = parseIcs(
      'BEGIN:VEVENT\nDTSTART;TZID="Europe/Belgrade":20261103T083000\nDURATION:PT1H30M\nSUMMARY:Dentist\nEND:VEVENT',
    );
    expect(ev).toMatchObject({ all_day: false, start_date: '2026-11-03', start_time: '08:30', end_time: '10:00' });
  });

  it('reports a recurrence rule rather than expanding it, and skips an event without a start', () => {
    const events = parseIcs(
      [
        'BEGIN:VEVENT',
        'SUMMARY:No start here',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'DTSTART:20260901T160000',
        'RRULE:FREQ=WEEKLY;BYDAY=TU',
        'SUMMARY:Swimming',
        'END:VEVENT',
      ].join('\n'),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: 'Swimming', rrule: 'FREQ=WEEKLY;BYDAY=TU', end_time: '17:00' });
  });
});

describe('looksLikeIcs', () => {
  it('recognises the mime types and the extension', () => {
    expect(looksLikeIcs('text/calendar', 'attachment')).toBe(true);
    expect(looksLikeIcs('application/ics', 'invite.ics')).toBe(true);
    expect(looksLikeIcs('application/octet-stream', 'Invitation.ICS')).toBe(true);
    expect(looksLikeIcs('application/pdf', 'bill.pdf')).toBe(false);
  });
});
