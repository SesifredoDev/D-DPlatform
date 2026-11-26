import { rewriteCalendarLinks, rewriteTimelineLinks } from './file-link-rewrite';
import { CALENDAR_PRESETS, calendarLinks, parseCalendarFile, serializeCalendar } from './vault-calendar';
import { emptyTimeline, parseTimeline, serializeTimeline, timelineLinks } from './vault-timeline';

const TIMELINE = JSON.stringify({
  type: 'timeline',
  calendar: 'Calendars/Harptos.calendar',
  sources: { tags: ['#event'], folders: ['Lore'], holidays: true },
  events: [{ id: 'e1', date: '1385 DR', title: 'Spellplague', link: 'Lore/Spellplague#Aftermath', lane: 'Magic', extra: 1 }],
  lanes: ['Magic'],
  view: 'axis',
  theme: 'dark',
});

describe('timeline files', () => {
  it('reads sources, events and unknown keys', () => {
    const timeline = parseTimeline(TIMELINE);
    expect(timeline.sources).toEqual({ tags: ['event'], folders: ['Lore'], holidays: true, inlineDates: false });
    expect(timeline.events[0]).toMatchObject({ id: 'e1', date: '1385 DR', end: null, link: 'Lore/Spellplague#Aftermath', extra: 1 });
    expect(timeline.view).toBe('axis');
    expect(timeline['theme']).toBe('dark');
    expect(parseTimeline(serializeTimeline(timeline))).toEqual(timeline);
    expect(parseTimeline(emptyTimeline('Cal.calendar')).calendar).toBe('Cal.calendar');
    expect(() => parseTimeline('{"type":"map"}')).toThrow();
  });

  it('lists event and calendar links', () => {
    expect(timelineLinks(parseTimeline(TIMELINE))).toEqual([
      { target: 'Lore/Spellplague#Aftermath', snippet: '🕰 Spellplague' },
      { target: 'Calendars/Harptos.calendar', snippet: 'Timeline calendar' },
    ]);
  });
});

describe('rewriting links after a move', () => {
  const ctx = {
    filePath: 'Lore/History.timeline',
    resolve: (target: string) => ({
      'Lore/Spellplague': 'Lore/Spellplague.md',
      'Calendars/Harptos.calendar': 'Calendars/Harptos.calendar',
      'Lore/Greengrass': 'Lore/Greengrass.md',
    } as Record<string, string>)[target] ?? null,
    moved: new Map([
      ['lore/spellplague.md', 'History/Spellplague.md'],
      ['calendars/harptos.calendar', 'Time/Harptos.calendar'],
      ['lore/greengrass.md', 'Holidays/Greengrass.md'],
    ]),
    linkTextFor: (path: string) => path.replace(/\.md$/, ''),
  };

  it('updates timeline events (keeping #anchors) and the calendar', () => {
    const result = rewriteTimelineLinks(TIMELINE, ctx);
    expect(result.count).toBe(2);
    const timeline = parseTimeline(result.content);
    expect(timeline.events[0].link).toBe('History/Spellplague#Aftermath');
    expect(timeline.calendar).toBe('Time/Harptos.calendar');
  });

  it('updates holiday links in calendars', () => {
    const def = CALENDAR_PRESETS.find(item => item.id === 'harptos')!.build();
    def.holidays = [{ id: 'h', name: 'Greengrass', date: { month: 'Greengrass' }, repeat: 'yearly', link: 'Lore/Greengrass' }];
    const result = rewriteCalendarLinks(serializeCalendar(def), { ...ctx, filePath: 'Calendars/Harptos.calendar' });
    expect(result.count).toBe(1);
    expect(parseCalendarFile(result.content).holidays[0].link).toBe('Holidays/Greengrass');
    expect(calendarLinks(parseCalendarFile(result.content))).toEqual([{ target: 'Holidays/Greengrass', snippet: '📅 Greengrass' }]);
  });

  it('leaves files alone when nothing they link to moved', () => {
    const still = { ...ctx, moved: new Map<string, string>() };
    expect(rewriteTimelineLinks(TIMELINE, still)).toEqual({ content: TIMELINE, count: 0 });
  });
});
