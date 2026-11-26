/**
 * Calendar files (`*.calendar`): JSON holding one calendar (see calendar-engine.ts for the model).
 *
 *   { "type": "calendar", "version": 1, "name": "Harptos", "default": true,
 *     "weekdays": [...], "months": [...], "leapDays": [...], "eras": [...],
 *     "firstWeekday": 0, "today": "15 Mirtul 1492 DR", "holidays": [...] }
 *
 * Keys the app doesn't know are kept. Pure functions, no Angular.
 */
import {
  CalendarDef,
  CalendarEra,
  CalendarHoliday,
  CalendarLeapDay,
  CalendarMonth,
} from './calendar-engine';
import { getFileExtension } from './vault-file-types';

export function isCalendarPath(path: string): boolean {
  return getFileExtension(path) === 'calendar';
}

export function parseCalendarFile(text: string): CalendarDef {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This calendar file isn’t valid JSON.');
  }
  if (!isRecord(raw) || (raw['type'] !== undefined && raw['type'] !== 'calendar')) throw new Error('This file isn’t a calendar.');
  const { type: _type, version: _version, ...data } = raw;

  const months = arr(data['months']).filter(isRecord).map(month => ({
    ...month,
    name: str(month['name']) || 'Month',
    days: Math.max(0, Math.floor(num(month['days']) ?? 30)),
    intercalary: month['intercalary'] === true,
    leap: str(month['leap']) || null,
    leapOffset: num(month['leapOffset']) ?? 0,
  } as CalendarMonth));
  if (!months.length) throw new Error('This calendar has no months.');

  return {
    ...data,
    name: str(data['name']) || 'Calendar',
    weekdays: arr(data['weekdays']).map(day => str(day)).filter(Boolean),
    months,
    leapDays: arr(data['leapDays']).filter(isRecord).map(leap => ({
      ...leap,
      month: str(leap['month']),
      interval: str(leap['interval']) || '4',
      offset: num(leap['offset']) ?? 0,
    } as CalendarLeapDay)),
    eras: arr(data['eras']).filter(isRecord).map(era => ({
      ...era,
      name: str(era['name']) || 'Era',
      abbr: str(era['abbr']),
      startYear: num(era['startYear']),
      endYear: num(era['endYear']),
      count: era['count'] === 'down' ? 'down' : 'up',
      prefix: era['prefix'] === true,
    } as CalendarEra)),
    firstWeekday: Math.max(0, Math.floor(num(data['firstWeekday']) ?? 0)),
    today: str(data['today']) || null,
    holidays: arr(data['holidays']).filter(isRecord).map(readHoliday),
    default: data['default'] === true,
  };
}

function readHoliday(holiday: Record<string, unknown>): CalendarHoliday {
  const date = isRecord(holiday['date']) ? holiday['date'] : {};
  return {
    ...holiday,
    id: str(holiday['id']) || newId(),
    name: str(holiday['name']) || 'Holiday',
    date: {
      month: str(date['month']),
      day: num(date['day']),
      weekday: num(date['weekday']),
      nth: num(date['nth']),
    },
    repeat: holiday['repeat'] === 'once' ? 'once' : 'yearly',
    year: num(holiday['year']),
    since: num(holiday['since']),
    until: num(holiday['until']),
    link: str(holiday['link']) || null,
    color: str(holiday['color']) || null,
  };
}

export function serializeCalendar(def: CalendarDef): string {
  const { name, default: isDefault, weekdays, months, leapDays, eras, firstWeekday, today, holidays, ...rest } = def;
  return `${JSON.stringify({
    type: 'calendar',
    version: 1,
    name,
    default: !!isDefault,
    weekdays,
    months,
    leapDays,
    eras,
    firstWeekday,
    today,
    holidays,
    ...rest,
  }, null, 2)}\n`;
}

/** Links a calendar makes (holidays → notes), for backlinks. */
export function calendarLinks(def: CalendarDef): { target: string; snippet: string }[] {
  return def.holidays.filter(holiday => !!holiday.link).map(holiday => ({ target: holiday.link!, snippet: `📅 ${holiday.name}` }));
}

