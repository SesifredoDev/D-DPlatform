/**
 * Calendar maths for custom (fantasy) calendars: months, weekdays, leap rules, intercalary days,
 * eras (BC/AD-style counting), holidays, formatting and parsing.
 *
 * Years are one continuous internal number (…, -1, 0, 1, 2, …); eras only change how a year is
 * shown. For BC/AD: "BC" counts down and ends at year 0, "AD" counts up from year 1, so internal
 * year 0 shows as "1 BC" and there is no "year 0". Dates are exact: every date maps to a day number
 * (year 1, first month, day 1 = day 0), so ordering and durations work across eras.
 *
 * Intercalary months (Harptos' festivals) don't advance the weekday. Leap rules use the
 * Fantasy-Calendar style: "400,!100,4" = leap every 4 years, except every 100, but every 400.
 *
 * Pure, no Angular.
 */

export interface CalendarMonth {
  name: string;
  days: number;
  /** Outside the week: these days have no weekday (festival days). */
  intercalary?: boolean;
  /** The month only exists in leap years by this rule (e.g. Shieldmeet: "4"). */
  leap?: string | null;
  /** Offset for `leap` (years counted from). */
  leapOffset?: number;
  [key: string]: unknown;
}

export interface CalendarLeapDay {
  /** Name of the month that gets the extra day. */
  month: string;
  /** "4", or "400,!100,4" (see above). */
  interval: string;
  offset?: number;
  [key: string]: unknown;
}

export interface CalendarEra {
  name: string;
  abbr: string;
  /** Counting up: the era's year 1 is this internal year. */
  startYear?: number | null;
  /** Counting down: the era's year 1 is this internal year (the last one). */
  endYear?: number | null;
  count: 'up' | 'down';
  /** Write the era before the year ("AR 4723") instead of after ("1492 DR"). */
  prefix?: boolean;
  [key: string]: unknown;
}

export interface HolidayDate {
  /** Month name. */
  month: string;
  /** A fixed day of the month… */
  day?: number | null;
  /** …or the nth (1–5, or -1 = last) of this weekday (index) in the month. */
  weekday?: number | null;
  nth?: number | null;
}

export interface CalendarHoliday {
  id: string;
  name: string;
  date: HolidayDate;
  repeat: 'yearly' | 'once';
  /** For `once`: the internal year. */
  year?: number | null;
  /** First and last internal years it's observed (inclusive); null = always. */
  since?: number | null;
  until?: number | null;
  /** Wikilink to a note about it. */
  link?: string | null;
  color?: string | null;
  [key: string]: unknown;
}

export interface CalendarDate {
  /** Internal year (see top). */
  year: number;
  /** Index into the calendar's months. */
  month: number;
  /** 1-based day of the month. */
  day: number;
}

export type DatePrecision = 'day' | 'month' | 'year';

export interface ParsedDate {
  date: CalendarDate;
  precision: DatePrecision;
}

export interface CalendarDef {
  name: string;
  weekdays: string[];
  months: CalendarMonth[];
  leapDays: CalendarLeapDay[];
  eras: CalendarEra[];
  /** Weekday index of year 1, first month, day 1. */
  firstWeekday: number;
  /** The campaign's current date, written as text in this calendar ("15 Mirtul 1492 DR"). */
  today: string | null;
  holidays: CalendarHoliday[];
  /** The vault's default calendar. */
  default?: boolean;
  [key: string]: unknown;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

export class CalendarEngine {
  private readonly yearStarts = new Map<number, number>([[1, 0]]);
  private readonly weekStarts = new Map<number, number>([[1, 0]]);
  private readonly leapCache = new Map<string, { n: number; leap: boolean }[]>();
  private todayCache: { text: string; date: CalendarDate | null } | null = null;
  private resolvingToday = false;

  constructor(readonly def: CalendarDef) {}

  // ---- Years and months ----

  isLeap(interval: string | null | undefined, offset: number, year: number): boolean {
    if (!interval) return false;
    let rules = this.leapCache.get(interval);
    if (!rules) {
      rules = interval
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => ({ n: Math.abs(parseInt(part.replace('!', ''), 10)), leap: !part.startsWith('!') }))
        .filter(rule => rule.n > 0)
        .sort((a, b) => b.n - a.n);
      this.leapCache.set(interval, rules);
    }
    for (const rule of rules) {
      if (mod(year - offset, rule.n) === 0) return rule.leap;
    }
    return false;
  }

