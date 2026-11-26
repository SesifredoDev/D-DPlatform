import { CalendarEngine } from './calendar-engine';
import { CALENDAR_PRESETS, parseCalendarFile, serializeCalendar } from './vault-calendar';

const preset = (id: string) => new CalendarEngine(CALENDAR_PRESETS.find(item => item.id === id)!.build());
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

describe('Gregorian (checked against real dates)', () => {
  const cal = preset('gregorian');
  const on = (text: string) => cal.parse(text)!.date;

  it('has the right leap years', () => {
    expect(cal.yearLength(2000)).toBe(366);
    expect(cal.yearLength(1900)).toBe(365);
    expect(cal.yearLength(2024)).toBe(366);
    expect(cal.yearLength(2023)).toBe(365);
    expect(cal.daysInMonth(2024, 1)).toBe(29);
  });

  it('gets weekdays right', () => {
    expect(WEEK[cal.weekday(on('1 January 2000 AD'))!]).toBe('Saturday');
    expect(WEEK[cal.weekday(on('4 July 1776 AD'))!]).toBe('Thursday');
    expect(WEEK[cal.weekday(on('25 December 2026 AD'))!]).toBe('Friday');
    expect(WEEK[cal.weekday(on('1 January 1 AD'))!]).toBe('Monday');
  });

  it('counts BC down with no year zero', () => {
    const lastBc = on('31 December 1 BC');
    expect(lastBc.year).toBe(0);
    expect(cal.format(cal.addDays(lastBc, 1))).toBe('1 January 1 AD');
    expect(cal.format(on('15 March 44 BC'))).toBe('15 March 44 BC');
    expect(cal.compare(on('1 January 44 BC'), on('1 January 43 BC'))).toBeLessThan(0);
    // Ides of March 44 BC to 1 January AD 1: 292 days left in 44 BC, then 43 years with 11 leap years.
    expect(cal.toDayNumber(on('1 January 1 AD')) - cal.toDayNumber(on('15 March 44 BC'))).toBe(292 + 43 * 365 + 11);
  });

  it('round-trips day numbers across eras', () => {
    for (const n of [-100000, -1, 0, 1, 365, 730000]) {
      expect(cal.toDayNumber(cal.fromDayNumber(n))).toBe(n);
    }
  });
});

describe('Harptos', () => {
  const cal = preset('harptos');

  it('adds Shieldmeet every four years and keeps festivals out of the week', () => {
    expect(cal.yearLength(1491)).toBe(365);
    expect(cal.yearLength(1492)).toBe(366);
    const midwinter = cal.parse('Midwinter 1492 DR')!;
    expect(midwinter.precision).toBe('day');
    expect(cal.weekday(midwinter.date)).toBeNull();
    // Tendays line up with every month: the 1st is always First-day.
    for (const month of ['Hammer', 'Alturiak', 'Mirtul', 'Nightal']) {
      expect(cal.weekday(cal.parse(`1 ${month} 1492 DR`)!.date)).toBe(0);
    }
    expect(cal.format(cal.addDays(cal.parse('30 Hammer 1492 DR')!.date, 1))).toBe('Midwinter 1492 DR');
    expect(cal.parse('Shieldmeet 1491 DR')).toBeNull();
    expect(cal.format(cal.parse('Shieldmeet 1492 DR')!.date)).toBe('Shieldmeet 1492 DR');
  });
});

describe('parsing', () => {
  const cal = preset('harptos');

  it('reads the usual ways of writing a date', () => {
    const expected = '15 Mirtul 1492 DR';
    for (const text of ['15 Mirtul 1492 DR', 'Mirtul 15, 1492 DR', 'the 15th of Mirtul, 1492 DR', 'Fifth-day, 15 Mirtul 1492', '1492-07-15']) {
      expect(cal.format(cal.parse(text)!.date)).toBe(expected);
    }
    expect(cal.parse('Mirtul 1492 DR')).toMatchObject({ precision: 'month' });
    expect(cal.parse('1492 DR')).toMatchObject({ precision: 'year' });
  });

  it('puts a date without a year in the campaign’s current year', () => {
    expect(cal.format(cal.parse('Mirtul 15')!.date)).toBe('15 Mirtul 1492 DR');
  });

  it('rejects dates that don’t exist', () => {
    expect(cal.parse('31 Mirtul 1492 DR')).toBeNull();
    expect(cal.parse('15 Frostmoon 1492')).toBeNull();
    expect(cal.parse('next Tuesday')).toBeNull();
    expect(cal.parse('')).toBeNull();
  });

  it('reads dates before an era as the earlier era', () => {
    const date = cal.parse('1 Hammer 10 BDR')!.date;
    expect(date.year).toBe(-9);
    expect(cal.formatYear(0)).toBe('1 BDR');
  });
});

