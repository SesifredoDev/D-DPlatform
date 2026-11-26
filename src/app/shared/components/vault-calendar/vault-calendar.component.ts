import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subscription } from 'rxjs';
import {
  CalendarDate,
  CalendarDef,
  CalendarEngine,
  CalendarEra,
  CalendarHoliday,
  CalendarMonth,
} from '../../services/ObsidianVault/calendar-engine';
import { CalendarService, DatedItem, LoadedCalendar } from '../../services/ObsidianVault/calendar.service';
import { inlineDate } from '../../services/ObsidianVault/inline-dates';
import { NoteInsertService } from '../../services/ObsidianVault/note-insert.service';
import { newHolidayId, parseCalendarFile, serializeCalendar } from '../../services/ObsidianVault/vault-calendar';
import { VaultIndexService } from '../../services/ObsidianVault/vault-index.service';
import { getVaultDisplayName, getVaultFileType } from '../../services/ObsidianVault/vault-file-types';

interface DayCell {
  date: CalendarDate;
  dayNumber: number;
  isToday: boolean;
  isSelected: boolean;
  holidays: CalendarHoliday[];
  items: DatedItem[];
}

type SettingsTab = 'general' | 'months' | 'weekdays' | 'eras' | 'holidays';

/**
 * A calendar file (see vault-calendar.ts / calendar-engine.ts): a month view with holidays and the
 * notes dated in it, a day card, and (when editable) settings for months, weekdays, leap days,
 * eras and holidays. `embed` mode is `![[Harptos.calendar]]` in a note: the month view only.
 */
@Component({
  selector: 'app-vault-calendar',
  standalone: true,
  imports: [FormsModule, MatIconModule, MatTooltipModule],
  templateUrl: './vault-calendar.component.html',
  styleUrl: './vault-calendar.component.scss',
})
export class VaultCalendarComponent implements OnChanges, OnDestroy {
  @Input() content: string | null = null;
  @Input() path = '';
  @Input() serverId = '';
  @Input() readonly = false;
  @Input() mode: 'file' | 'embed' = 'file';
  /** Open at a date (from `[[Harptos.calendar#15 Mirtul 1492 DR]]` or a date in a note). */
  @Input() focus: { anchor: string; token: number } | null = null;

  @Output() contentChange = new EventEmitter<string>();
  @Output() openFile = new EventEmitter<string>();
  @Output() linkHover = new EventEmitter<{ target: string; rect: DOMRect } | null>();

  def: CalendarDef | null = null;
  engine: CalendarEngine | null = null;
  parseError: string | null = null;

  /** The month on screen. */
  year = 1;
  month = 0;
  selected: CalendarDate | null = null;
  weeks: (DayCell | null)[][] = [];
  /** Intercalary months show as a strip of festival days instead of a grid. */
  festival: DayCell[] = [];
  items: DatedItem[] = [];
  jumpText = '';
  jumpError = '';

  settingsOpen = false;
  tab: SettingsTab = 'general';
  noteNames: string[] = [];
  newNoteFolder: string | null = null;
  newNoteFolders: string[] = [];
  newNoteTitle = '';

  private lastEmitted: string | null = null;
  private undo: CalendarDef | null = null;
  private calendarsSub?: Subscription;