export function calendarLinksFromText(text: string): { target: string; snippet: string }[] {
  try {
    return calendarLinks(parseCalendarFile(text));
  } catch {
    return [];
  }
}

export function newHolidayId(): string {
  return newId();
}

// ---- Presets ----

export interface CalendarPreset {
  id: string;
  name: string;
  description: string;
  build(): CalendarDef;
}

const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function months(spec: [string, number, boolean?][]): CalendarMonth[] {
  return spec.map(([name, days, intercalary]) => ({ name, days, intercalary: !!intercalary }));
}

function holiday(name: string, month: string, day: number, extra: Partial<CalendarHoliday> = {}): CalendarHoliday {
  return { id: newId(), name, date: { month, day }, repeat: 'yearly', link: null, color: null, ...extra };
}

function base(name: string, rest: Partial<CalendarDef>): CalendarDef {
  return {
    name,
    weekdays: [],
    months: [],
    leapDays: [],
    eras: [],
    firstWeekday: 0,
    today: null,
    holidays: [],
    default: false,
    ...rest,
  };
}

export const CALENDAR_PRESETS: readonly CalendarPreset[] = [
  {
    id: 'gregorian',
    name: 'Gregorian',
    description: 'The real-world calendar, with BC and AD.',
    build: () => base('Gregorian', {
      weekdays: WEEK,
      months: months([
        ['January', 31], ['February', 28], ['March', 31], ['April', 30], ['May', 31], ['June', 30],
        ['July', 31], ['August', 31], ['September', 30], ['October', 31], ['November', 30], ['December', 31],
      ]),
      leapDays: [{ month: 'February', interval: '400,!100,4', offset: 0 }],
      eras: [
        { name: 'Before Christ', abbr: 'BC', endYear: 0, count: 'down' },
        { name: 'Anno Domini', abbr: 'AD', startYear: 1, count: 'up' },
      ],
      // 1 January, AD 1 (proleptic Gregorian) was a Monday.
      firstWeekday: 1,
      holidays: [holiday('New Year’s Day', 'January', 1)],
    }),
  },
  {
    id: 'harptos',
    name: 'Harptos (Forgotten Realms)',
    description: 'Twelve 30-day months in tendays, five festival days, Shieldmeet every four years. Dalereckoning (DR).',
    build: () => base('Harptos', {
      weekdays: ['First-day', 'Second-day', 'Third-day', 'Fourth-day', 'Fifth-day', 'Sixth-day', 'Seventh-day', 'Eighth-day', 'Ninth-day', 'Tenth-day'],
      months: [
        ...months([['Hammer', 30], ['Midwinter', 1, true], ['Alturiak', 30], ['Ches', 30], ['Tarsakh', 30], ['Greengrass', 1, true],
          ['Mirtul', 30], ['Kythorn', 30], ['Flamerule', 30], ['Midsummer', 1, true]]),
        { name: 'Shieldmeet', days: 1, intercalary: true, leap: '4', leapOffset: 0 },
        ...months([['Eleasis', 30], ['Eleint', 30], ['Highharvestide', 1, true], ['Marpenoth', 30], ['Uktar', 30],
          ['Feast of the Moon', 1, true], ['Nightal', 30]]),
      ],
      eras: [
        { name: 'Before Dalereckoning', abbr: 'BDR', endYear: 0, count: 'down' },
        { name: 'Dalereckoning', abbr: 'DR', startYear: 1, count: 'up' },
      ],
      today: '1 Hammer 1492 DR',
      holidays: [],
    }),
  },
  {
    id: 'golarion',
    name: 'Absalom Reckoning (Golarion)',
    description: 'Pathfinder’s calendar: 12 months, a leap day in Calistril every eight years. AR.',
    build: () => base('Absalom Reckoning', {
      weekdays: ['Moonday', 'Toilday', 'Wealday', 'Oathday', 'Fireday', 'Starday', 'Sunday'],
      months: months([
        ['Abadius', 31], ['Calistril', 28], ['Pharast', 31], ['Gozran', 30], ['Desnus', 31], ['Sarenith', 30],
        ['Erastus', 31], ['Arodus', 31], ['Rova', 30], ['Lamashan', 31], ['Neth', 30], ['Kuthona', 31],
      ]),
      leapDays: [{ month: 'Calistril', interval: '8', offset: 0 }],
      eras: [{ name: 'Absalom Reckoning', abbr: 'AR', startYear: 1, count: 'up', prefix: false }],
      today: '1 Abadius 4724 AR',
      holidays: [holiday('Night of the Pale', 'Rova', 30)],
    }),
  },
  {
    id: 'exandria',
    name: 'Exandrian',
    description: 'Exandria’s 328-day year of 11 months. Post-Divergence (P.D.).',
    build: () => base('Exandrian', {
      weekdays: ['Miresen', 'Grissen', 'Whelsen', 'Conthsen', 'Folsen', 'Yulisen', 'Da’leysen'],
      months: months([
        ['Horisal', 29], ['Misuthar', 30], ['Dualahei', 30], ['Thunsheer', 31], ['Unndilar', 28], ['Brussendar', 31],
        ['Sydenstar', 32], ['Fessuran', 29], ['Quen’pillar', 27], ['Cuersaar', 29], ['Duscar', 32],
      ]),
      eras: [{ name: 'Post-Divergence', abbr: 'P.D.', startYear: 1, count: 'up' }],
      today: '1 Horisal 836 P.D.',
      holidays: [holiday('New Dawn', 'Horisal', 1)],
    }),
  },
  {
    id: 'greyhawk',
    name: 'Common Year (Greyhawk)',
    description: 'Twelve 28-day months and four festival weeks. Common Year (CY).',
    build: () => base('Common Year', {
      weekdays: ['Starday', 'Sunday', 'Moonday', 'Godsday', 'Waterday', 'Earthday', 'Freeday'],
      months: months([
        ['Needfest', 7], ['Fireseek', 28], ['Readying', 28], ['Coldeven', 28], ['Growfest', 7], ['Planting', 28],
        ['Flocktime', 28], ['Wealsun', 28], ['Richfest', 7], ['Reaping', 28], ['Goodmonth', 28], ['Harvester', 28],
        ['Brewfest', 7], ['Patchwall', 28], ['Ready’reat', 28], ['Sunsebb', 28],
      ]),
      eras: [{ name: 'Common Year', abbr: 'CY', startYear: 1, count: 'up' }],
      today: '1 Fireseek 576 CY',
    }),
  },
  {
    id: 'galifar',
    name: 'Galifar (Eberron)',
    description: 'Twelve 28-day months of four weeks. Years of the Kingdom (YK).',
    build: () => base('Galifar', {
      weekdays: ['Sul', 'Mol', 'Zol', 'Wir', 'Zor', 'Far', 'Sar'],
      months: months([
        ['Zarantyr', 28], ['Olarune', 28], ['Therendor', 28], ['Eyre', 28], ['Dravago', 28], ['Nymm', 28],
        ['Lharvion', 28], ['Barrakas', 28], ['Rhaan', 28], ['Sypheros', 28], ['Aryth', 28], ['Vult', 28],
      ]),
      eras: [{ name: 'Years of the Kingdom', abbr: 'YK', startYear: 1, count: 'up' }],
      today: '1 Zarantyr 998 YK',
    }),
  },
  {
    id: 'simple',
    name: 'Simple 12 × 30',
    description: 'Twelve months of 30 days and a 7-day week, ready to rename.',
    build: () => base('Calendar', {
      weekdays: ['Firstday', 'Seconday', 'Thirdday', 'Fourthday', 'Fifthday', 'Sixthday', 'Seventhday'],
      months: months(Array.from({ length: 12 }, (_, i) => [`Month ${i + 1}`, 30] as [string, number])),
      eras: [{ name: 'Age', abbr: 'AE', startYear: 1, count: 'up' }],
      today: '1 Month 1 1 AE',
    }),
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'One month and no weekdays. Build your own.',
    build: () => base('Calendar', {
      months: months([['First Month', 30]]),
      eras: [],
    }),
  },
];

// ---- Helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}
