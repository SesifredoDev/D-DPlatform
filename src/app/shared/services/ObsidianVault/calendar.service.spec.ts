import { CalendarEngine } from './calendar-engine';
import { CalendarService, LoadedCalendar } from './calendar.service';
import { CALENDAR_PRESETS } from './vault-calendar';

function loaded(id: string, path: string, isDefault = false): LoadedCalendar {
  const def = { ...CALENDAR_PRESETS.find(item => item.id === id)!.build(), default: isDefault };
  return { path, name: def.name, def, engine: new CalendarEngine(def) };
}

describe('CalendarService: which calendar a date is in', () => {
  const service = new CalendarService({} as never, {} as never);
  const gregorian = loaded('gregorian', 'Calendars/Gregorian.calendar', true);
  const harptos = loaded('harptos', 'Calendars/Harptos.calendar');
  const list = [gregorian, harptos];

  it('works it out from month and era names, falling back to the default', () => {
    expect(service.resolve(list, '15 Mirtul 1492 DR')?.calendar).toBe(harptos);
    expect(service.resolve(list, '4 July 1776 AD')?.calendar).toBe(gregorian);
    expect(service.resolve(list, '1492')?.calendar).toBe(gregorian);
    expect(service.resolve(list, 'Frostmoon 3')).toBeNull();
  });

  it('honours a calendar named first, and the note’s own calendar', () => {
    expect(service.resolve(list, 'Harptos 1492')?.label).toBe('1492 DR');
    expect(service.resolve(list, '1492', { preferred: harptos })?.calendar).toBe(harptos);
  });

  it('chains relative dates from the one before', () => {
    const resolved = service.resolveSequence(list, ['28 Hammer 1492 DR', '3 days later', 'the next day', 'nonsense'], null);
    expect(resolved.map(item => item?.label ?? null)).toEqual(['28 Hammer 1492 DR', 'Midwinter 1492 DR', '1 Alturiak 1492 DR', null]);
  });

  it('finds calendars by path, name or file name', () => {
    expect(service.find(list, 'Harptos')).toBe(harptos);
    expect(service.find(list, '[[Gregorian]]')).toBe(gregorian);
    expect(service.find(list, 'Nope')).toBeNull();
    expect(service.defaultCalendar(list)).toBe(gregorian);
  });
});