describe('relative dates', () => {
  const cal = preset('harptos');
  const anchor = cal.parse('28 Hammer 1492 DR')!.date;

  it('moves from an earlier date or from today', () => {
    expect(cal.format(cal.parseRelative('3 days later', anchor)!.date)).toBe('Midwinter 1492 DR');
    expect(cal.format(cal.parseRelative('the next day', anchor)!.date)).toBe('29 Hammer 1492 DR');
    expect(cal.format(cal.parseRelative('two tendays after', anchor)!.date)).toBe('17 Alturiak 1492 DR');
    expect(cal.format(cal.parseRelative('a month before', anchor)!.date)).toBe('28 Nightal 1491 DR');
    expect(cal.format(cal.parseRelative('1 year later', anchor)!.date)).toBe('28 Hammer 1493 DR');
    expect(cal.format(cal.parseRelative('today', null)!.date)).toBe('1 Hammer 1492 DR');
    expect(cal.parseRelative('3 days later', null)).toBeNull();
    expect(cal.relativeToToday(cal.parse('11 Hammer 1492 DR')!.date)).toBe('in 10 days');
  });
});

describe('holidays', () => {
  it('finds fixed and nth-weekday holidays within their years', () => {
    const def = CALENDAR_PRESETS.find(item => item.id === 'gregorian')!.build();
    def.holidays.push(
      { id: 't', name: 'Thanksgiving', date: { month: 'November', weekday: 4, nth: 4 }, repeat: 'yearly' },
      { id: 'o', name: 'Coronation', date: { month: 'June', day: 2 }, repeat: 'once', year: 1953 },
      { id: 's', name: 'Founders', date: { month: 'May', weekday: 1, nth: -1 }, repeat: 'yearly', since: 2000 },
    );
    const cal = new CalendarEngine(def);
    expect(cal.format(cal.holidayDate(def.holidays[1], 2026)!)).toBe('26 November 2026 AD');
    expect(cal.holidayDate(def.holidays[2], 1953)).not.toBeNull();
    expect(cal.holidayDate(def.holidays[2], 1954)).toBeNull();
    expect(cal.format(cal.holidayDate(def.holidays[3], 2026)!)).toBe('25 May 2026 AD');
    expect(cal.holidayDate(def.holidays[3], 1999)).toBeNull();
    expect(cal.holidaysOn(cal.parse('1 January 2026 AD')!.date).map(h => h.name)).toEqual(['New Year’s Day']);
  });
});

describe('calendar files', () => {
  it('round-trips every preset and keeps unknown keys', () => {
    for (const preset of CALENDAR_PRESETS) {
      const def = { ...preset.build(), theme: 'parchment' };
      const once = parseCalendarFile(serializeCalendar(def));
      expect(parseCalendarFile(serializeCalendar(once))).toEqual(once);
      expect(once['theme']).toBe('parchment');
      expect(once.months.map(month => [month.name, month.days])).toEqual(def.months.map(month => [month.name, month.days]));
      expect(once.eras).toEqual(def.eras.map(era => expect.objectContaining({ name: era.name, abbr: era.abbr, count: era.count })));
    }
  });

  it('rejects other files', () => {
    expect(() => parseCalendarFile('{ nope')).toThrow(/valid JSON/);
    expect(() => parseCalendarFile('{"type":"map"}')).toThrow(/isn’t a calendar/);
    expect(() => parseCalendarFile('{"type":"calendar","months":[]}')).toThrow(/no months/);
  });

  it('gives every preset a today that parses', () => {
    for (const preset of CALENDAR_PRESETS) {
      const def = preset.build();
      if (def.today) expect(new CalendarEngine(def).today()).not.toBeNull();
    }
  });
});
