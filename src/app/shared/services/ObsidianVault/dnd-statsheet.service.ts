import { Injectable } from '@angular/core';

export type DndAbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export interface DndStatsheetEntry {
  name: string;
  text: string;
}

export interface DndStatsheetSection {
  title: string;
  entries: DndStatsheetEntry[];
}

export interface DndStatsheet {
  name: string;
  meta: string;
  armorClass: string;
  hitPoints: string;
  speed: string;
  abilities: Record<DndAbilityKey, string>;
  attributes: DndStatsheetEntry[];
  sections: DndStatsheetSection[];
}

/**
 * Parses, serializes and renders D&D 5e statsheets embedded in notes as fenced code blocks.
 * Kept separate from ObsidianVaultService so the vault layer stays a generic file store.
 */
@Injectable({
  providedIn: 'root',
})
export class DndStatsheetService {
  private readonly DND_STATSHEET_LANGUAGES = new Set([
    '5e',
    '5e-statblock',
    '5e-statsheet',
    'dnd',
    'dnd-statblock',
    'dnd-statsheet',
    'statblock',
    'statsheet',
  ]);
  private readonly DND_ABILITY_KEYS: DndAbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

  isDndStatsheetLanguage(language: string): boolean {
    return this.DND_STATSHEET_LANGUAGES.has(language.trim().toLowerCase());
  }

  createDndStatsheet(name = 'New Creature'): DndStatsheet {
    return {
      name: name.trim() || 'New Creature',
      meta: 'Medium humanoid, unaligned',
      armorClass: '10',
      hitPoints: '7 (2d8 - 2)',
      speed: '30 ft.',
      abilities: {
        str: '10',
        dex: '10',
        con: '10',
        int: '10',
        wis: '10',
        cha: '10',
      },
      attributes: [
        { name: 'Senses', text: 'passive Perception 10' },
        { name: 'Languages', text: 'Common' },
        { name: 'Challenge', text: '1/8 (25 XP)' },
      ],
      sections: [
        {
          title: 'Traits',
          entries: [{ name: 'Trait Name', text: 'Describe the creature trait here.' }],
        },
        {
          title: 'Actions',
          entries: [
            {
              name: 'Attack Name',
              text: 'Melee or Ranged Weapon Attack: +2 to hit, reach 5 ft., one target. Hit: 4 (1d6 + 1) damage.',
            },
          ],
        },
      ],
    };
  }

  getDndStatsheetTemplate(name = 'New Creature'): string {
    return this.serializeDndStatsheetMarkdown(this.createDndStatsheet(name));
  }

  renderDndStatsheetHtml(content: string): string | null {
    const statsheet = this.parseDndStatsheetSource(content);
    if (!statsheet) return null;

    const basics = [
      ['Armor Class', statsheet.armorClass],
      ['Hit Points', statsheet.hitPoints],
      ['Speed', statsheet.speed],
    ].filter(([, value]) => !!value);

    const basicsHtml = basics.length
      ? `<dl class="dnd-statsheet__basics">${basics.map(([label, value]) => `
          <div>
            <dt>${this.escapeHtml(label)}</dt>
            <dd>${this.renderDndInline(value)}</dd>
          </div>`).join('')}
        </dl>`
      : '';

    const hasAbilities = this.DND_ABILITY_KEYS.some(ability => !!statsheet.abilities[ability]);
    const abilitiesHtml = hasAbilities
      ? `<div class="dnd-statsheet__abilities">
          ${this.DND_ABILITY_KEYS.map(ability => this.renderDndAbility(ability, statsheet.abilities[ability])).join('')}
        </div>`
      : '';

    const attributesHtml = statsheet.attributes.length
      ? `<dl class="dnd-statsheet__attributes">
          ${statsheet.attributes.map(attribute => `
            <div>
              <dt>${this.escapeHtml(attribute.name)}</dt>
              <dd>${this.renderDndInline(attribute.text)}</dd>
            </div>`).join('')}
        </dl>`
      : '';

    const sectionsHtml = statsheet.sections
      .filter(section => section.entries.length > 0)
      .map(section => `
        <section class="dnd-statsheet__section">
          <h4>${this.escapeHtml(section.title)}</h4>
          ${section.entries.map(entry => `
            <p>
              ${entry.name ? `<strong>${this.escapeHtml(entry.name)}.</strong> ` : ''}
              ${this.renderDndInline(entry.text)}
            </p>`).join('')}
        </section>`)
      .join('');

    return `
      <article class="dnd-statsheet" aria-label="Dungeons and Dragons 5e statsheet">
        <header class="dnd-statsheet__header">
          <h3>${this.escapeHtml(statsheet.name)}</h3>
          ${statsheet.meta ? `<p>${this.renderDndInline(statsheet.meta)}</p>` : ''}
        </header>
        ${basicsHtml ? '<div class="dnd-statsheet__rule"></div>' : ''}
        ${basicsHtml}
        ${abilitiesHtml ? '<div class="dnd-statsheet__rule"></div>' : ''}
        ${abilitiesHtml}
        ${attributesHtml ? '<div class="dnd-statsheet__rule"></div>' : ''}
        ${attributesHtml}
        ${sectionsHtml}
      </article>`;
  }

