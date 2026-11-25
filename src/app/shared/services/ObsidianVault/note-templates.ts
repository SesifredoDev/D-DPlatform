import { getVaultDisplayName } from './vault-file-types';

export interface NoteTemplate {
  label: string;
  /** File name under assets/templates/. */
  fileName: string;
}

/** Templates offered when creating a note. Files live in assets/templates/. */
export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  { label: '5e Statblock', fileName: '5e Statblock.md' },
  { label: 'Historical Event', fileName: 'Historical Event.md' },
  { label: 'Item', fileName: 'Item.md' },
  { label: 'Location', fileName: 'Location.md' },
  { label: 'Lore & Mythology', fileName: 'Lore & Mythology.md' },
  { label: 'Magical Artefact or System', fileName: 'Magical Artefact or System.md' },
  { label: 'NPC', fileName: 'NPC.md' },
  { label: 'Organisation', fileName: 'Organisation.md' },
  { label: 'Player Character', fileName: 'Player Character.md' },
  { label: 'Quest', fileName: 'Quest.md' },
  { label: 'Race', fileName: 'Race.md' },
  { label: 'Session', fileName: '🎲 Session {{number}} - {{date}}.md' },
  { label: 'Story Arc', fileName: 'Story Arc.md' },
  { label: 'Story Event', fileName: 'Story Event.md' },
];

type TemplateVariableResolver = (context: { filePath: string; title: string; now: Date }) => string;

/**
 * `{{variable}}` placeholders available in templates. Add an entry here to support a new one;
 * unknown placeholders are left untouched.
 */
const TEMPLATE_VARIABLES: Record<string, TemplateVariableResolver> = {
  title: ({ title }) => title,
  name: ({ title }) => title,
  date: ({ now }) => formatDate(now),
  number: ({ title }) => title.match(/\d+/)?.[0] || '',
};

export function findNoteTemplate(fileName: string): NoteTemplate | undefined {
  return NOTE_TEMPLATES.find(template => template.fileName === fileName);
}

/** The template named like one of these tags (e.g. #quest → Quest, #npc → NPC), if any. */
export function findTemplateForTags(tags: readonly string[]): NoteTemplate | undefined {
  const wanted = new Set(tags.map(tag => tag.replace(/^#/, '').toLowerCase()));
  return NOTE_TEMPLATES.find(template => wanted.has(template.label.toLowerCase()));
}

export async function loadNoteTemplate(template: NoteTemplate, filePath: string): Promise<string> {
  const url = new URL(`assets/templates/${encodeURIComponent(template.fileName)}`, document.baseURI).toString();
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Unable to load template: ${template.fileName}`);
  }

  return applyTemplateVariables(await response.text(), filePath);
}

export function applyTemplateVariables(content: string, filePath: string, now = new Date()): string {
  const context = {
    filePath,
    title: getVaultDisplayName(filePath.split('/').pop() || filePath),
    now,
  };

  return content.replace(/{{\s*([a-z_]+)\s*}}/gi, (placeholder, key: string) => {
    const resolver = TEMPLATE_VARIABLES[key.toLowerCase()];
    return resolver ? resolver(context) : placeholder;
  });
}

function formatDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
