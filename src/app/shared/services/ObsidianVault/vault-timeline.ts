/**
 * Timeline files (`*.timeline`): JSON describing a timeline that uses one calendar.
 *
 *   { "type": "timeline", "version": 1,
 *     "calendar": "Calendars/Harptos.calendar",       // null = the vault's default calendar
 *     "sources": { "tags": ["event"], "folders": ["Lore/History"], "holidays": false, "inlineDates": false },
 *     "events": [{ "id": "…", "date": "1385 DR", "end": null, "title": "Spellplague",
 *                  "link": "Lore/Spellplague", "color": "#b8a6ff", "lane": "Magic" }],
 *     "lanes": ["Politics", "Magic"],
 *     "view": "list" }
 *
 * Besides its own `events`, a timeline shows notes whose `date` property (or Calendarium's
 * `fc-date`) is set, filtered by `sources`. Dates are text in the calendar ("15 Mirtul 1492 DR").
 * Keys the app doesn't know are kept. Pure functions, no Angular.
 */
import { getFileExtension } from './vault-file-types';

export interface TimelineEvent {
  id: string;
  date: string;
  end: string | null;
  title: string;
  link: string | null;
  color: string | null;
  lane: string | null;
  [key: string]: unknown;
}

export interface TimelineSources {
  /** Notes with any of these tags (and a date). Empty with no folders = every dated note. */
  tags: string[];
  /** Notes in these folders (and a date). */
  folders: string[];
  holidays: boolean;
  /** Also list `[date:: …]` mentions inside notes. */
  inlineDates: boolean;
}

export interface VaultTimeline {
  calendar: string | null;
  sources: TimelineSources;
  events: TimelineEvent[];
  lanes: string[];
  view: 'list' | 'axis';
  [key: string]: unknown;
}

export function isTimelinePath(path: string): boolean {
  return getFileExtension(path) === 'timeline';
}

export function emptyTimeline(calendar: string | null = null): string {
  return serializeTimeline({
    calendar,
    sources: { tags: [], folders: [], holidays: false, inlineDates: false },
    events: [],
    lanes: [],
    view: 'list',
  });
}

export function parseTimeline(text: string): VaultTimeline {
  if (!text.trim()) return JSON.parse(emptyTimeline()) as VaultTimeline;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This timeline file isn’t valid JSON.');
  }
  if (!isRecord(raw) || (raw['type'] !== undefined && raw['type'] !== 'timeline')) throw new Error('This file isn’t a timeline.');
  const { type: _type, version: _version, calendar, sources, events, lanes, view, ...rest } = raw;
  const src = isRecord(sources) ? sources : {};
  return {
    ...rest,
    calendar: str(calendar) || null,
    sources: {
      tags: arr(src['tags']).map(str).map(tag => tag.replace(/^#/, '')).filter(Boolean),
      folders: arr(src['folders']).map(str).filter(Boolean),
      holidays: src['holidays'] === true,
      inlineDates: src['inlineDates'] === true,
    },
    events: arr(events).filter(isRecord).map(event => ({
      ...event,
      id: str(event['id']) || newId(),
      date: str(event['date']),
      end: str(event['end']) || null,
      title: str(event['title']),
      link: str(event['link']) || null,
      color: str(event['color']) || null,
      lane: str(event['lane']) || null,
    })),
    lanes: arr(lanes).map(str).filter(Boolean),
    view: view === 'axis' ? 'axis' : 'list',
  };
}

export function serializeTimeline(timeline: VaultTimeline): string {
  const { calendar, sources, events, lanes, view, ...rest } = timeline;
  return `${JSON.stringify({ type: 'timeline', version: 1, calendar, sources, events, lanes, view, ...rest }, null, 2)}\n`;
}

export function newEventId(): string {
  return newId();
}

/** Links a timeline makes (its calendar, and events → notes), for backlinks. */
export function timelineLinks(timeline: VaultTimeline): { target: string; snippet: string }[] {
  const links = timeline.events
    .filter(event => !!event.link)
    .map(event => ({ target: event.link!, snippet: `🕰 ${event.title || event.date}` }));
  if (timeline.calendar) links.push({ target: timeline.calendar, snippet: 'Timeline calendar' });
  return links;
}

export function timelineLinksFromText(text: string): { target: string; snippet: string }[] {
  try {
    return timelineLinks(parseTimeline(text));
  } catch {
    return [];
  }
}

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

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}