  /** Days in a month that year (0 when the month doesn't exist that year). */
  daysInMonth(year: number, monthIndex: number): number {
    const month = this.def.months[monthIndex];
    if (!month) return 0;
    if (month.leap && !this.isLeap(month.leap, month.leapOffset ?? 0, year)) return 0;
    let days = month.days;
    for (const leap of this.def.leapDays) {
      if (sameName(leap.month, month.name) && this.isLeap(leap.interval, leap.offset ?? 0, year)) days++;
    }
    return days;
  }

  yearLength(year: number): number {
    let total = 0;
    for (let i = 0; i < this.def.months.length; i++) total += this.daysInMonth(year, i);
    return total;
  }

  /** Days of a year that count towards the week (not intercalary). */
  private weekLength(year: number): number {
    let total = 0;
    this.def.months.forEach((month, i) => {
      if (!month.intercalary) total += this.daysInMonth(year, i);
    });
    return total;
  }

  /** Day number of the first day of a year. */
  yearStart(year: number): number {
    return this.cumulative(this.yearStarts, year, y => this.yearLength(y));
  }

  private weekStart(year: number): number {
    return this.cumulative(this.weekStarts, year, y => this.weekLength(y));
  }

  private cumulative(cache: Map<number, number>, year: number, length: (year: number) => number): number {
    const cached = cache.get(year);
    if (cached !== undefined) return cached;
    if (year > 1) {
      let y = year - 1;
      while (!cache.has(y)) y--;
      let value = cache.get(y)!;
      for (; y < year; y++) {
        value += length(y);
        cache.set(y + 1, value);
      }
      return value;
    }
    let y = year + 1;
    while (!cache.has(y)) y++;
    let value = cache.get(y)!;
    for (; y > year; y--) {
      value -= length(y - 1);
      cache.set(y - 1, value);
    }
    return value;
  }

  /** The months that exist in a year, with their day counts. */
  monthsOf(year: number): { index: number; month: CalendarMonth; days: number }[] {
    return this.def.months
      .map((month, index) => ({ index, month, days: this.daysInMonth(year, index) }))
      .filter(item => item.days > 0);
  }

  // ---- Dates ----

  isValid(date: CalendarDate): boolean {
    return Number.isInteger(date.year) && date.day >= 1 && date.day <= this.daysInMonth(date.year, date.month);
  }

  toDayNumber(date: CalendarDate): number {
    let n = this.yearStart(date.year);
    for (let i = 0; i < date.month; i++) n += this.daysInMonth(date.year, i);
    return n + date.day - 1;
  }

  fromDayNumber(n: number): CalendarDate {
    const average = this.averageYearLength();
    let year = Math.floor(n / average) + 1;
    while (this.yearStart(year) > n) year--;
    while (this.yearStart(year + 1) <= n) year++;
    let rest = n - this.yearStart(year);
    for (let i = 0; i < this.def.months.length; i++) {
      const days = this.daysInMonth(year, i);
      if (rest < days) return { year, month: i, day: rest + 1 };
      rest -= days;
    }
    return { year, month: this.def.months.length - 1, day: 1 };
  }

