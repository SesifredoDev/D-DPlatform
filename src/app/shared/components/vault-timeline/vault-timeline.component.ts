import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subscription } from 'rxjs';
import type { DatePrecision } from '../../services/ObsidianVault/calendar-engine';
import { CalendarService, LoadedCalendar } from '../../services/ObsidianVault/calendar.service';
import { VaultIndexService } from '../../services/ObsidianVault/vault-index.service';
import { getVaultDisplayName, getVaultFileType } from '../../services/ObsidianVault/vault-file-types';
import {
  TimelineEvent,
  VaultTimeline,
  newEventId,
  parseTimeline,
  serializeTimeline,
} from '../../services/ObsidianVault/vault-timeline';

/** One row on the timeline. */
interface Entry {
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

interface ListRow {
  type: 'year' | 'month' | 'today' | 'entry';
  label: string;
  entry?: Entry;
}

interface EventDraft {
  id: string | null;
  title: string;
  date: string;
  end: string;
  link: string;
  lane: string;
  color: string;
}

const DEFAULT_COLOR = '#7fc8f8';

/**
 * A timeline file (see vault-timeline.ts): events in one calendar, from the timeline itself and from
 * dated notes, shown as a chronological list or along a zoomable axis. `embed` mode is
 * `![[History.timeline]]` in a note.
 */
@Component({
  selector: 'app-vault-timeline',
  standalone: true,
  imports: [FormsModule, MatIconModule, MatTooltipModule],
  templateUrl: './vault-timeline.component.html',
  styleUrl: './vault-timeline.component.scss',
})
export class VaultTimelineComponent implements OnChanges, OnDestroy {
  @Input() content: string | null = null;
  @Input() path = '';
  @Input() serverId = '';
  @Input() readonly = false;
  @Input() mode: 'file' | 'embed' = 'file';
  /** Jump to a date (from `[[History.timeline#1385 DR]]`). */
  @Input() focus: { anchor: string; token: number } | null = null;

  @Output() contentChange = new EventEmitter<string>();
  @Output() openFile = new EventEmitter<string>();
  @Output() linkHover = new EventEmitter<{ target: string; rect: DOMRect } | null>();

  @ViewChild('axis') private axisRef?: ElementRef<HTMLElement>;
  @ViewChild('list') private listRef?: ElementRef<HTMLElement>;

  timeline: VaultTimeline | null = null;
  parseError: string | null = null;
  calendars: LoadedCalendar[] = [];
  calendar: LoadedCalendar | null = null;
  loadingCalendars = true;

  entries: Entry[] = [];
  unreadable: TimelineEvent[] = [];
  rows: ListRow[] = [];
  view: 'list' | 'axis' = 'list';
  selected: Entry | null = null;

  panel: 'event' | 'sources' | null = null;
  draft: EventDraft | null = null;
  noteNames: string[] = [];
  tagsText = '';
  foldersText = '';

  /** Axis view: pixels per day. */
  scale = 0.5;
  axisStart = 0;
  axisWidth = 0;
  ticks: { x: number; label: string }[] = [];
  lanes: string[] = [];

  private lastEmitted: string | null = null;
  private undo: VaultTimeline | null = null;
  private calendarsSub?: Subscription;

