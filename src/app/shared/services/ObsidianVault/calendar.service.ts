import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { CalendarDef, CalendarEngine, DatePrecision, ParsedDate } from './calendar-engine';
import { ObsidianVaultService, VaultEntry } from './obsidian-vault-service';
import { parseCalendarFile } from './vault-calendar';
import { VaultIndex, VaultIndexService } from './vault-index.service';
import { getVaultDisplayName, isVaultFileType } from './vault-file-types';
import type { TimelineEvent, VaultTimeline } from './vault-timeline';

export interface LoadedCalendar {
  path: string;
  name: string;
  def: CalendarDef;
  engine: CalendarEngine;
}

export interface ResolvedDate {
  calendar: LoadedCalendar;
  parsed: ParsedDate;
  /** What was written. */
  text: string;
  /** The date written out in its calendar ("15 Mirtul 1492 DR"). */
  label: string;
}

/** Something on a day: a dated note, a `[date:: …]` mention, a holiday or a timeline event. */
export interface DatedItem {
  kind: 'note' | 'mention' | 'holiday' | 'event';
  title: string;
  /** Day number in its calendar (see CalendarEngine.toDayNumber). */
  day: number;
  /** Last day, for ranges. */
  endDay: number | null;
  precision: ParsedDate['precision'];
  label: string;
  /** Vault path of the note it comes from / links to. */
  path: string | null;
  color: string | null;
  tags: string[];
}

/** One row on a timeline. */
export interface TimelineEntry {
  key: string;
  kind: 'event' | 'note' | 'mention' | 'holiday';
  title: string;
  day: number;
  endDay: number | null;
  label: string;
  precision: DatePrecision;
  path: string | null;
  color: string | null;
  lane: string;
  /** The timeline's own event (editable). */
  event: TimelineEvent | null;
}

/** Colour of timeline events and dated notes that don't set one. */
export const TIMELINE_EVENT_COLOR = '#7fc8f8';

/** Property names that date a note (`fc-…` are Obsidian Calendarium's). */
const DATE_KEYS = ['date', 'fc-date'];
const END_KEYS = ['end', 'fc-end'];
const CALENDAR_KEYS = ['calendar', 'fc-calendar'];

/**
 * The vault's calendars (`*.calendar` files) and the dates written in notes. Calendars are read
 * once per server and kept until a calendar file changes (`invalidate`).
 */
@Injectable({ providedIn: 'root' })
export class CalendarService {
  /** Emits a server id when its calendars were (re)loaded. */
  readonly changed$ = new Subject<string>();

  private readonly cache = new Map<string, LoadedCalendar[]>();
  private readonly loading = new Map<string, Promise<LoadedCalendar[]>>();

  constructor(private vaultService: ObsidianVaultService, private vaultIndexService: VaultIndexService) {}

  /** Calendars already loaded for a server (null if not yet; call `load`). */
  cached(serverId: string): LoadedCalendar[] | null {
    return this.cache.get(serverId) ?? null;
  }

  load(serverId: string, force = false): Promise<LoadedCalendar[]> {
    const cached = this.cache.get(serverId);
    if (cached && !force) return Promise.resolve(cached);
    const running = this.loading.get(serverId);
    if (running && !force) return running;

    const run = (async () => {
      const index = this.vaultIndexService.get(serverId) ?? await this.vaultIndexService.load(serverId);
      const files = index.files.filter(file => isVaultFileType(file.name, 'calendar'));
      const loaded: LoadedCalendar[] = [];
      for (const file of files) {
        try {
          const def = parseCalendarFile(await this.vaultService.readFile(serverId, file.relativePath));
          loaded.push({ path: file.relativePath, name: def.name || getVaultDisplayName(file.name), def, engine: new CalendarEngine(def) });
        } catch {
          // A calendar file that can't be read is shown as an error in its own view; skip it here.
        }
      }
      loaded.sort((a, b) => Number(!!b.def.default) - Number(!!a.def.default) || a.name.localeCompare(b.name));
      this.cache.set(serverId, loaded);
      this.changed$.next(serverId);
      return loaded;
    })().finally(() => this.loading.delete(serverId));
    this.loading.set(serverId, run);
    return run;
  }

  /** A calendar file was created, edited or removed: read them again. */
  invalidate(serverId: string): void {
    void this.load(serverId, true);
  }

  /** Uses the calendar text of an open calendar file straight away (before it's saved). */
  updateFromContent(serverId: string, path: string, content: string): void {
    const list = this.cache.get(serverId);
    if (!list) return;
    try {
      const def = parseCalendarFile(content);
      const next = list.filter(item => item.path !== path);
      next.push({ path, name: def.name || getVaultDisplayName(path.split('/').pop() || path), def, engine: new CalendarEngine(def) });
      next.sort((a, b) => Number(!!b.def.default) - Number(!!a.def.default) || a.name.localeCompare(b.name));
      this.cache.set(serverId, next);
      this.changed$.next(serverId);
    } catch {
      /* keep the last good version */
    }
  }

  defaultCalendar(list: LoadedCalendar[]): LoadedCalendar | null {
    return list.find(item => item.def.default) ?? list[0] ?? null;
  }