  constructor(
    private snackBar: MatSnackBar,
    private calendars: CalendarService,
    private vaultIndexService: VaultIndexService,
    private noteInsert: NoteInsertService
  ) {
    this.calendarsSub = this.calendars.changed$.subscribe(serverId => {
      if (serverId === this.serverId) this.refreshItems();
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    const pathChanged = !!changes['path'] && !changes['path'].firstChange;
    if (pathChanged) {
      this.lastEmitted = null;
      this.selected = null;
      this.settingsOpen = false;
    }
    if ((changes['content'] || pathChanged) && this.content !== this.lastEmitted) {
      this.load(this.content ?? '', changes['content']?.firstChange || pathChanged);
    }
    if (changes['focus'] && this.focus?.anchor) this.goTo(this.focus.anchor);
    if (changes['serverId'] && this.serverId) {
      void this.vaultIndexService.ensureContentIndexed(this.serverId).then(() => this.refreshItems());
    }
  }

  ngOnDestroy(): void {
    this.calendarsSub?.unsubscribe();
    this.linkHover.emit(null);
  }

  get canEdit(): boolean {
    return this.mode === 'file' && !this.readonly && !this.parseError;
  }

  get title(): string {
    return this.def?.name || getVaultDisplayName(this.path.split('/').pop() || this.path);
  }

  private load(text: string, jumpToToday: boolean): void {
    try {
      const def = parseCalendarFile(text);
      this.def = def;
      this.engine = new CalendarEngine(def);
      this.parseError = null;
      if (jumpToToday || this.month >= def.months.length) {
        const today = this.engine.today();
        const first = this.engine.monthsOf(today?.year ?? 1)[0];
        this.year = today?.year ?? 1;
        this.month = today?.month ?? first?.index ?? 0;
      }
      this.refreshItems();
    } catch (error) {
      this.def = null;
      this.engine = null;
      this.parseError = error instanceof Error ? error.message : 'This calendar can’t be read.';
    }
  }

  private commit(def: CalendarDef, options: { undoable?: boolean } = {}): void {
    if (!this.canEdit) return;
    if (options.undoable && this.def) this.undo = this.def;
    const text = serializeCalendar(def);
    this.lastEmitted = text;
    this.def = parseCalendarFile(text);
    this.engine = new CalendarEngine(this.def);
    this.contentChange.emit(text);
    this.calendars.updateFromContent(this.serverId, this.path, text);
    if (this.month >= this.def.months.length) this.month = 0;
    this.refreshItems();
  }

  // ---- The month view ----

  private loaded(): LoadedCalendar | null {
    if (!this.def || !this.engine) return null;
    return { path: this.path, name: this.def.name, def: this.def, engine: this.engine };
  }

  /** Re-reads what's dated in this calendar and lays out the month. */
  refreshItems(): void {
    const calendar = this.loaded();
    if (!calendar || !this.serverId) {
      this.items = [];
      this.layout();
      return;
    }
    const cached = this.calendars.cached(this.serverId);
    if (!cached) {
      void this.calendars.load(this.serverId);
    }
    // Notes dated (or mentioned) in this calendar; holidays come from the engine directly.
    this.items = this.calendars.datedItems(this.serverId, calendar, { mentions: true });
    this.layout();
  }

  private layout(): void {
    const engine = this.engine;
    if (!engine || !this.def) {
      this.weeks = [];
      this.festival = [];
      return;
    }
    const days = engine.daysInMonth(this.year, this.month);
    const today = engine.today();
    const todayNumber = today ? engine.toDayNumber(today) : null;
    const selectedNumber = this.selected ? engine.toDayNumber(this.selected) : null;
    const cell = (day: number): DayCell => {
      const date = { year: this.year, month: this.month, day };
      const dayNumber = engine.toDayNumber(date);
      return {
        date,
        dayNumber,
        isToday: dayNumber === todayNumber,
        isSelected: dayNumber === selectedNumber,
        holidays: engine.holidaysOn(date),
        items: this.calendars.itemsOn(this.items, dayNumber).filter(item => item.kind !== 'holiday'),
      };
    };

    const month = this.def.months[this.month];
    const week = this.def.weekdays.length || 7;
    if (month?.intercalary || !this.def.weekdays.length && days < 7) {
      this.weeks = [];
      this.festival = Array.from({ length: days }, (_, i) => cell(i + 1));
      return;
    }
    this.festival = [];
    const lead = this.def.weekdays.length ? engine.weekday({ year: this.year, month: this.month, day: 1 }) ?? 0 : 0;
    const cells: (DayCell | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => cell(i + 1))];
    while (cells.length % week) cells.push(null);
    this.weeks = [];
    for (let i = 0; i < cells.length; i += week) this.weeks.push(cells.slice(i, i + week));
  }

  get weekdayHeaders(): string[] {
    return this.def?.weekdays ?? [];
  }

  get monthLabel(): string {
    return this.engine ? `${this.engine.monthName(this.month)} ${this.engine.formatYear(this.year)}` : '';
  }

  get monthMissing(): boolean {
    return !!this.engine && this.engine.daysInMonth(this.year, this.month) === 0;
  }

  shiftMonth(step: number): void {
    if (!this.engine) return;
    const next = this.engine.addMonths({ year: this.year, month: this.month, day: 1 }, step);
    this.year = next.year;
    this.month = next.month;
    this.refreshItems();
  }

  shiftYear(step: number): void {
    if (!this.engine) return;
    const next = this.engine.addYears({ year: this.year, month: this.month, day: 1 }, step);
    this.year = next.year;
    this.month = next.month;
    this.refreshItems();
  }

  goToToday(): void {
    const today = this.engine?.today();
    if (!today) return;
    this.year = today.year;
    this.month = today.month;
    this.selected = today;
    this.refreshItems();
  }

  /** Jumps to a typed date, month or year ("1385 DR", "Mirtul 1492", "15 Mirtul 1492 DR"). */
  jump(): void {
    if (!this.goTo(this.jumpText)) {
      this.jumpError = `“${this.jumpText}” isn’t a date in ${this.title}.`;
      return;
    }
    this.jumpText = '';
    this.jumpError = '';
  }

  private goTo(text: string): boolean {
    const parsed = this.engine?.parse(text);
    if (!parsed) return false;
    this.year = parsed.date.year;
    this.month = parsed.date.month;
    this.selected = parsed.precision === 'day' ? parsed.date : null;
    this.refreshItems();
    return true;
  }

  onGridKeydown(event: KeyboardEvent): void {
    if ((event.target as Element).closest('input, select, textarea')) return;
    if (event.key === 'PageUp' || (event.key === 'ArrowLeft' && event.altKey)) this.shiftMonth(-1);
    else if (event.key === 'PageDown' || (event.key === 'ArrowRight' && event.altKey)) this.shiftMonth(1);
    else if (this.selected && this.engine && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -(this.def?.weekdays.length || 7), ArrowDown: this.def?.weekdays.length || 7 }[event.key]!;
      this.selectDay(this.engine.addDays(this.selected, step));
    } else if (event.key === 'Escape') this.selected = null;
    else return;
    event.preventDefault();
  }

