/**
 * Turns vault content into Markdown for players: what a broadcast sends to text channels, whispers
 * and the call overlay (all rendered with ngx-markdown). GM-only content never makes it through:
 * secret callouts and `%%comments%%` are stripped from every piece of text, and GM-only map pins are
 * left out (see obsidian-broadcast.service.ts, which also renders maps and family trees as images).
 *
 * Embeds (`![[…]]`) are left in place here; the broadcast service resolves them against the vault.
 *
 * Pure functions, no Angular.
 */
import type { BaseConfig, BaseResult } from './bases';
import { defaultColumnName, valueToText } from './bases';
import type { CalendarDate, CalendarEngine } from './calendar-engine';
import type { TimelineEntry } from './calendar.service';
import type { FamilyTree } from './family-tree';
import { splitFrontmatter } from './frontmatter';
import { INLINE_DATE } from './inline-dates';
import { stripSecrets } from './secrets';
import {
  BlockKind,
  blockKindOf,
  dndModifier,
  entriesValue,
  extraKeys,
  formatSigned,
  formatSubtitle,
  keyLabel,
  parseStatblock,
  scoresValue,
  statblockImage,
  textValue,
} from './statblock';
import { getStatblockSystem } from './statblock-systems';
import { getVaultDisplayName } from './vault-file-types';

/** Most rows a broadcast table or list shows; the rest are summarised as "…and N more". */
export const BROADCAST_ROW_LIMIT = 150;

/** Text with GM secrets removed, and how many were removed. */
export function playerText(text: string): { text: string; removed: number } {
  const stripped = stripSecrets(text);
  return { text: stripped.markdown.trim(), removed: stripped.removed };
}

// ---- Notes ----