  /** The calendar a link or name points at (a `.calendar` path, link text or calendar name). */
  find(list: LoadedCalendar[], reference: string | null | undefined, index?: VaultIndex | null, fromPath = ''): LoadedCalendar | null {
    const ref = (reference ?? '').replace(/^\[\[|\]\]$/g, '').trim();
    if (!ref) return null;
    const entry = index?.resolveLink(ref, fromPath);
    return list.find(item => item.path === entry?.relativePath)
      ?? list.find(item => item.name.toLowerCase() === ref.toLowerCase())
      ?? list.find(item => getVaultDisplayName(item.path.split('/').pop() || '').toLowerCase() === ref.toLowerCase())
      ?? null;
  }

  /** The calendar a note asks for with a `calendar:` property, if any. */
  noteCalendar(list: LoadedCalendar[], index: VaultIndex | null, notePath: string): LoadedCalendar | null {
    const property = index?.getProperties(notePath).find(item => CALENDAR_KEYS.includes(item.key.toLowerCase()));
    return property ? this.find(list, property.values[0], index, notePath) : null;
  }

  /**
   * Reads a date written in a note. Tries, in order: a calendar named first ("Harptos 15 Mirtul"),
   * a relative date ("3 days later", from `anchor`), the note's calendar, the default calendar,
   * then any calendar it parses in.
   */
  resolve(list: LoadedCalendar[], text: string, options: { preferred?: LoadedCalendar | null; anchor?: ResolvedDate | null } = {}): ResolvedDate | null {
    const clean = text.trim();
    if (!clean || !list.length) return null;

    for (const calendar of list) {
      const prefix = new RegExp(`^${escapeRegExp(calendar.name)}\\s*[:,]?\\s+`, 'i');
      if (prefix.test(clean)) {
        const rest = clean.replace(prefix, '');
        const parsed = calendar.engine.parse(rest) ?? calendar.engine.parseRelative(rest, null);
        return parsed ? this.result(calendar, parsed, clean) : null;
      }
    }

    const anchor = options.anchor;
    if (anchor) {
      const relative = anchor.calendar.engine.parseRelative(clean, anchor.parsed.date);
      if (relative) return this.result(anchor.calendar, relative, clean);
    }

    const order = uniqueCalendars([options.preferred ?? null, this.defaultCalendar(list), ...list]);
    for (const calendar of order) {
      const parsed = calendar.engine.parse(clean) ?? calendar.engine.parseRelative(clean, null);
      if (parsed) return this.result(calendar, parsed, clean);
    }
    return null;
  }

  /** Resolves a note's dates in order, so "3 days later" counts from the date before it. */
  resolveSequence(list: LoadedCalendar[], texts: readonly string[], preferred: LoadedCalendar | null): (ResolvedDate | null)[] {
    let anchor: ResolvedDate | null = null;
    return texts.map(text => {
      const resolved = this.resolve(list, text, { preferred: anchor?.calendar ?? preferred, anchor });
      if (resolved) anchor = resolved;
      return resolved;
    });
  }

  private result(calendar: LoadedCalendar, parsed: ParsedDate, text: string): ResolvedDate {
    return { calendar, parsed, text, label: calendar.engine.format(parsed.date, parsed.precision) };
  }

  /**
   * Everything dated in one calendar: notes with a `date` property, optionally `[date:: …]`
   * mentions and holidays in a span of years. Only covers notes indexed so far
   * (VaultIndexService.ensureContentIndexed).
   */
  datedItems(
    serverId: string,
    calendar: LoadedCalendar,
    options: { mentions?: boolean; holidays?: { fromYear: number; toYear: number } | null; filter?: (entry: VaultEntry, tags: string[]) => boolean } = {}
  ): DatedItem[] {
    const index = this.vaultIndexService.get(serverId);
    const list = this.cache.get(serverId) ?? [calendar];
    if (!index) return [];
    const items: DatedItem[] = [];
    const engine = calendar.engine;

    for (const entry of index.files) {
      if (!isVaultFileType(entry.name, 'markdown')) continue;
      const properties = index.getProperties(entry.relativePath);
      const tags = index.getTags(entry.relativePath);
      if (options.filter && !options.filter(entry, tags)) continue;
      const preferred = this.noteCalendar(list, index, entry.relativePath);
      const title = getVaultDisplayName(entry.name);

      const dateText = properties.find(item => DATE_KEYS.includes(item.key.toLowerCase()))?.values[0];
      if (dateText) {
        const start = this.resolve(list, dateText, { preferred });
        if (start?.calendar === calendar) {
          const endText = properties.find(item => END_KEYS.includes(item.key.toLowerCase()))?.values[0];
          const end = endText ? this.resolve(list, endText, { preferred: calendar, anchor: start }) : null;
          items.push({
            kind: 'note',
            title,
            day: engine.toDayNumber(start.parsed.date),
            endDay: end?.calendar === calendar ? engine.toDayNumber(end.parsed.date) : null,
            precision: start.parsed.precision,
            label: start.label,
            path: entry.relativePath,
            color: null,
            tags,
          });
        }
      }

      if (options.mentions) {
        const texts = index.getInlineDates(entry.relativePath);
        if (texts.length) {
          this.resolveSequence(list, texts, preferred).forEach(resolved => {
            if (resolved?.calendar !== calendar) return;
            items.push({
              kind: 'mention',
              title,
              day: engine.toDayNumber(resolved.parsed.date),
              endDay: null,
              precision: resolved.parsed.precision,
              label: resolved.label,
              path: entry.relativePath,
              color: null,
              tags,
            });
          });
        }
      }
    }

    if (options.holidays) {
      const { fromYear, toYear } = options.holidays;
      const span = Math.min(toYear - fromYear, 400);
      for (let year = fromYear; year <= fromYear + span; year++) {
        for (const holiday of calendar.def.holidays) {
          const date = engine.holidayDate(holiday, year);
          if (!date) continue;
          const link = holiday.link ? index.resolveLink(holiday.link, calendar.path) : null;
          items.push({
            kind: 'holiday',
            title: holiday.name,
            day: engine.toDayNumber(date),
            endDay: null,
            precision: 'day',
            label: engine.format(date),
            path: link?.kind === 'file' ? link.relativePath : null,
            color: holiday.color ?? null,
            tags: [],
          });
        }
      }
    }
    return items;
  }