  constructor(
    private snackBar: MatSnackBar,
    private calendarService: CalendarService,
    private vaultIndexService: VaultIndexService
  ) {
    this.calendarsSub = this.calendarService.changed$.subscribe(serverId => {
      if (serverId === this.serverId) this.useCalendars(this.calendarService.cached(serverId) ?? []);
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    const pathChanged = !!changes['path'] && !changes['path'].firstChange;
    if (pathChanged) {
      this.lastEmitted = null;
      this.selected = null;
      this.panel = null;
      this.draft = null;
    }
    if ((changes['content'] || pathChanged) && this.content !== this.lastEmitted) this.load(this.content ?? '');
    if (changes['serverId'] && this.serverId) {
      this.loadingCalendars = true;
      void this.calendarService.load(this.serverId).then(list => this.useCalendars(list));
      void this.vaultIndexService.ensureContentIndexed(this.serverId).then(() => this.rebuild());
    }
    if (changes['focus'] && this.focus?.anchor) setTimeout(() => this.jumpTo(this.focus!.anchor));
  }

  ngOnDestroy(): void {
    this.calendarsSub?.unsubscribe();
    this.linkHover.emit(null);
  }

  get canEdit(): boolean {
    return this.mode === 'file' && !this.readonly && !this.parseError;
  }

  get title(): string {
    return getVaultDisplayName(this.path.split('/').pop() || this.path);
  }

  private load(text: string): void {
    try {
      this.timeline = parseTimeline(text);
      this.parseError = null;
      this.view = this.timeline.view;
      this.tagsText = this.timeline.sources.tags.join(', ');
      this.foldersText = this.timeline.sources.folders.join(', ');
      this.pickCalendar();
      this.rebuild();
    } catch (error) {
      this.timeline = null;
      this.parseError = error instanceof Error ? error.message : 'This timeline can’t be read.';
    }
  }

  private commit(timeline: VaultTimeline, options: { undoable?: boolean } = {}): void {
    if (!this.canEdit) return;
    if (options.undoable && this.timeline) this.undo = this.timeline;
    const text = serializeTimeline(timeline);
    this.lastEmitted = text;
    this.timeline = parseTimeline(text);
    this.contentChange.emit(text);
    this.pickCalendar();
    this.rebuild();
  }

  private useCalendars(list: LoadedCalendar[]): void {
    this.calendars = list;
    this.loadingCalendars = false;
    this.pickCalendar();
    this.rebuild();
  }

  private pickCalendar(): void {
    const index = this.vaultIndexService.get(this.serverId);
    this.calendar = this.calendarService.find(this.calendars, this.timeline?.calendar, index, this.path)
      ?? this.calendarService.defaultCalendar(this.calendars);
  }

  // ---- Entries ----

  rebuild(): void {
    const timeline = this.timeline;
    const calendar = this.calendar;
    if (!timeline || !calendar) {
      this.entries = [];
      this.rows = [];
      return;
    }
    const engine = calendar.engine;
    const entries: Entry[] = [];
    this.unreadable = [];

    for (const event of timeline.events) {
      const start = engine.parse(event.date);
      if (!start) {
        this.unreadable.push(event);
        continue;
      }
      const end = event.end ? engine.parse(event.end) : null;
      const link = event.link ? this.vaultIndexService.get(this.serverId)?.resolveLink(event.link, this.path) : null;
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

    const notes = this.calendarService.datedItems(this.serverId, calendar, { mentions: inlineDates, filter });
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
        color: item.kind === 'mention' ? null : DEFAULT_COLOR,
        lane: item.kind === 'mention' ? 'Mentions' : 'Notes',
        event: null,
      });
    }

    if (holidays) {
      const days = entries.map(entry => entry.day);
      const today = engine.today();
      const fromYear = days.length ? engine.fromDayNumber(Math.min(...days)).year : today?.year ?? 1;
      const toYear = days.length ? engine.fromDayNumber(Math.max(...days)).year : today?.year ?? 1;
      for (const item of this.calendarService.datedItems(this.serverId, calendar, { holidays: { fromYear, toYear } })) {
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
    this.entries = entries;
    if (this.selected) this.selected = entries.find(entry => entry.key === this.selected!.key) ?? null;
    this.buildRows();
    this.buildAxis();
  }

  private buildRows(): void {
    const engine = this.calendar?.engine;
    const rows: ListRow[] = [];
    if (!engine) {
      this.rows = rows;
      return;
    }
    const today = engine.today();
    const todayDay = today ? engine.toDayNumber(today) : null;
    let year: number | null = null;
    let month: string | null = null;
    let todayShown = todayDay === null;
    for (const entry of this.entries) {
      if (!todayShown && entry.day > todayDay!) {
        rows.push({ type: 'today', label: `Today, ${engine.format(today!)}` });
        todayShown = true;
      }
      const date = engine.fromDayNumber(entry.day);
      if (date.year !== year) {
        year = date.year;
        month = null;
        rows.push({ type: 'year', label: engine.formatYear(date.year) });
      }
      const monthName = engine.monthName(date.month);
      if (monthName !== month) {
        month = monthName;
        rows.push({ type: 'month', label: monthName });
      }
      rows.push({ type: 'entry', label: entry.label, entry });
    }
    if (!todayShown && today) rows.push({ type: 'today', label: `Today, ${engine.format(today)}` });
    this.rows = rows;
  }

  /** The day part of an entry's date (the list already groups by year and month). */
  shortDate(entry: Entry): string {
    const engine = this.calendar?.engine;
    if (!engine) return entry.label;
    const date = engine.fromDayNumber(entry.day);
    if (entry.precision === 'year') return 'During the year';
    if (entry.precision === 'month') return 'During the month';
    if (engine.daysInMonth(date.year, date.month) === 1) return engine.monthName(date.month);
    return String(date.day);
  }

  rangeText(entry: Entry): string {
    const engine = this.calendar?.engine;
    if (!engine || entry.endDay === null) return '';
    return `until ${engine.format(engine.fromDayNumber(entry.endDay))}`;
  }

  // ---- Axis view ----

  private buildAxis(): void {
    const engine = this.calendar?.engine;
    if (!engine || !this.entries.length) {
      this.ticks = [];
      this.lanes = [];
      this.axisWidth = 0;
      return;
    }
    const first = Math.min(...this.entries.map(entry => entry.day));
    const last = Math.max(...this.entries.map(entry => entry.endDay ?? entry.day));
    const padding = Math.max(30, Math.round((last - first) * 0.05));
    this.axisStart = first - padding;
    const span = last - first + padding * 2;
    this.axisWidth = Math.max(span * this.scale, 400);
    this.lanes = Array.from(new Set(this.entries.map(entry => entry.lane)));

    // Year ticks, thinned so labels stay ~90px apart.
    const yearLength = engine.yearLength(engine.fromDayNumber(first).year) || 365;
    const step = Math.max(1, niceStep(90 / (yearLength * this.scale)));
    const firstYear = engine.fromDayNumber(this.axisStart).year;
    const lastYear = engine.fromDayNumber(this.axisStart + span).year;
    const ticks: { x: number; label: string }[] = [];
    const startYear = Math.ceil(firstYear / step) * step;
    for (let year = startYear; year <= lastYear && ticks.length < 400; year += step) {
      const months = engine.monthsOf(year);
      if (!months.length) continue;
      const day = engine.toDayNumber({ year, month: months[0].index, day: 1 });
      ticks.push({ x: (day - this.axisStart) * this.scale, label: engine.formatYear(year) });
    }
    this.ticks = ticks;
  }

  x(day: number): number {
    return (day - this.axisStart) * this.scale;
  }

  barWidth(entry: Entry): number {
    return entry.endDay === null ? 0 : Math.max(4, (entry.endDay - entry.day) * this.scale);
  }

  laneEntries(lane: string): Entry[] {
    return this.entries.filter(entry => entry.lane === lane);
  }

  zoom(factor: number, anchorX?: number): void {
    const axis = this.axisRef?.nativeElement;
    const centre = anchorX ?? (axis ? axis.scrollLeft + axis.clientWidth / 2 : 0);
    const day = centre / this.scale + this.axisStart;
    this.scale = Math.min(200, Math.max(0.0005, this.scale * factor));
    this.buildAxis();
    if (axis) setTimeout(() => (axis.scrollLeft = (day - this.axisStart) * this.scale - (centre - axis.scrollLeft)));
  }

  fitAxis(): void {
    const axis = this.axisRef?.nativeElement;
    if (!axis || !this.entries.length) return;
    const first = Math.min(...this.entries.map(entry => entry.day));
    const last = Math.max(...this.entries.map(entry => entry.endDay ?? entry.day));
    this.scale = Math.min(200, Math.max(0.0005, (axis.clientWidth - 80) / Math.max(1, (last - first) * 1.1)));
    this.buildAxis();
    axis.scrollLeft = 0;
  }

  onAxisWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const axis = this.axisRef?.nativeElement;
    const rect = axis?.getBoundingClientRect();
    this.zoom(Math.exp(-event.deltaY * 0.004), axis && rect ? axis.scrollLeft + event.clientX - rect.left : undefined);
  }

  setView(view: 'list' | 'axis'): void {
    this.view = view;
    if (this.canEdit && this.timeline && this.timeline.view !== view) this.commit({ ...this.timeline, view });
    if (view === 'axis') setTimeout(() => this.fitAxis());
  }

  // ---- Selecting and opening ----

  select(entry: Entry): void {
    this.selected = this.selected?.key === entry.key ? null : entry;
    if (this.selected && this.panel === 'event' && !this.draft?.id) this.panel = null;
  }

  open(entry: Entry): void {
    if (entry.path) this.openFile.emit(entry.path);
  }

  onEntryEnter(entry: Entry, element: HTMLElement): void {
    if (entry.path) this.linkHover.emit({ target: entry.path, rect: element.getBoundingClientRect() });
  }

  onEntryLeave(): void {
    this.linkHover.emit(null);
  }

  selectedLong(entry: Entry): string {
    const engine = this.calendar?.engine;
    return engine ? engine.formatLong(engine.fromDayNumber(entry.day)) : entry.label;
  }

  selectedRelative(entry: Entry): string | null {
    const engine = this.calendar?.engine;
    return engine ? engine.relativeToToday(engine.fromDayNumber(entry.day)) : null;
  }

  /** Scrolls to the first entry on or after a date. */
  private jumpTo(text: string): void {
    const engine = this.calendar?.engine;
    const parsed = engine?.parse(text);
    if (!engine || !parsed) return;
    const day = engine.toDayNumber(parsed.date);
    const entry = this.entries.find(item => item.day >= day);
    if (entry) this.selected = entry;
    if (this.view === 'axis') {
      const axis = this.axisRef?.nativeElement;
      if (axis) axis.scrollLeft = this.x(day) - axis.clientWidth / 2;
    } else {
      setTimeout(() => this.listRef?.nativeElement.querySelector('.entry.is-selected')?.scrollIntoView({ block: 'center' }));
    }
  }

  // ---- Editing events ----

  private loadNoteNames(): void {
    const index = this.vaultIndexService.get(this.serverId);
    this.noteNames = (index?.files ?? [])
      .filter(file => getVaultFileType(file.name).id === 'markdown')
      .map(file => index!.linkTextFor(file))
      .sort((a, b) => a.localeCompare(b));
  }

  newEvent(): void {
    if (!this.canEdit) return;
    this.loadNoteNames();
    const engine = this.calendar?.engine;
    const today = engine?.today();
    const date = this.selected && engine ? engine.format(engine.fromDayNumber(this.selected.day)) : today && engine ? engine.format(today) : '';
    this.draft = { id: null, title: '', date, end: '', link: '', lane: this.timeline?.lanes[0] ?? '', color: DEFAULT_COLOR };
    this.panel = 'event';
  }

  editEvent(event: TimelineEvent): void {
    if (!this.canEdit) return;
    this.loadNoteNames();
    this.draft = {
      id: event.id,
      title: event.title,
      date: event.date,
      end: event.end ?? '',
      link: event.link ?? '',
      lane: event.lane ?? '',
      color: event.color ?? DEFAULT_COLOR,
    };
    this.panel = 'event';
  }

  /** "15 Mirtul 1492 DR (Fifth-day)" or why the typed date can't be read. */
  dateHint(text: string): { ok: boolean; text: string } | null {
    const engine = this.calendar?.engine;
    if (!engine || !text.trim()) return null;
    const parsed = engine.parse(text);
    if (!parsed) return { ok: false, text: `Not a date in ${this.calendar!.name}` };
    return { ok: true, text: parsed.precision === 'day' ? engine.formatLong(parsed.date) : engine.format(parsed.date, parsed.precision) };
  }

  get draftValid(): boolean {
    const draft = this.draft;
    if (!draft || !draft.date.trim() || !this.calendar) return false;
    if (!this.calendar.engine.parse(draft.date)) return false;
    return !draft.end.trim() || !!this.calendar.engine.parse(draft.end);
  }

  saveDraft(): void {
    const draft = this.draft;
    const timeline = this.timeline;
    if (!draft || !timeline || !this.draftValid) return;
    const event: TimelineEvent = {
      ...(timeline.events.find(item => item.id === draft.id) ?? {}),
      id: draft.id ?? newEventId(),
      title: draft.title.trim(),
      date: draft.date.trim(),
      end: draft.end.trim() || null,
      link: draft.link.trim() || null,
      lane: draft.lane.trim() || null,
      color: draft.color || null,
    };
    const events = draft.id ? timeline.events.map(item => (item.id === draft.id ? event : item)) : [...timeline.events, event];
    const lanes = event.lane && !timeline.lanes.includes(event.lane) ? [...timeline.lanes, event.lane] : timeline.lanes;
    this.commit({ ...timeline, events, lanes });
    this.draft = null;
    this.panel = null;
    this.selected = this.entries.find(entry => entry.event?.id === event.id) ?? null;
  }

  deleteEvent(event: TimelineEvent): void {
    const timeline = this.timeline;
    if (!timeline || !this.canEdit) return;
    this.commit({ ...timeline, events: timeline.events.filter(item => item.id !== event.id) }, { undoable: true });
    if (this.selected?.event?.id === event.id) this.selected = null;
    if (this.draft?.id === event.id) {
      this.draft = null;
      this.panel = null;
    }
    this.snackBar.open(`Deleted “${event.title || event.date}”.`, 'Undo', { duration: 6000 }).onAction().subscribe(() => {
      if (this.undo) this.commit(this.undo);
      this.undo = null;
    });
  }

  closePanel(): void {
    this.panel = null;
    this.draft = null;
  }

  // ---- Sources ----

  openSources(): void {
    if (!this.canEdit) return;
    this.panel = this.panel === 'sources' ? null : 'sources';
    this.draft = null;
  }

  setCalendar(path: string | null): void {
    if (this.timeline) this.commit({ ...this.timeline, calendar: path });
  }

  setSources(changes: Partial<VaultTimeline['sources']>): void {
    if (this.timeline) this.commit({ ...this.timeline, sources: { ...this.timeline.sources, ...changes } });
  }

  saveTags(): void {
    this.setSources({ tags: splitList(this.tagsText).map(tag => tag.replace(/^#/, '')) });
  }

  saveFolders(): void {
    this.setSources({ folders: splitList(this.foldersText) });
  }

  get sourceSummary(): string {
    const sources = this.timeline?.sources;
    if (!sources) return '';
    const parts: string[] = [];
    if (!sources.tags.length && !sources.folders.length) parts.push('every dated note');
    if (sources.tags.length) parts.push(`notes tagged ${sources.tags.map(tag => `#${tag}`).join(', ')}`);
    if (sources.folders.length) parts.push(`notes in ${sources.folders.join(', ')}`);
    if (sources.inlineDates) parts.push('dates mentioned in notes');
    if (sources.holidays) parts.push('holidays');
    return parts.join('; ');
  }
}

function splitList(text: string): string[] {
  return text.split(',').map(part => part.trim()).filter(Boolean);
}

/** 1, 2, 5, 10, 20, 50, … ≥ value. */
function niceStep(value: number): number {
  if (value <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 5, 10]) {
    if (factor * power >= value) return factor * power;
  }
  return 10 * power;
}