  parseDndStatsheetSource(content: string): DndStatsheet | null {
    const cleanContent = content
      .replace(/^\s*```[\w-]*\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    if (!cleanContent) return null;

    const statsheet: DndStatsheet = {
      name: '',
      meta: '',
      armorClass: '',
      hitPoints: '',
      speed: '',
      abilities: {
        str: '',
        dex: '',
        con: '',
        int: '',
        wis: '',
        cha: '',
      },
      attributes: [],
      sections: [],
    };

    const metaParts: { size: string; type: string; alignment: string } = {
      size: '',
      type: '',
      alignment: '',
    };

    let currentSection: DndStatsheetSection | null = null;
    let lastEntry: DndStatsheetEntry | null = null;
    let expectsAbilityScoreRow = false;

    cleanContent.split(/\r?\n/).forEach(rawLine => {
      const line = rawLine.trim();
      if (!line || /^-{3,}$/.test(line)) {
        lastEntry = null;
        expectsAbilityScoreRow = false;
        return;
      }

      if (/^str\s+dex\s+con\s+int\s+wis\s+cha$/i.test(line.replace(/\s+/g, ' '))) {
        expectsAbilityScoreRow = true;
        lastEntry = null;
        return;
      }

      if (expectsAbilityScoreRow && this.parseDndAbilityScoreRow(statsheet, line)) {
        expectsAbilityScoreRow = false;
        lastEntry = null;
        return;
      }

      expectsAbilityScoreRow = false;

      const heading = this.normalizeDndStatsheetKey(line.replace(/^#+\s*/, '').replace(/:$/, ''));
      const sectionTitle = this.getDndStatsheetSectionTitle(heading);
      if (sectionTitle) {
        currentSection = this.ensureDndStatsheetSection(statsheet, sectionTitle);
        lastEntry = null;
        return;
      }

      const keyValue = line.match(/^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/);
      if (keyValue) {
        const key = this.normalizeDndStatsheetKey(keyValue[1]);
        const value = keyValue[2].trim();

        if (this.assignDndStatsheetValue(statsheet, metaParts, key, value)) {
          lastEntry = null;
          return;
        }

        const keySectionTitle = this.getDndStatsheetSectionTitle(key);
        if (keySectionTitle) {
          currentSection = this.ensureDndStatsheetSection(statsheet, keySectionTitle);
          if (value) {
            lastEntry = this.parseDndStatsheetEntry(value);
            currentSection.entries.push(lastEntry);
          } else {
            lastEntry = null;
          }
          return;
        }

        if (!value && line.endsWith(':')) {
          currentSection = this.ensureDndStatsheetSection(
            statsheet,
            this.toDndStatsheetDisplayTitle(keyValue[1])
          );
          lastEntry = null;
          return;
        }

        if (currentSection) {
          lastEntry = { name: keyValue[1].trim(), text: value };
          currentSection.entries.push(lastEntry);
          return;
        }

        if (value) {
          this.addDndStatsheetAttribute(statsheet, this.toDndStatsheetDisplayTitle(keyValue[1]), value);
          lastEntry = null;
          return;
        }
      }

      if (this.parseDndAbilityLine(statsheet, line)) {
        lastEntry = null;
        return;
      }

      if (this.parseDndBareStatLine(statsheet, metaParts, line)) {
        lastEntry = null;
        return;
      }

      if (currentSection) {
        if (/^\s{2,}/.test(rawLine) && lastEntry) {
          lastEntry.text = `${lastEntry.text} ${line}`.trim();
        } else {
          lastEntry = this.parseDndStatsheetEntry(line);
          currentSection.entries.push(lastEntry);
        }
        return;
      }

      if (!statsheet.name) {
        statsheet.name = line.replace(/^#+\s*/, '');
      } else if (!statsheet.meta) {
        statsheet.meta = line.replace(/^\*+|\*+$/g, '');
      }
    });

    const kind = [metaParts.size, metaParts.type].filter(Boolean).join(' ');
    statsheet.meta = statsheet.meta || [kind, metaParts.alignment].filter(Boolean).join(', ');
    statsheet.name = statsheet.name || 'Unnamed Creature';

    return statsheet;
  }

  serializeDndStatsheet(statsheet: DndStatsheet): string {
    const lines = [
      `name: ${statsheet.name || 'Unnamed Creature'}`,
      statsheet.meta ? `meta: ${statsheet.meta}` : '',
      statsheet.armorClass ? `armor_class: ${statsheet.armorClass}` : '',
      statsheet.hitPoints ? `hit_points: ${statsheet.hitPoints}` : '',
      statsheet.speed ? `speed: ${statsheet.speed}` : '',
      ...this.DND_ABILITY_KEYS.map(ability => statsheet.abilities[ability] ? `${ability}: ${statsheet.abilities[ability]}` : ''),
      ...statsheet.attributes
        .filter(attribute => attribute.name.trim() && attribute.text.trim())
        .map(attribute => `${this.getDndStatsheetAttributeKey(attribute.name)}: ${attribute.text}`),
    ].filter(Boolean);

    statsheet.sections
      .filter(section => section.title.trim() && section.entries.some(entry => entry.name.trim() || entry.text.trim()))
      .forEach(section => {
        lines.push('', `${this.getDndStatsheetSectionKey(section.title)}:`);
        section.entries
          .filter(entry => entry.name.trim() || entry.text.trim())
          .forEach(entry => {
            const prefix = entry.name.trim() ? `${entry.name.trim()}. ` : '';
            lines.push(`  - ${prefix}${entry.text.trim()}`);
          });
      });

    return lines.join('\n');
  }

  serializeDndStatsheetMarkdown(statsheet: DndStatsheet): string {
    const abilityHeader = this.DND_ABILITY_KEYS.map(ability => ability.toUpperCase()).join(' | ');
    const abilityAlign = this.DND_ABILITY_KEYS.map(() => ':---:').join(' | ');
    const abilityValues = this.DND_ABILITY_KEYS
      .map(ability => this.getDndAbilityMarkdown(statsheet.abilities[ability]))
      .join(' | ');

    const attributes = statsheet.attributes
      .filter(attribute => attribute.name.trim() || attribute.text.trim())
      .map(attribute => `**${attribute.name.trim() || 'Field'}** ${attribute.text.trim()}`)
      .join('  \n');

    const sections = statsheet.sections
      .filter(section => section.title.trim() && section.entries.some(entry => entry.name.trim() || entry.text.trim()))
      .map(section => {
        const entries = section.entries
          .filter(entry => entry.name.trim() || entry.text.trim())
          .map(entry => {
            const name = entry.name.trim();
            const text = entry.text.trim();
            return name ? `***${name}.*** ${text}` : text;
          })
          .join('\n\n');

        return `## ${section.title.trim()}\n\n${entries}`;
      })
      .join('\n\n');