  /**
   * A timeline's entries in date order: its own events, then notes and holidays as its sources ask.
   * Notes must be content-indexed first (VaultIndexService.ensureContentIndexed). `unreadable` are
   * events whose date doesn't read in the calendar.
   */
  timelineEntries(serverId: string, calendar: LoadedCalendar, timeline: VaultTimeline, path: string): { entries: TimelineEntry[]; unreadable: TimelineEvent[] } {
    const engine = calendar.engine;
    const entries: TimelineEntry[] = [];
    const unreadable: TimelineEvent[] = [];

    for (const event of timeline.events) {
      const start = engine.parse(event.date);
      if (!start) {
        unreadable.push(event);
        continue;
      }
      const end = event.end ? engine.parse(event.end) : null;
      const link = event.link ? this.vaultIndexService.get(serverId)?.resolveLink(event.link, path) : null;
      entries.push({
        key: `event:${event.id}`,
        kind: 'event',
        title: event.title || (link ? getVaultDisplayName(link.name) : event.date),
        day: engine.toDayNumber(start.date),
        endDay: end ? engine.toDayNumber(end.date) : null,
        label: engine.format(start.date, start.precision),
        precision: start.precision,
        path: link?.kind === 'file' ? link.relativePath : null,
        color: event.color,
        lane: event.lane || 'Events',
        event,
      });
    }

    const { tags, folders, holidays, inlineDates } = timeline.sources;
    const wantedTags = tags.map(tag => tag.toLowerCase());
    const filter = (entry: { relativePath: string }, noteTags: string[]) =>
      (!wantedTags.length && !folders.length)
      || noteTags.some(tag => wantedTags.includes(tag.toLowerCase()) || wantedTags.some(wanted => tag.toLowerCase().startsWith(`${wanted}/`)))
      || folders.some(folder => entry.relativePath.toLowerCase().startsWith(`${folder.toLowerCase().replace(/\/$/, '')}/`));

    const notes = this.datedItems(serverId, calendar, { mentions: inlineDates, filter });
    for (const item of notes) {
      entries.push({
        key: `${item.kind}:${item.path}:${item.day}`,
        kind: item.kind,
        title: item.title,
        day: item.day,
        endDay: item.endDay,
        label: item.label,
        precision: item.precision,
        path: item.path,
        color: item.kind === 'mention' ? null : TIMELINE_EVENT_COLOR,
        lane: item.kind === 'mention' ? 'Mentions' : 'Notes',
        event: null,
      });
    }

    if (holidays) {
      const days = entries.map(entry => entry.day);
      const today = engine.today();
      const fromYear = days.length ? engine.fromDayNumber(Math.min(...days)).year : today?.year ?? 1;
      const toYear = days.length ? engine.fromDayNumber(Math.max(...days)).year : today?.year ?? 1;
      for (const item of this.datedItems(serverId, calendar, { holidays: { fromYear, toYear } })) {
        if (item.kind !== 'holiday') continue;
        entries.push({
          key: `holiday:${item.title}:${item.day}`,
          kind: 'holiday',
          title: item.title,
          day: item.day,
          endDay: null,
          label: item.label,
          precision: 'day',
          path: item.path,
          color: item.color ?? '#8fe0ad',
          lane: 'Holidays',
          event: null,
        });
      }
    }

    entries.sort((a, b) => a.day - b.day || a.title.localeCompare(b.title));
    return { entries, unreadable };
  }

  /** Dated items on one day (for a calendar's day card). */
  itemsOn(items: DatedItem[], day: number): DatedItem[] {
    return items.filter(item => item.day === day || (item.endDay !== null && item.day <= day && day <= item.endDay));
  }
}

function uniqueCalendars(list: (LoadedCalendar | null)[]): LoadedCalendar[] {
  const seen = new Set<string>();
  return list.filter((item): item is LoadedCalendar => {
    if (!item || seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