const STATBLOCK_FENCE = /^(`{3,}|~{3,})[ \t]*([\w-]+)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
const CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$|`[^`\n]*`/gm;

/**
 * A note's text as players should read it. Run after `stripSecrets` and `formatCalloutsForBroadcast`:
 * drops the frontmatter, writes statblock / item / spell blocks out as cards, turns `[date:: …]` into
 * the date and `[[links]]` into their names (players can't open the GM's vault). Code is left alone.
 */
export function noteBroadcastMarkdown(markdown: string): string {
  const body = splitFrontmatter(markdown.replace(/\r\n/g, '\n')).body;
  const withBlocks = body.replace(STATBLOCK_FENCE, (whole, _fence: string, language: string, source: string) => {
    const kind = blockKindOf(language);
    return kind ? statblockMarkdown(kind, source.replace(/\n$/, '')) : whole;
  });
  return outsideCode(withBlocks, text => text
    .replace(new RegExp(INLINE_DATE.source, 'gi'), (_, date: string) => date.trim())
    .replace(/(?<!!)\[\[([^\]\n]+)\]\]/g, (_, inner: string) => wikilinkText(inner)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `Lore/Waterdeep.md#Docks|the docks` → "the docks"; without an alias → "Waterdeep". */
export function wikilinkText(inner: string): string {
  const [target, ...alias] = inner.split('|');
  const shown = alias.join('|').trim();
  if (shown) return shown;
  const [path, ...anchor] = target.split('#');
  return linkDisplayName(path) || anchor.join('#').replace(/^\^/, '').trim() || target.trim();
}

/** "Maps/Sword Coast.map" → "Sword Coast". */
export function linkDisplayName(path: string): string {
  const name = path.trim().split('/').pop() ?? '';
  return getVaultDisplayName(name);
}

/** True for an embed's `|…` part that is a size (`300`, `x420`, `300x200`) rather than a caption. */
export function isEmbedSize(text: string): boolean {
  return /^\s*(\d+)?(x\d+)?\s*$/i.test(text) && /\d/.test(text);
}

/** Applies `transform` to the parts of `markdown` outside code blocks and inline code. */
export function outsideCode(markdown: string, transform: (text: string) => string): string {
  let out = '';
  let last = 0;
  for (const match of markdown.matchAll(CODE)) {
    out += transform(markdown.slice(last, match.index)) + match[0];
    last = (match.index ?? 0) + match[0].length;
  }
  return out + transform(markdown.slice(last));
}

// ---- Statblocks, items and spells ----

/**
 * A statblock / item / spell block as a Markdown card (a blockquote), laid out the way its system
 * lays out the card in the editor. A vault picture is kept as `![[…]]` for the broadcast to attach.
 * Blocks that can't be read give ''.
 */
export function statblockMarkdown(kind: BlockKind, source: string): string {
  const parsed = parseStatblock(source, kind);
  if (parsed.error) return '';
  const data = parsed.data;
  const system = getStatblockSystem(data['system'], kind);
  const sections: string[][] = [];

  const head = [`### ${inline(textValue(data['name'])) || 'Unnamed'}`];
  const subtitle = formatSubtitle(system, data);
  if (subtitle) head.push(`*${inline(subtitle)}*`);
  sections.push(head);

  const image = statblockImage(data);
  if (image) sections.push([/^https?:\/\//i.test(image) ? `![${inline(textValue(data['name']))}](${image})` : `![[${image}]]`]);

  for (const block of system.blocks) {
    if (block.kind === 'fields') {
      const lines = block.fields.flatMap(field => {
        const value = textValue(data[field.key]).trim();
        if (!value) return [];
        const extra = field.extraKey ? textValue(data[field.extraKey]).trim() : '';
        return [`**${field.label}** ${inline(value)}${extra ? ` (${inline(extra)})` : ''}`];
      });
      if (lines.length) sections.push([hardBreaks(lines)]);
    } else if (block.kind === 'scores') {
      const scores = scoresValue(data[block.key], block.labels.length);
      if (!scores.some(Boolean)) continue;
      const cells = scores.map(score => {
        if (!score) return '—';
        if (block.modifier === 'dnd') {
          const modifier = dndModifier(score);
          return modifier === null ? cell(score) : `${cell(score)} (${formatSigned(modifier)})`;
        }
        const number = Number(score);
        return block.signed && Number.isFinite(number) ? formatSigned(number) : cell(score);
      });
      sections.push([tableRow(block.labels), tableRow(block.labels.map(() => ':-:')), tableRow(cells)]);
    } else if (block.kind === 'entries') {
      const entries = entriesValue(data[block.key]).filter(entry => entry.name || entry.desc);
      if (!entries.length) continue;
      sections.push([
        ...(block.untitled ? [] : [`#### ${block.title}`]),
        ...entries.map(entry => entry.name ? `***${inline(entry.name)}.*** ${entry.desc.trim()}` : entry.desc.trim()),
      ]);
    } else {
      const text = textValue(data[block.key]).trim();
      if (text) sections.push([`#### ${block.title}`, text]);
    }
  }

  const extras = extraKeys(system, data);
  const extraFields = extras.fields.map(key => `**${keyLabel(key)}** ${inline(textValue(data[key]))}`);
  if (extraFields.length) sections.push([hardBreaks(extraFields)]);
  for (const key of extras.entries) {
    const entries = entriesValue(data[key]).filter(entry => entry.name || entry.desc);
    if (entries.length) {
      sections.push([`#### ${keyLabel(key)}`, ...entries.map(entry => `***${inline(entry.name)}.*** ${entry.desc.trim()}`)]);
    }
  }

  return blockquote(sections.map(section => section.join('\n\n')).join('\n\n'));
}

// ---- Family trees ----

/**
 * The tree players may see: names and details without GM secrets. Someone whose whole name is a
 * secret (`%%Hidden heir%%`) is left out, with their relations.
 */
export function playerFamilyTree(tree: FamilyTree): { tree: FamilyTree; removed: number } {
  let removed = 0;
  const people = tree.people.flatMap(person => {
    const name = playerText(person.name);
    const details = playerText(person.details);
    removed += name.removed + details.removed;
    return name.text ? [{ ...person, name: name.text, details: details.text }] : [];
  });
  const kept = new Set(people.map(person => person.id));
  const relations = tree.relations.filter(relation => kept.has(relation.from) && kept.has(relation.to));
  return { tree: { ...tree, people, relations }, removed };
}

// ---- Calendars and timelines ----

/**
 * A calendar's month as a table (weekdays across, today in bold, holidays marked), with the month's
 * holidays listed under it. Shows the month of `focus`, else of the campaign's today.
 */
export function calendarMarkdown(engine: CalendarEngine, focus: CalendarDate | null = null): { markdown: string; removed: number } {
  const def = engine.def;
  const today = engine.today();
  const shown = focus ?? today ?? { year: 1, month: 0, day: 1 };
  const months = engine.monthsOf(shown.year);
  const month = months.find(item => item.index === shown.month) ?? months[0];
  const lines: string[] = [];
  let removed = 0;

  if (today) lines.push(`**Today:** ${engine.formatLong(today)}`, '');
  if (!month) return { markdown: lines.join('\n').trim(), removed };

  lines.push(`### ${engine.format({ year: shown.year, month: month.index, day: 1 }, 'month')}`, '');
  const holidays: { day: number; names: string[] }[] = [];
  for (let day = 1; day <= month.days; day++) {
    const names = engine.holidaysOn({ year: shown.year, month: month.index, day }).flatMap(holiday => {
      const name = playerText(holiday.name);
      removed += name.removed;
      return name.text ? [inline(name.text)] : [];
    });
    if (names.length) holidays.push({ day, names });
  }
  const holidayDays = new Set(holidays.map(item => item.day));
  const isToday = (day: number) => !!today && today.year === shown.year && today.month === month.index && today.day === day;
  const dayCell = (day: number) => {
    const text = `${day}${holidayDays.has(day) ? ' ✦' : ''}`;
    return isToday(day) ? `**${text}**` : text;
  };

  const weekdays = def.weekdays;
  if (weekdays.length && !month.month.intercalary) {
    const first = engine.weekday({ year: shown.year, month: month.index, day: 1 }) ?? 0;
    const cells: string[] = Array.from({ length: first }, () => '');
    for (let day = 1; day <= month.days; day++) cells.push(dayCell(day));
    while (cells.length % weekdays.length) cells.push('');
    lines.push(tableRow(weekdays.map(cell)), tableRow(weekdays.map(() => ':-:')));
    for (let i = 0; i < cells.length; i += weekdays.length) lines.push(tableRow(cells.slice(i, i + weekdays.length)));
  } else {
    lines.push(month.days === 1 ? '*A festival day outside the week.*' : `*${month.days} days outside the week.*`);
  }

  if (holidays.length) {
    lines.push('', '**Holidays**', '');
    for (const item of holidays) {
      lines.push(`- ${engine.format({ year: shown.year, month: month.index, day: item.day })} — ${item.names.join(', ')}`);
    }
  }
  return { markdown: lines.join('\n').trim(), removed };
}

/** A timeline's entries in date order, with a "Today" marker between past and future. */
export function timelineMarkdown(engine: CalendarEngine, entries: TimelineEntry[]): { markdown: string; removed: number } {
  let removed = 0;
  const visible = entries.flatMap(entry => {
    const title = playerText(entry.title);
    removed += title.removed;
    return title.text ? [{ ...entry, title: title.text }] : [];
  });
  if (!visible.length) return { markdown: '*Nothing on this timeline yet.*', removed };

  const today = engine.today();
  const todayDay = today ? engine.toDayNumber(today) : null;
  const lines: string[] = [];
  let markedToday = todayDay === null;
  const shownEntries = visible.slice(0, BROADCAST_ROW_LIMIT);
  for (const entry of shownEntries) {
    if (!markedToday && entry.day > todayDay!) {
      lines.push(`- **${engine.format(today!)}** — *Today*`);
      markedToday = true;
    }
    const end = entry.endDay !== null && entry.endDay !== entry.day
      ? ` – ${engine.format(engine.fromDayNumber(entry.endDay), entry.precision)}`
      : '';
    const lane = entry.kind === 'event' && entry.lane && entry.lane !== 'Events' ? ` *(${inline(entry.lane)})*` : '';
    lines.push(`- **${entry.label}${end}** — ${inline(entry.title)}${lane}`);
  }
  if (!markedToday && visible.length <= BROADCAST_ROW_LIMIT) lines.push(`- **${engine.format(today!)}** — *Today*`);
  if (visible.length > shownEntries.length) lines.push('', `*…and ${visible.length - shownEntries.length} more.*`);
  return { markdown: lines.join('\n'), removed };
}

// ---- Canvases ----

interface CanvasNode {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
}

/**
 * A canvas's cards in reading order (top to bottom, left to right), grouped under their groups'
 * labels. Text cards are stripped of secrets; file cards become `![[file]]` embeds for the broadcast
 * to resolve; web links stay links.
 */
export function canvasMarkdown(text: string): { markdown: string; removed: number } {
  let data: { nodes?: unknown };
  try {
    data = JSON.parse(text || '{}');
  } catch {
    throw new Error('This canvas file isn’t valid JSON.');
  }
  const nodes = (Array.isArray(data?.nodes) ? data.nodes : []).filter((node): node is CanvasNode => !!node && typeof node === 'object');
  const readingOrder = (a: CanvasNode, b: CanvasNode) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0);
  const groups = nodes.filter(node => node.type === 'group').sort(readingOrder);
  const area = (node: CanvasNode) => (node.width ?? 0) * (node.height ?? 0);
  const groupOf = (node: CanvasNode) => {
    const cx = (node.x ?? 0) + (node.width ?? 0) / 2;
    const cy = (node.y ?? 0) + (node.height ?? 0) / 2;
    return groups
      .filter(group => cx >= (group.x ?? 0) && cx <= (group.x ?? 0) + (group.width ?? 0) && cy >= (group.y ?? 0) && cy <= (group.y ?? 0) + (group.height ?? 0))
      .sort((a, b) => area(a) - area(b))[0] ?? null;
  };

  let removed = 0;
  const card = (node: CanvasNode): string => {
    if (node.type === 'text') {
      const stripped = playerText(node.text ?? '');
      removed += stripped.removed;
      return stripped.text;
    }
    if (node.type === 'file' && node.file) return `![[${node.file}${node.subpath ?? ''}]]`;
    if (node.type === 'link' && node.url && /^https?:\/\//i.test(node.url)) return `<${node.url}>`;
    return '';
  };

  const cards = nodes.filter(node => node.type !== 'group').sort(readingOrder);
  const loose = cards.filter(node => !groupOf(node)).map(card).filter(Boolean);
  const sections = [loose.join('\n\n---\n\n')];
  for (const group of groups) {
    const inside = cards.filter(node => groupOf(node) === group).map(card).filter(Boolean);
    if (!inside.length) continue;
    const label = playerText(group.label ?? '');
    removed += label.removed;
    sections.push([`### ${inline(label.text) || 'Group'}`, ...inside].join('\n\n'));
  }
  const markdown = sections.filter(Boolean).join('\n\n');
  return { markdown: markdown || '*This canvas is empty.*', removed };
}

// ---- Bases ----

/** A base view's rows as a table (one per group when the view groups them). */
export function baseMarkdown(config: BaseConfig, viewIndex: number, result: BaseResult): string {
  const view = config.views[viewIndex] ?? null;
  const columns = view?.order.length ? view.order : ['file.name'];
  const header = columns.map(property => cell(config.displayNames[property] ?? defaultColumnName(property)));
  const table = (rows: BaseResult['rows']) => {
    const lines = [tableRow(header), tableRow(columns.map(() => '---'))];
    for (const row of rows) {
      lines.push(tableRow(columns.map(property => {
        try {
          return cell(valueToText(row.context.property(property)));
        } catch {
          return '';
        }
      })));
    }
    return lines.join('\n');
  };

  const lines: string[] = view?.name && config.views.length > 1 ? [`*${inline(view.name)}*`, ''] : [];
  let shown = 0;
  if (result.groups) {
    for (const group of result.groups) {
      const rows = group.rows.slice(0, Math.max(0, BROADCAST_ROW_LIMIT - shown));
      if (!rows.length) continue;
      shown += rows.length;
      lines.push(`**${inline(group.label)}**`, '', table(rows), '');
    }
  } else {
    const rows = result.rows.slice(0, BROADCAST_ROW_LIMIT);
    shown = rows.length;
    lines.push(rows.length ? table(rows) : '*No matching notes.*');
  }
  const total = result.groups ? result.groups.reduce((sum, group) => sum + group.rows.length, 0) : result.rows.length;
  if (total > shown) lines.push('', `*…and ${total - shown} more.*`);
  return lines.join('\n').trim();
}

// ---- Markdown helpers ----

/** One line of text, safe inside a table cell or emphasis. */
function inline(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

function cell(text: string): string {
  return inline(text).replace(/\|/g, '\\|');
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** Lines in one paragraph, each on its own line (Markdown hard breaks). */
function hardBreaks(lines: string[]): string {
  return lines.join('  \n');
}

function blockquote(markdown: string): string {
  return markdown.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
}
