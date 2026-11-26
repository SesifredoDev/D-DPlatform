import type { EditorView } from '@milkdown/prose/view';
import type { CalendarDate } from '../../services/ObsidianVault/calendar-engine';
import type { LoadedCalendar } from '../../services/ObsidianVault/calendar.service';
import { inlineDate } from '../../services/ObsidianVault/inline-dates';

/**
 * A small calendar at the cursor ("+ → Date"): pick a day and `[date:: …]` is inserted. Works in any
 * of the vault's calendars. Keyboard: arrows move, Page Up/Down change month, Enter inserts, Esc closes.
 */
export function openDatePicker(view: EditorView, calendars: LoadedCalendar[], preferred: LoadedCalendar | null): void {
  document.querySelector('.date-picker')?.remove();
  if (!calendars.length) {
    showNotice(view, 'No calendars yet. Create one with + → New calendar in the file list.');
    return;
  }

  const insertAt = view.state.selection.from;
  let calendar = preferred ?? calendars.find(item => item.def.default) ?? calendars[0];
  let selected: CalendarDate = startDate(calendar);
  let year = selected.year;
  let month = selected.month;

  const popup = document.createElement('div');
  popup.className = 'date-picker';
  popup.tabIndex = -1;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Insert a date');
  document.body.append(popup);

  const close = (refocus = true) => {
    popup.remove();
    document.removeEventListener('mousedown', onOutside, true);
    if (refocus) view.focus();
  };

  const insert = () => {
    const label = calendar.engine.format(selected);
    // Name the calendar when it isn't the note's/default one, so the date reads back the same.
    const usual = preferred ?? calendars.find(item => item.def.default) ?? calendars[0];
    const text = calendar === usual ? label : `${calendar.name} ${label}`;
    const before = view.state.doc.textBetween(Math.max(0, insertAt - 1), insertAt);
    const spacer = before && !/\s/.test(before) ? ' ' : '';
    view.dispatch(view.state.tr.insertText(`${spacer}${inlineDate(text)} `, insertAt).scrollIntoView());
    close();
  };

  const move = (date: CalendarDate) => {
    selected = date;
    year = date.year;
    month = date.month;
    render();
  };

  const render = () => {
    const engine = calendar.engine;
    popup.replaceChildren();

    if (calendars.length > 1) {
      const select = document.createElement('select');
      select.className = 'date-picker-calendar';
      select.setAttribute('aria-label', 'Calendar');
      calendars.forEach((item, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = item.name;
        option.selected = item === calendar;
        select.append(option);
      });
      select.addEventListener('change', () => {
        calendar = calendars[Number(select.value)];
        move(startDate(calendar));
      });
      popup.append(select);
    }

    const header = document.createElement('div');
    header.className = 'date-picker-header';
    const prev = button('‹', 'Previous month', () => move(engine.addMonths({ year, month, day: 1 }, -1)));
    const next = button('›', 'Next month', () => move(engine.addMonths({ year, month, day: 1 }, 1)));
    const label = document.createElement('span');
    label.className = 'date-picker-label';
    label.textContent = `${engine.monthName(month)} ${engine.formatYear(year)}`;
    header.append(prev, label, next);
    popup.append(header);

    const days = engine.daysInMonth(year, month);
    const weekdays = calendar.def.weekdays;
    const intercalary = !!calendar.def.months[month]?.intercalary;
    const grid = document.createElement('div');
    grid.className = 'date-picker-grid';
    grid.style.setProperty('--cols', String(intercalary || !weekdays.length ? Math.min(days, 7) || 1 : weekdays.length));
    if (!intercalary) {
      weekdays.forEach(day => {
        const cell = document.createElement('span');
        cell.className = 'date-picker-weekday';
        cell.textContent = day.slice(0, 2);
        cell.title = day;
        grid.append(cell);
      });
      const lead = weekdays.length ? engine.weekday({ year, month, day: 1 }) ?? 0 : 0;
      for (let i = 0; i < lead; i++) grid.append(document.createElement('span'));
    }
    const today = engine.today();
    for (let day = 1; day <= days; day++) {
      const date = { year, month, day };
      const cell = button(String(day), engine.formatLong(date), () => {
        selected = date;
        insert();
      });
      cell.className = 'date-picker-day';
      if (today && engine.compare(date, today) === 0) cell.classList.add('is-today');
      if (selected.year === year && selected.month === month && selected.day === day) cell.classList.add('is-selected');
      if (engine.holidaysOn(date).length) {
        cell.classList.add('has-holiday');
        cell.title += ` (${engine.holidaysOn(date).map(holiday => holiday.name).join(', ')})`;
      }
      grid.append(cell);
    }
    popup.append(grid);

    const footer = document.createElement('div');
    footer.className = 'date-picker-footer';
    const preview = document.createElement('span');
    preview.textContent = engine.formatLong(selected);
    footer.append(preview);
    if (today) footer.append(button('Today', 'Go to today', () => move(today)));
    popup.append(footer);
  };

  const onKeydown = (event: KeyboardEvent) => {
    const engine = calendar.engine;
    const week = calendar.def.weekdays.length || 7;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -week, ArrowDown: week };
    if (event.key in steps) move(engine.addDays(selected, steps[event.key]));
    else if (event.key === 'PageUp') move(engine.addMonths(selected, -1));
    else if (event.key === 'PageDown') move(engine.addMonths(selected, 1));
    else if (event.key === 'Enter') insert();
    else if (event.key === 'Escape') close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onOutside = (event: MouseEvent) => {
    if (!popup.contains(event.target as Node)) close(false);
  };

  popup.addEventListener('keydown', onKeydown);
  document.addEventListener('mousedown', onOutside, true);
  render();

  const coords = view.coordsAtPos(insertAt);
  const height = popup.offsetHeight;
  const width = popup.offsetWidth;
  popup.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - width - 8))}px`;
  popup.style.top = `${coords.bottom + 6 + height < window.innerHeight ? coords.bottom + 6 : Math.max(8, coords.top - height - 6)}px`;
  popup.focus();
}

function startDate(calendar: LoadedCalendar): CalendarDate {
  const today = calendar.engine.today();
  if (today) return today;
  const first = calendar.engine.monthsOf(1)[0];
  return { year: 1, month: first?.index ?? 0, day: 1 };
}

function button(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.title = label;
  element.setAttribute('aria-label', label);
  element.addEventListener('mousedown', event => event.preventDefault());
  element.addEventListener('click', onClick);
  return element;
}

function showNotice(view: EditorView, text: string): void {
  const notice = document.createElement('div');
  notice.className = 'date-picker is-notice';
  notice.textContent = text;
  document.body.append(notice);
  const coords = view.coordsAtPos(view.state.selection.from);
  notice.style.left = `${Math.max(8, coords.left)}px`;
  notice.style.top = `${coords.bottom + 6}px`;
  setTimeout(() => notice.remove(), 4000);
}