    return [
      `# ${statsheet.name || 'Unnamed Creature'}`,
      statsheet.meta ? `*${statsheet.meta}*` : '',
      '',
      '---',
      '',
      statsheet.armorClass ? `**Armor Class** ${statsheet.armorClass}` : '',
      statsheet.hitPoints ? `**Hit Points** ${statsheet.hitPoints}` : '',
      statsheet.speed ? `**Speed** ${statsheet.speed}` : '',
      '',
      '---',
      '',
      `| ${abilityHeader} |`,
      `| ${abilityAlign} |`,
      `| ${abilityValues} |`,
      '',
      '---',
      '',
      attributes,
      attributes ? '\n---' : '',
      '',
      sections,
    ]
      .filter((line, index, lines) => line || lines[index - 1] !== '')
      .join('\n')
      .trim();
  }

  private assignDndStatsheetValue(
    statsheet: DndStatsheet,
    metaParts: { size: string; type: string; alignment: string },
    key: string,
    value: string
  ): boolean {
    if (key === 'name') statsheet.name = value;
    else if (key === 'meta' || key === 'description') statsheet.meta = value;
    else if (key === 'size') metaParts.size = value;
    else if (key === 'type') metaParts.type = value;
    else if (key === 'alignment') metaParts.alignment = value;
    else if (key === 'armor_class' || key === 'ac') statsheet.armorClass = value;
    else if (key === 'hit_points' || key === 'hp') statsheet.hitPoints = value;
    else if (key === 'speed') statsheet.speed = value;
    else if (this.DND_ABILITY_KEYS.includes(key as DndAbilityKey)) statsheet.abilities[key as DndAbilityKey] = value;
    else if (key === 'saving_throws') this.addDndStatsheetAttribute(statsheet, 'Saving Throws', value);
    else if (key === 'skills') this.addDndStatsheetAttribute(statsheet, 'Skills', value);
    else if (key === 'damage_vulnerabilities') this.addDndStatsheetAttribute(statsheet, 'Damage Vulnerabilities', value);
    else if (key === 'damage_resistances') this.addDndStatsheetAttribute(statsheet, 'Damage Resistances', value);
    else if (key === 'damage_immunities') this.addDndStatsheetAttribute(statsheet, 'Damage Immunities', value);
    else if (key === 'condition_immunities') this.addDndStatsheetAttribute(statsheet, 'Condition Immunities', value);
    else if (key === 'senses') this.addDndStatsheetAttribute(statsheet, 'Senses', value);
    else if (key === 'languages') this.addDndStatsheetAttribute(statsheet, 'Languages', value);
    else if (key === 'challenge' || key === 'cr') this.addDndStatsheetAttribute(statsheet, 'Challenge', value);
    else if (key === 'proficiency_bonus' || key === 'pb') this.addDndStatsheetAttribute(statsheet, 'Proficiency Bonus', value);
    else return false;

    return true;
  }

  private addDndStatsheetAttribute(statsheet: DndStatsheet, name: string, text: string): void {
    if (!text) return;
    statsheet.attributes.push({ name, text });
  }

  private parseDndAbilityLine(statsheet: DndStatsheet, line: string): boolean {
    const matches = Array.from(line.matchAll(/\b(str|dex|con|int|wis|cha)\b\s*:?\s*(\d{1,2})/gi));
    if (matches.length < 2) return false;

    matches.forEach(match => {
      statsheet.abilities[match[1].toLowerCase() as DndAbilityKey] = match[2];
    });
    return true;
  }

  private parseDndAbilityScoreRow(statsheet: DndStatsheet, line: string): boolean {
    const matches = Array.from(line.matchAll(/\b(\d{1,2})\s*(?:\([+-]?\d+\))?/g));
    if (matches.length < this.DND_ABILITY_KEYS.length) return false;

    this.DND_ABILITY_KEYS.forEach((ability, index) => {
      statsheet.abilities[ability] = matches[index][1];
    });
    return true;
  }

  private parseDndBareStatLine(
    statsheet: DndStatsheet,
    metaParts: { size: string; type: string; alignment: string },
    line: string
  ): boolean {
    const match = line.match(/^(Armor Class|AC|Hit Points|HP|Speed|Saving Throws|Skills|Damage Vulnerabilities|Damage Resistances|Damage Immunities|Condition Immunities|Senses|Languages|Challenge|CR|Proficiency Bonus|PB)\s+(.+)$/i);
    if (!match) return false;

    return this.assignDndStatsheetValue(
      statsheet,
      metaParts,
      this.normalizeDndStatsheetKey(match[1]),
      match[2].trim()
    );
  }

  private getDndAbilityMarkdown(value: string): string {
    const score = Number.parseInt(value, 10);
    if (!Number.isFinite(score)) return value || '-';

    const modifier = Math.floor((score - 10) / 2);
    return `${score} (${modifier >= 0 ? '+' : ''}${modifier})`;
  }

  private parseDndStatsheetEntry(line: string): DndStatsheetEntry {
    const cleanLine = line.replace(/^[-*]\s+/, '').trim();
    const namedEntry = cleanLine.match(/^([^.:]+)[.:]\s+(.+)$/);

    if (!namedEntry) {
      return { name: '', text: cleanLine };
    }

    return {
      name: namedEntry[1].replace(/\*\*/g, '').trim(),
      text: namedEntry[2].trim(),
    };
  }

  private ensureDndStatsheetSection(statsheet: DndStatsheet, title: string): DndStatsheetSection {
    let section = statsheet.sections.find(existing => existing.title === title);
    if (!section) {
      section = { title, entries: [] };
      statsheet.sections.push(section);
    }
    return section;
  }

  private getDndStatsheetSectionTitle(key: string): string | null {
    const sections: Record<string, string> = {
      traits: 'Traits',
      features: 'Traits',
      actions: 'Actions',
      bonus_actions: 'Bonus Actions',
      reactions: 'Reactions',
      legendary_actions: 'Legendary Actions',
      lair_actions: 'Lair Actions',
    };

    return sections[key] || null;
  }

  private getDndStatsheetSectionKey(title: string): string {
    const keys: Record<string, string> = {
      traits: 'traits',
      features: 'traits',
      actions: 'actions',
      bonus_actions: 'bonus_actions',
      reactions: 'reactions',
      legendary_actions: 'legendary_actions',
      lair_actions: 'lair_actions',
    };

    const normalized = this.normalizeDndStatsheetKey(title);
    return keys[normalized] || this.getDndStatsheetLabel(title, 'section');
  }

  private getDndStatsheetAttributeKey(name: string): string {
    const keys: Record<string, string> = {
      saving_throws: 'saving_throws',
      skills: 'skills',
      damage_vulnerabilities: 'damage_vulnerabilities',
      damage_resistances: 'damage_resistances',
      damage_immunities: 'damage_immunities',
      condition_immunities: 'condition_immunities',
      senses: 'senses',
      languages: 'languages',
      challenge: 'challenge',
      proficiency_bonus: 'proficiency_bonus',
    };

    const normalized = this.normalizeDndStatsheetKey(name);
    return keys[normalized] || this.getDndStatsheetLabel(name, 'attribute');
  }

  private toDndStatsheetDisplayTitle(value: string): string {
    const label = this.getDndStatsheetLabel(value, 'Section').replace(/[_-]+/g, ' ');
    if (/[A-Z]/.test(label)) return label;

    return label.replace(/\b[a-z]/g, char => char.toUpperCase());
  }

  private getDndStatsheetLabel(value: string, fallback: string): string {
    return value
      .trim()
      .replace(/[:\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      || fallback;
  }

  private renderDndAbility(ability: DndAbilityKey, value: string): string {
    const score = Number.parseInt(value, 10);
    const modifier = Number.isFinite(score) ? Math.floor((score - 10) / 2) : null;
    const modifierText = modifier === null ? '' : modifier >= 0 ? `+${modifier}` : `${modifier}`;

    return `
      <div>
        <span>${ability.toUpperCase()}</span>
        <strong>${value ? this.escapeHtml(value) : '-'}</strong>
        ${modifierText ? `<small>${modifierText}</small>` : ''}
      </div>`;
  }

  private renderDndInline(value: string): string {
    return this.escapeHtml(value)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  private normalizeDndStatsheetKey(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
  }

  private escapeHtml(value: string): string {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return value.replace(/[&<>"']/g, char => entities[char]);
  }
}
