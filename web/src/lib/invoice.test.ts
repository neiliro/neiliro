import { describe, expect, it } from 'vitest';
import { detectAmount, looksLikeReceipt } from './invoice';

describe('detectAmount', () => {
  it('reads a total next to a currency in the common spellings', () => {
    expect(detectAmount('Your bill is 64.20 EUR. Due by the 25th.')).toEqual({ minor: 6420, currency: 'EUR' });
    expect(detectAmount('Итого к оплате: 1 234,56 €')).toEqual({ minor: 123456, currency: 'EUR' });
    expect(detectAmount('Total: $1,299.00')).toEqual({ minor: 129900, currency: 'USD' });
    expect(detectAmount('Ukupno za uplatu 4.500,00 RSD')).toEqual({ minor: 450000, currency: 'RSD' });
    expect(detectAmount('Gesamt 89,90 EUR inkl. MwSt')).toEqual({ minor: 8990, currency: 'EUR' });
  });

  it('prefers the labelled total over larger line items and ignores bare numbers', () => {
    const body = ['Water 12.00 EUR', 'Heating 140.00 EUR', 'Discount -20.00 EUR', 'Total 132.00 EUR', 'Ref 998877 · 14:30'].join('\n');
    expect(detectAmount(body)).toEqual({ minor: 13200, currency: 'EUR' });
    expect(detectAmount('Meeting at 14:30, room 12.50')).toBeNull();
    expect(detectAmount('Order 12345 confirmed')).toBeNull();
  });

  it('takes the largest when nothing is labelled', () => {
    expect(detectAmount('Deposit 50 EUR, remainder 250 EUR')).toEqual({ minor: 25000, currency: 'EUR' });
  });
});

describe('looksLikeReceipt', () => {
  it('accepts documents and images, not calendars or text', () => {
    expect(looksLikeReceipt('application/pdf', 'invoice.pdf')).toBe(true);
    expect(looksLikeReceipt('image/jpeg', 'scan.jpg')).toBe(true);
    expect(looksLikeReceipt('text/calendar', 'invite.ics')).toBe(false);
    expect(looksLikeReceipt('text/plain', 'notes.txt')).toBe(false);
  });
});