  selectDay(date: CalendarDate): void {
    this.selected = date;
    this.newNoteFolders = [];
    if (date.year !== this.year || date.month !== this.month) {
      this.year = date.year;
      this.month = date.month;
      this.refreshItems();
    } else {
      this.layout();
    }
  }

  // ---- The selected day ----

  get selectedLabel(): string {
    return this.selected && this.engine ? this.engine.formatLong(this.selected) : '';
  }

  get selectedRelative(): string | null {
    return this.selected && this.engine ? this.engine.relativeToToday(this.selected) : null;
  }

  get selectedHolidays(): CalendarHoliday[] {
    return this.selected && this.engine ? this.engine.holidaysOn(this.selected) : [];
  }

  get selectedItems(): DatedItem[] {
    if (!this.selected || !this.engine) return [];
    return this.calendars.itemsOn(this.items, this.engine.toDayNumber(this.selected)).filter(item => item.kind !== 'holiday');
  }

  isToday(date: CalendarDate | null): boolean {
    const today = this.engine?.today();
    return !!date && !!today && this.engine!.compare(date, today) === 0;
  }

  setToday(): void {
    if (!this.selected || !this.def || !this.engine) return;
    this.commit({ ...this.def, today: this.engine.format(this.selected) });
    this.snackBar.open(`Today is now ${this.engine.formatLong(this.selected)}.`, 'OK', { duration: 3000 });
  }

  async copyDate(): Promise<void> {
    if (!this.selected || !this.engine) return;
    const text = inlineDate(this.engine.format(this.selected));
    try {
      await navigator.clipboard.writeText(text);
      this.snackBar.open(`Copied ${text}. Paste it into a note.`, 'OK', { duration: 3000 });
    } catch {
      this.snackBar.open('Couldn’t copy to the clipboard.', 'OK', { duration: 3000 });
    }
  }

  openItem(item: DatedItem): void {
    if (item.path) this.openFile.emit(item.path);
  }

  onItemEnter(item: DatedItem, element: HTMLElement): void {
    if (item.path) this.linkHover.emit({ target: item.path, rect: element.getBoundingClientRect() });
  }

  onItemLeave(): void {
    this.linkHover.emit(null);
  }

  openHoliday(holiday: CalendarHoliday): void {
    if (holiday.link) this.openFile.emit(holiday.link);
  }

  async prepareNewNote(): Promise<void> {
    if (!this.serverId) return;
    this.newNoteFolders = await this.noteInsert.folders(this.serverId);
    this.newNoteFolder = null;
    this.newNoteTitle = '';
  }

  /** Creates a note dated on the selected day (its `date` and `calendar` properties set). */
  async createNoteOnDay(): Promise<void> {
    const title = this.newNoteTitle.trim();
    if (!this.selected || !this.engine || !title || this.newNoteFolder === null) return;
    const content = ['---', `date: ${this.engine.format(this.selected)}`, `calendar: ${this.title}`, '---', '', ''].join('\n');
    try {
      const path = await this.noteInsert.createNote(this.serverId, this.newNoteFolder, title, content);
      this.newNoteFolders = [];
      await this.vaultIndexService.ensureContentIndexed(this.serverId);
      this.refreshItems();
      this.snackBar.open(`Created “${title}” on ${this.engine.format(this.selected)}.`, 'Open', { duration: 5000 })
        .onAction().subscribe(() => this.openFile.emit(path));
    } catch {
      this.snackBar.open(`Couldn’t create “${title}”.`, 'OK', { duration: 4000 });
    }
  }