  private averageYearLength(): number {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8, 100, 400].map(year => this.yearLength(year));
    return Math.max(1, sample.reduce((a, b) => a + b, 0) / sample.length);
  }

  /** Weekday index, or null for intercalary days (and calendars without weekdays). */
  weekday(date: CalendarDate): number | null {
    const weekdays = this.def.weekdays.length;
    const month = this.def.months[date.month];
    if (!weekdays || !month || month.intercalary) return null;
    let n = this.weekStart(date.year);
    for (let i = 0; i < date.month; i++) {
      if (!this.def.months[i].intercalary) n += this.daysInMonth(date.year, i);
    }
    return mod(this.def.firstWeekday + n + date.day - 1, weekdays);
  }

  compare(a: CalendarDate, b: CalendarDate): number {
    return this.toDayNumber(a) - this.toDayNumber(b);
  }

  addDays(date: CalendarDate, days: number): CalendarDate {
    return this.fromDayNumber(this.toDayNumber(date) + days);
  }

  /** Moves by whole months (skipping months that don't exist that year); the day is kept if it fits. */
  addMonths(date: CalendarDate, months: number): CalendarDate {
    let { year, month } = date;
    const step = Math.sign(months);
    let left = Math.abs(months);
    while (left > 0) {
      month += step;
      if (month >= this.def.months.length) {
        month = 0;
        year++;
      } else if (month < 0) {
        month = this.def.months.length - 1;
        year--;
      }
      if (this.daysInMonth(year, month) > 0) left--;
    }
    return { year, month, day: Math.min(date.day, this.daysInMonth(year, month)) };
  }

  addYears(date: CalendarDate, years: number): CalendarDate {
    const year = date.year + years;
    let month = date.month;
    if (!this.daysInMonth(year, month)) month = this.monthsOf(year)[0]?.index ?? 0;
    return { year, month, day: Math.min(date.day, Math.max(1, this.daysInMonth(year, month))) };
  }

  /** The campaign's "today", if set and valid. */
  today(): CalendarDate | null {
    const text = this.def.today;
    if (!text) return null;
    if (this.todayCache?.text === text) return this.todayCache.date;
    // Reading "today" uses the parser, which may ask for today's year: don't loop.
    if (this.resolvingToday) return null;
    this.resolvingToday = true;
    try {
      const date = this.parse(text)?.date ?? null;
      this.todayCache = { text, date };
      return date;
    } finally {
      this.resolvingToday = false;
    }
  }

  // ---- Eras ----

  /** The era a year belongs to and its year number in that era. */
  eraOf(year: number): { era: CalendarEra | null; year: number } {
    let best: { era: CalendarEra; year: number; key: number } | null = null;
    for (const era of this.def.eras) {
      if (era.count === 'up' && era.startYear != null && year >= era.startYear && (era.endYear == null || year <= era.endYear)) {
        if (!best || era.startYear > best.key) best = { era, year: year - era.startYear + 1, key: era.startYear };
      } else if (era.count === 'down' && era.endYear != null && year <= era.endYear && (era.startYear == null || year >= era.startYear)) {
        if (!best) best = { era, year: era.endYear - year + 1, key: -Infinity };
      }
    }
    return best ? { era: best.era, year: best.year } : { era: null, year };
  }

  /** Internal year for a year number in an era. */
  fromEraYear(displayYear: number, era: CalendarEra | null): number {
    if (!era) return displayYear;
    if (era.count === 'down' && era.endYear != null) return era.endYear - displayYear + 1;
    return (era.startYear ?? 1) + displayYear - 1;
  }

  /** The era years are read in when none is written: today's era, else the latest counting-up one. */
  defaultEra(): CalendarEra | null {
    const today = this.def.today ? this.parseLoose(this.def.today, null) : null;
    if (today) return this.eraOf(today.date.year).era;
    const up = this.def.eras.filter(era => era.count === 'up');
    return up.sort((a, b) => (b.startYear ?? 0) - (a.startYear ?? 0))[0] ?? this.def.eras[0] ?? null;
  }

  formatYear(year: number): string {
    const { era, year: shown } = this.eraOf(year);
    if (!era) return String(year);
    return era.prefix ? `${era.abbr} ${shown}` : `${shown} ${era.abbr}`;
  }

  // ---- Formatting ----

  monthName(index: number): string {
    return this.def.months[index]?.name ?? '';
  }

  /** "15 Mirtul 1492 DR", "Mirtul 1492 DR", "1492 DR"; one-day festivals read "Midwinter 1492 DR". */
  format(date: CalendarDate, precision: DatePrecision = 'day'): string {
    const year = this.formatYear(date.year);
    if (precision === 'year') return year;
    const month = this.monthName(date.month);
    if (precision === 'month' || this.daysInMonth(date.year, date.month) === 1) return `${month} ${year}`;
    return `${date.day} ${month} ${year}`;
  }

  /** "Godsday, 15 Mirtul 1492 DR" (no weekday on festival days). */
  formatLong(date: CalendarDate): string {
    const weekday = this.weekday(date);
    const text = this.format(date);
    return weekday === null ? text : `${this.def.weekdays[weekday]}, ${text}`;
  }

  // ---- Parsing ----

  /**
   * Reads a date written in this calendar: "15 Mirtul 1492 DR", "Mirtul 15, 1492", "the 15th of
   * Mirtul, 1492 DR", "Midwinter 1492", "Mirtul 1492" (a month), "1492 DR" (a year), "1492-05-15",
   * with an optional weekday in front. Null when it isn't a valid date in this calendar.
   */
  parse(text: string): ParsedDate | null {
    return this.parseLoose(text, this.defaultEra());
  }

  private parseLoose(text: string, fallbackEra: CalendarEra | null): ParsedDate | null {
    let rest = ` ${text.replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim()} `;
    if (!rest.trim()) return null;

    // Era: an abbreviation or name at the start or end.
    let era: CalendarEra | null = null;
    const eras = [...this.def.eras].sort((a, b) => Math.max(b.abbr.length, b.name.length) - Math.max(a.abbr.length, a.name.length));
    for (const candidate of eras) {
      for (const label of [candidate.name, candidate.abbr].filter(Boolean)) {
        const pattern = new RegExp(`(^|\\s)${escapeRegExp(label)}(?=\\s|$)`, 'i');
        if (pattern.test(rest)) {
          era = candidate;
          rest = rest.replace(pattern, ' ');
          break;
        }
      }
      if (era) break;
    }
    era ??= fallbackEra;

    // ISO-like: 1492-05-15 (months counted among the calendar's months, 1-based).
    const iso = rest.trim().match(/^(-?\d+)-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      const date = { year: this.fromEraYear(Number(iso[1]), era), month: Number(iso[2]) - 1, day: Number(iso[3]) };
      return this.isValid(date) ? { date, precision: 'day' } : null;
    }

    // Drop a weekday and filler words.
    for (const weekday of this.def.weekdays) {
      rest = rest.replace(new RegExp(`(^|\\s)${escapeRegExp(weekday)}(?=\\s|$)`, 'i'), ' ');
    }
    rest = rest.replace(/(^|\s)(the|of|on|day)(?=\s|$)/gi, ' ');
    rest = rest.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');

    // Month: the longest month name found.
    let monthIndex = -1;
    let monthLength = 0;
    this.def.months.forEach((month, index) => {
      const pattern = new RegExp(`(^|\\s)${escapeRegExp(month.name)}(?=\\s|$)`, 'i');
      if (month.name.length > monthLength && pattern.test(rest)) {
        monthIndex = index;
        monthLength = month.name.length;
      }
    });
    if (monthIndex >= 0) rest = rest.replace(new RegExp(`(^|\\s)${escapeRegExp(this.def.months[monthIndex].name)}(?=\\s|$)`, 'i'), ' ');

    const leftovers = rest.trim();
    const numbers = leftovers ? leftovers.split(/\s+/) : [];
    if (numbers.some(part => !/^-?\d+$/.test(part)) || numbers.length > 2) return null;
    const values = numbers.map(Number);

    if (monthIndex < 0) {
      if (values.length !== 1) return null;
      const year = this.fromEraYear(values[0], era);
      const first = this.monthsOf(year)[0];
      return first ? { date: { year, month: first.index, day: 1 }, precision: 'year' } : null;
    }

    // A day without a year ("Mirtul 15") is in the campaign's current year.
    const todayYear = () => (this.def.today ? this.today()?.year ?? null : null);
    let year: number | null = null;
    let day: number | null = null;
    if (values.length === 2) {
      [day, year] = values[0] <= 0 || values[0] > 31 && values[1] <= 31 ? [values[1], values[0]] : [values[0], values[1]];
      year = this.fromEraYear(year, era);
    } else if (values.length === 1) {
      const n = values[0];
      const current = n >= 1 && n <= this.def.months[monthIndex].days + 1 && !hasEraWord(text, this.def.eras) ? todayYear() : null;
      if (current !== null) {
        day = n;
        year = current;
      } else {
        year = this.fromEraYear(n, era);
      }
    } else {
      year = todayYear();
    }
    if (year === null) return null;

    const days = this.daysInMonth(year, monthIndex);
    if (!days) return null;
    if (day === null) {
      return days === 1
        ? { date: { year, month: monthIndex, day: 1 }, precision: 'day' }
        : { date: { year, month: monthIndex, day: 1 }, precision: 'month' };
    }
    const date = { year, month: monthIndex, day };
    return this.isValid(date) ? { date, precision: 'day' } : null;
  }

  /**
   * Relative dates: "3 days later", "two weeks after", "a month before", "1 year earlier",
   * "the next day", "the day before", "4 days ago" (from today), "today".
   */
  parseRelative(text: string, anchor: CalendarDate | null): ParsedDate | null {
    const clean = text.trim().toLowerCase().replace(/\s+/g, ' ');
    const today = this.today();
    if (clean === 'today') return today ? { date: today, precision: 'day' } : null;
    if (/^(the )?(next|following) day$|^the day after$/.test(clean)) return anchor ? { date: this.addDays(anchor, 1), precision: 'day' } : null;
    if (/^(the )?(previous|preceding) day$|^the day before$/.test(clean)) return anchor ? { date: this.addDays(anchor, -1), precision: 'day' } : null;

    const match = clean.match(/^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (day|week|tenday|month|year)s? (later|after|afterwards|before|earlier|ago)$/);
    if (!match) return null;
    const amount = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1]];
    const base = match[3] === 'ago' ? today : anchor;
    if (!base) return null;
    const sign = match[3] === 'before' || match[3] === 'earlier' || match[3] === 'ago' ? -1 : 1;
    const unit = match[2];
    const week = unit === 'tenday' ? 10 : Math.max(1, this.def.weekdays.length || 7);
    const date =
      unit === 'day' ? this.addDays(base, sign * amount)
        : unit === 'week' || unit === 'tenday' ? this.addDays(base, sign * amount * week)
          : unit === 'month' ? this.addMonths(base, sign * amount)
            : this.addYears(base, sign * amount);
    return { date, precision: unit === 'year' ? 'year' : unit === 'month' ? 'month' : 'day' };
  }

  // ---- Holidays ----

  /** Where a holiday falls in a year, or null if it isn't observed that year. */
  holidayDate(holiday: CalendarHoliday, year: number): CalendarDate | null {
    if (holiday.repeat === 'once' && holiday.year != null && holiday.year !== year) return null;
    if (holiday.since != null && year < holiday.since) return null;
    if (holiday.until != null && year > holiday.until) return null;
    const month = this.def.months.findIndex(item => sameName(item.name, holiday.date.month));
    if (month < 0) return null;
    const days = this.daysInMonth(year, month);
    if (!days) return null;

    if (holiday.date.weekday != null && holiday.date.nth != null && !this.def.months[month].intercalary) {
      const matches: number[] = [];
      for (let day = 1; day <= days; day++) {
        if (this.weekday({ year, month, day }) === holiday.date.weekday) matches.push(day);
      }
      const day = holiday.date.nth < 0 ? matches[matches.length + holiday.date.nth] : matches[holiday.date.nth - 1];
      return day ? { year, month, day } : null;
    }
    const day = Math.min(Math.max(1, holiday.date.day ?? 1), days);
    return { year, month, day };
  }

  holidaysOn(date: CalendarDate): CalendarHoliday[] {
    return this.def.holidays.filter(holiday => {
      const when = this.holidayDate(holiday, date.year);
      return !!when && when.month === date.month && when.day === date.day;
    });
  }

  /** "12 days ago", "in 3 days", "today" (relative to the campaign's today). */
  relativeToToday(date: CalendarDate): string | null {
    const today = this.today();
    if (!today) return null;
    const diff = this.compare(date, today);
    if (diff === 0) return 'today';
    const days = Math.abs(diff);
    const yearLength = this.yearLength(today.year) || 365;
    const amount = days >= yearLength
      ? `${Math.round((days / yearLength) * 10) / 10} years`
      : days === 1 ? '1 day' : `${days} days`;
    return diff < 0 ? `${amount} ago` : `in ${amount}`;
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasEraWord(text: string, eras: CalendarEra[]): boolean {
  return eras.some(era => [era.abbr, era.name].some(label => label && new RegExp(`(^|\\s)${escapeRegExp(label)}(?=\\s|$)`, 'i').test(text)));
}
