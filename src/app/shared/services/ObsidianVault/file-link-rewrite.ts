/**
 * Keeps links inside JSON-based vault files (calendars, timelines) working after files move.
 * (Notes use link-rewrite.ts; maps use rewriteMapLinks in vault-map.ts.)
 */
import { parseCalendarFile, serializeCalendar } from './vault-calendar';
import { parseTimeline, serializeTimeline } from './vault-timeline';

export interface FileLinkRewriteContext {
  /** The file being rewritten (links resolve relative to it). */
  filePath: string;
  resolve: (target: string, fromPath: string) => string | null;
  /** Moved files: lower-cased old path → new path. */
  moved: Map<string, string>;
  linkTextFor: (newPath: string, originalTarget: string) => string;
}

/** The link pointed at its file's new place (keeping `#anchors`), or null when it didn't move. */
export function rewriteLinkTarget(link: string, ctx: FileLinkRewriteContext): string | null {
  const [targetPart, ...anchor] = link.split('#');
  const target = targetPart.trim();
  const resolved = ctx.resolve(target, ctx.filePath);
  const moved = resolved ? ctx.moved.get(resolved.toLowerCase()) : undefined;
  if (!moved) return null;
  const text = ctx.linkTextFor(moved, target);
  return anchor.length ? `${text}#${anchor.join('#')}` : text;
}

export function rewriteCalendarLinks(text: string, ctx: FileLinkRewriteContext): { content: string; count: number } {
  try {
    const def = parseCalendarFile(text);
    let count = 0;
    const holidays = def.holidays.map(holiday => {
      const next = holiday.link ? rewriteLinkTarget(holiday.link, ctx) : null;
      if (!next) return holiday;
      count++;
      return { ...holiday, link: next };
    });
    return count ? { content: serializeCalendar({ ...def, holidays }), count } : { content: text, count: 0 };
  } catch {
    return { content: text, count: 0 };
  }
}

export function rewriteTimelineLinks(text: string, ctx: FileLinkRewriteContext): { content: string; count: number } {
  try {
    const timeline = parseTimeline(text);
    let count = 0;
    const events = timeline.events.map(event => {
      const next = event.link ? rewriteLinkTarget(event.link, ctx) : null;
      if (!next) return event;
      count++;
      return { ...event, link: next };
    });
    const calendar = timeline.calendar ? rewriteLinkTarget(timeline.calendar, ctx) : null;
    if (calendar) count++;
    return count
      ? { content: serializeTimeline({ ...timeline, events, calendar: calendar ?? timeline.calendar }), count }
      : { content: text, count: 0 };
  } catch {
    return { content: text, count: 0 };
  }
}