  // ---- Settings ----

  toggleSettings(): void {
    if (!this.canEdit) return;
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsOpen) this.loadNoteNames();
  }

  private loadNoteNames(): void {
    const index = this.vaultIndexService.get(this.serverId);
    this.noteNames = (index?.files ?? [])
      .filter(file => getVaultFileType(file.name).id === 'markdown')
      .map(file => index!.linkTextFor(file))
      .sort((a, b) => a.localeCompare(b));
  }

  update(changes: Partial<CalendarDef>): void {
    if (this.def) this.commit({ ...this.def, ...changes });
  }

  setDefault(value: boolean): void {
    this.update({ default: value });
    if (value) this.snackBar.open(`${this.title} is now the default calendar. Other calendars marked default should be unmarked.`, 'OK', { duration: 4000 });
  }

  // Months.
  updateMonth(index: number, changes: Partial<CalendarMonth>): void {
    if (!this.def) return;
    const old = this.def.months[index];
    const months = this.def.months.map((month, i) => (i === index ? { ...month, ...changes } : month));
    let def: CalendarDef = { ...this.def, months };
    // Renaming a month keeps the leap days and holidays that refer to it.
    if (changes.name && old && changes.name !== old.name) def = renameMonthReferences(def, old.name, changes.name);
    this.commit(def);
  }

  addMonth(): void {
    if (!this.def) return;
    this.commit({ ...this.def, months: [...this.def.months, { name: `Month ${this.def.months.length + 1}`, days: 30, intercalary: false }] });
  }

  moveMonth(index: number, step: number): void {
    if (!this.def) return;
    this.commit({ ...this.def, months: move(this.def.months, index, step) });
  }

  removeMonth(index: number): void {
    if (!this.def || this.def.months.length <= 1) return;
    const name = this.def.months[index].name;
    this.commit({ ...this.def, months: this.def.months.filter((_, i) => i !== index) }, { undoable: true });
    this.offerUndo(`Removed the month “${name}”.`);
  }

  // Weekdays.
  updateWeekday(index: number, name: string): void {
    if (!this.def || !name.trim()) return;
    this.commit({ ...this.def, weekdays: this.def.weekdays.map((day, i) => (i === index ? name.trim() : day)) });
  }

  addWeekday(): void {
    if (!this.def) return;
    this.commit({ ...this.def, weekdays: [...this.def.weekdays, `Day ${this.def.weekdays.length + 1}`] });
  }

  moveWeekday(index: number, step: number): void {
    if (!this.def) return;
    this.commit({ ...this.def, weekdays: move(this.def.weekdays, index, step) });
  }

  removeWeekday(index: number): void {
    if (!this.def) return;
    const name = this.def.weekdays[index];
    const firstWeekday = Math.min(this.def.firstWeekday, Math.max(0, this.def.weekdays.length - 2));
    this.commit({ ...this.def, weekdays: this.def.weekdays.filter((_, i) => i !== index), firstWeekday }, { undoable: true });
    this.offerUndo(`Removed the weekday “${name}”.`);
  }

  // Leap days.
  updateLeap(index: number, changes: Record<string, unknown>): void {
    if (!this.def) return;
    this.commit({ ...this.def, leapDays: this.def.leapDays.map((leap, i) => (i === index ? { ...leap, ...changes } : leap)) });
  }

  addLeap(): void {
    if (!this.def) return;
    this.commit({ ...this.def, leapDays: [...this.def.leapDays, { month: this.def.months[0]?.name ?? '', interval: '4', offset: 0 }] });
  }

  removeLeap(index: number): void {
    if (!this.def) return;
    this.commit({ ...this.def, leapDays: this.def.leapDays.filter((_, i) => i !== index) }, { undoable: true });
    this.offerUndo('Removed the leap day.');
  }

  // Eras.
  updateEra(index: number, changes: Partial<CalendarEra>): void {
    if (!this.def) return;
    this.commit({ ...this.def, eras: this.def.eras.map((era, i) => (i === index ? { ...era, ...changes } : era)) });
  }

  addEra(): void {
    if (!this.def) return;
    const last = Math.max(0, ...this.def.eras.map(era => era.startYear ?? 0));
    this.commit({ ...this.def, eras: [...this.def.eras, { name: 'New Era', abbr: 'NE', startYear: last + 1000, count: 'up' }] });
  }

  removeEra(index: number): void {
    if (!this.def) return;
    const name = this.def.eras[index].name;
    this.commit({ ...this.def, eras: this.def.eras.filter((_, i) => i !== index) }, { undoable: true });
    this.offerUndo(`Removed the era “${name}”.`);
  }

  /** "Year 0 shows as 1 BC; year 1 as 1 AD" — how eras label the years around their edges. */
  get eraPreview(): string {
    const engine = this.engine;
    if (!engine || !this.def?.eras.length) return '';
    const years = new Set<number>();
    for (const era of this.def.eras) {
      if (era.startYear != null) [era.startYear - 1, era.startYear].forEach(year => years.add(year));
      if (era.endYear != null) [era.endYear, era.endYear + 1].forEach(year => years.add(year));
    }
    return Array.from(years).sort((a, b) => a - b).slice(0, 6).map(year => `${year} → ${engine.formatYear(year)}`).join(',  ');
  }

  // Holidays.
  updateHoliday(id: string, changes: Partial<CalendarHoliday>): void {
    if (!this.def) return;
    this.commit({ ...this.def, holidays: this.def.holidays.map(holiday => (holiday.id === id ? { ...holiday, ...changes } : holiday)) });
  }

  updateHolidayDate(holiday: CalendarHoliday, changes: Partial<CalendarHoliday['date']>): void {
    this.updateHoliday(holiday.id, { date: { ...holiday.date, ...changes } });
  }

  setHolidayRule(holiday: CalendarHoliday, rule: 'day' | 'nth'): void {
    this.updateHolidayDate(holiday, rule === 'day'
      ? { day: holiday.date.day ?? 1, weekday: null, nth: null }
      : { day: null, weekday: holiday.date.weekday ?? 0, nth: holiday.date.nth ?? 1 });
  }

  addHoliday(): void {
    if (!this.def) return;
    const month = this.selected ? this.def.months[this.selected.month]?.name : this.def.months[0]?.name;
    const holiday: CalendarHoliday = {
      id: newHolidayId(),
      name: 'New holiday',
      date: { month: month ?? '', day: this.selected?.day ?? 1 },
      repeat: 'yearly',
      since: null,
      until: null,
      link: null,
      color: '#8fe0ad',
    };
    this.commit({ ...this.def, holidays: [...this.def.holidays, holiday] });
  }

  removeHoliday(holiday: CalendarHoliday): void {
    if (!this.def) return;
    this.commit({ ...this.def, holidays: this.def.holidays.filter(item => item.id !== holiday.id) }, { undoable: true });
    this.offerUndo(`Removed “${holiday.name}”.`);
  }

  /** "1350 DR" for a holiday's first/last year fields. */
  yearText(year: number | null | undefined): string {
    return year == null || !this.engine ? '' : this.engine.formatYear(year);
  }

  /** Reads a year typed as "1350 DR" (or a plain number in the default era). */
  setHolidayYear(holiday: CalendarHoliday, key: 'since' | 'until' | 'year', text: string): void {
    const clean = text.trim();
    if (!clean) {
      this.updateHoliday(holiday.id, { [key]: null });
      return;
    }
    const parsed = this.engine?.parse(clean);
    if (!parsed) {
      this.snackBar.open(`“${clean}” isn’t a year in ${this.title}.`, 'OK', { duration: 3000 });
      return;
    }
    this.updateHoliday(holiday.id, { [key]: parsed.date.year });
  }

  nthLabel(nth: number | null | undefined): string {
    return ({ 1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', 5: 'Fifth', [-1]: 'Last' } as Record<number, string>)[nth ?? 1] ?? 'First';
  }

  private offerUndo(message: string): void {
    this.snackBar.open(message, 'Undo', { duration: 6000 }).onAction().subscribe(() => {
      if (this.undo) this.commit(this.undo);
      this.undo = null;
    });
  }

  trackIndex(index: number): number {
    return index;
  }
}

function move<T>(list: T[], index: number, step: number): T[] {
  const target = index + step;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function renameMonthReferences(def: CalendarDef, from: string, to: string): CalendarDef {
  const same = (name: string) => name.trim().toLowerCase() === from.trim().toLowerCase();
  return {
    ...def,
    leapDays: def.leapDays.map(leap => (same(leap.month) ? { ...leap, month: to } : leap)),
    holidays: def.holidays.map(holiday => (same(holiday.date.month) ? { ...holiday, date: { ...holiday.date, month: to } } : holiday)),
  };
}
