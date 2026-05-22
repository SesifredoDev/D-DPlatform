import { Injectable } from '@angular/core';
import { IServer } from '../../models/server/server.model';
import { ChannelType, IChannel } from '../../models/server/channel.model';
import { get, set, del } from 'idb-keyval';
import type { VaultEntry, VaultSearchResult } from '../../models/ObsidianVault/obsidian-vault-service.model';
export type { VaultEntry, VaultSearchResult } from '../../models/ObsidianVault/obsidian-vault-service.model';

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

@Injectable({
  providedIn: 'root',
})
export class ObsidianVaultService {
  private readonly STORAGE_KEY_PREFIX = 'obsidian_handle_';
  private readonly LOCALHOST_ROUTE_STORAGE_KEY_PREFIX = 'obsidian_localhost_route_';
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

  private vaultCache: Map<string, VaultEntry[]> = new Map();
  private readonly fileTextCache = new Map<string, string>();

  constructor() {}

  isFileSystemApiSupported(): boolean {
    return 'showDirectoryPicker' in window;
  }

  async attachVaultToServer(serverId: string): Promise<string> {
    if (!this.isFileSystemApiSupported()) {
      throw new Error('File System Access API is not supported in this browser.');
    }

    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: 'readwrite'
      });
      await set(`${this.STORAGE_KEY_PREFIX}${serverId}`, handle);
      localStorage.setItem(`${this.STORAGE_KEY_PREFIX}${serverId}_exists`, 'true');
      this.vaultCache.delete(serverId);
      return handle.name;
    } catch (err) {
      console.error('User cancelled or browser blocked folder access', err);
      throw err;
    }
  }

  async getVaultHandle(serverId: string): Promise<FileSystemDirectoryHandle | null> {
    const handle = await get(`${this.STORAGE_KEY_PREFIX}${serverId}`);
    return (handle as FileSystemDirectoryHandle) || null;
  }

  async requestPermission(handle: FileSystemHandle): Promise<boolean> {
    const options = { mode: 'readwrite' };
    return (await (handle as any).requestPermission(options)) === 'granted';
  }

  async hasPermission(serverId: string): Promise<boolean> {
    const handle = await this.getVaultHandle(serverId);
    if (!handle) return false;

    const options = { mode: 'readwrite' };
    if (typeof (handle as any).queryPermission !== 'function') {
      return true;
    }

    return (await (handle as any).queryPermission(options)) === 'granted';
  }

  async listVaultFiles(serverId: string, useCache = true): Promise<VaultEntry[]> {
    if (useCache && this.vaultCache.has(serverId) && this.vaultCache.get(serverId)!.length > 0) {
      return this.vaultCache.get(serverId)!;
    }

    const handle = await this.getVaultHandle(serverId);
    if (!handle) return [];

    const entries = await this.scanDirectory(handle);
    this.vaultCache.set(serverId, entries);
    return entries;
  }

  private async scanDirectory(directoryHandle: FileSystemDirectoryHandle, path = ''): Promise<VaultEntry[]> {
    const entries: VaultEntry[] = [];
    try {
        for await (const entry of (directoryHandle as any).values()) {
          const relativePath = path ? `${path}/${entry.name}` : entry.name;
          if (entry.name.startsWith('.')) continue;

          const vaultEntry: VaultEntry = {
            name: entry.name,
            kind: entry.kind,
            handle: entry,
            relativePath: relativePath,
            parentPath: path
          };

          if (entry.kind === 'directory') {
            vaultEntry.children = await this.scanDirectory(entry, relativePath);
          }
          entries.push(vaultEntry);
        }
    } catch (e) {
        console.error("Error scanning directory", path, e);
    }

    return entries.sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return a.kind === 'directory' ? -1 : 1;
    });
  }

  resolveRelativePath(basePath: string, targetPath: string): string {
    const baseParts = basePath.split(/[/\\]/).filter(p => p !== '');
    const targetParts = targetPath.split(/[/\\]/).filter(p => p !== '');
    const resolvedParts: string[] = [...baseParts];

    for (const part of targetParts) {
      if (part === '..') {
        resolvedParts.pop();
      } else if (part !== '.') {
        resolvedParts.push(part);
      }
    }
    return resolvedParts.join('/');
  }

  async findFileByFilename(serverId: string, filename: string): Promise<string | null> {
    // If cache is empty, try to list files once
    let vaultEntries = await this.listVaultFiles(serverId);

    const lowerFilename = filename.toLowerCase();
    const search = (entries: VaultEntry[]): string | null => {
      for (const entry of entries) {
        if (entry.kind === 'file' && entry.name.toLowerCase() === lowerFilename) {
          return entry.relativePath;
        }
        if (entry.kind === 'directory' && entry.children) {
          const found = search(entry.children);
          if (found) return found;
        }
      }
      return null;
    };

    return search(vaultEntries);
  }

  async readFile(serverId: string, relativePath: string): Promise<string> {
    const blob = await this.readFileAsBlob(serverId, relativePath);
    return await blob.text();
  }

  async readFileAsBlob(serverId: string, relativePath: string): Promise<Blob> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, relativePath);
    return await fileHandle.getFile();
  }

  async writeFile(serverId: string, relativePath: string, content: string): Promise<void> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, relativePath, true);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    this.vaultCache.delete(serverId);
    this.fileTextCache.delete(this.fileCacheKey(serverId, relativePath));
  }

  async createFolder(serverId: string, relativePath: string): Promise<void> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const parts = relativePath.split(/[/\\]/).filter(part => part.trim() !== '');
    if (parts.length === 0) throw new Error('Invalid folder path');

    let currentDir = rootHandle;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: true });
    }

    this.vaultCache.delete(serverId);
  }

  async renameFile(serverId: string, oldPath: string, newName: string): Promise<string> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, oldPath);
    if ((fileHandle as any).move) {
      await (fileHandle as any).move(newName);
    } else {
      const file = await fileHandle.getFile();
      const content = await file.text();
      const pathParts = oldPath.split(/[/\\]/).filter(p => p !== '');
      pathParts.pop();
      const newPath = pathParts.length > 0 ? `${pathParts.join('/')}/${newName}` : newName;
      await this.writeFile(serverId, newPath, content);
      await this.deleteEntry(serverId, oldPath);
      return newPath;
    }

    const pathParts = oldPath.split(/[/\\]/).filter(p => p !== '');
    pathParts.pop();
    this.vaultCache.delete(serverId);
    this.fileTextCache.delete(this.fileCacheKey(serverId, oldPath));
    return pathParts.length > 0 ? `${pathParts.join('/')}/${newName}` : newName;
  }

  async moveEntry(serverId: string, entryPath: string, targetDirectoryPath: string): Promise<string> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const entryName = entryPath.split(/[/\\]/).pop()!;
    const newRelativePath = targetDirectoryPath ? `${targetDirectoryPath}/${entryName}` : entryName;

    const parts = entryPath.split(/[/\\]/).filter(p => p !== '');
    const fileName = parts.pop()!;
    let sourceDir = rootHandle;
    for (const part of parts) {
      sourceDir = await sourceDir.getDirectoryHandle(part);
    }

    const targetParts = targetDirectoryPath ? targetDirectoryPath.split(/[/\\]/).filter(p => p !== '') : [];
    let targetDir = rootHandle;
    for (const part of targetParts) {
      targetDir = await targetDir.getDirectoryHandle(part);
    }

    const handle = await (sourceDir as any).getFileHandle(fileName);
    if (handle.move) {
      await handle.move(targetDir, fileName);
    } else {
      const file = await handle.getFile();
      const content = await file.text();
      await this.writeFile(serverId, newRelativePath, content);
      await sourceDir.removeEntry(fileName);
    }

    this.vaultCache.delete(serverId);
    this.fileTextCache.delete(this.fileCacheKey(serverId, entryPath));
    return newRelativePath;
  }

  async deleteEntry(serverId: string, relativePath: string): Promise<void> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const parts = relativePath.split(/[/\\]/).filter(p => p !== '');
    const name = parts.pop()!;
    let currentDir = rootHandle;

    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part);
    }

    await currentDir.removeEntry(name, { recursive: true });
    this.vaultCache.delete(serverId);
    this.fileTextCache.delete(this.fileCacheKey(serverId, relativePath));
  }

  async searchVault(serverId: string, query: string, limit = 30): Promise<VaultSearchResult[]> {
    const normalizedQuery = this.normalizeSearchText(query);
    const terms = normalizedQuery.split(' ').filter(Boolean);

    if (terms.length === 0 || !this.hasVaultAttached(serverId) || !(await this.hasPermission(serverId))) {
      return [];
    }

    const entries = await this.listVaultFiles(serverId);
    const files = this.flattenEntries(entries).filter(entry => entry.kind === 'file');
    const results: VaultSearchResult[] = [];

    for (const file of files) {
      const name = this.normalizeSearchText(file.name);
      const path = this.normalizeSearchText(file.relativePath);
      const titleMatch = terms.every(term => name.includes(term));
      const pathMatch = !titleMatch && terms.every(term => path.includes(term));

      let content = '';
      let contentMatch = false;
      if (this.isSearchableTextFile(file.name)) {
        content = await this.readCachedText(serverId, file.relativePath);
        const normalizedContent = this.normalizeSearchText(content);
        contentMatch = terms.every(term => normalizedContent.includes(term));
      }

      if (!titleMatch && !pathMatch && !contentMatch) {
        continue;
      }

      results.push({
        serverId,
        name: file.name,
        relativePath: file.relativePath,
        snippet: contentMatch ? this.buildSnippet(content, terms) : file.relativePath,
        matchType: titleMatch ? 'title' : pathMatch ? 'path' : 'content',
        score: this.scoreVaultMatch(file, normalizedQuery, terms, { titleMatch, pathMatch, contentMatch }),
      });
    }

    return results
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, limit);
  }

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

  getObsidianCanvasTemplate(): string {
    return JSON.stringify({ nodes: [], edges: [] }, null, 2);
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

  private async getFileHandleByPath(
    root: FileSystemDirectoryHandle,
    path: string,
    create = false
  ): Promise<FileSystemFileHandle> {
    const parts = path.split(/[/\\]/).filter(p => p !== '');
    const fileName = parts.pop();

    if (!fileName) throw new Error("Invalid path: no filename found");

    let currentDir = root;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create });
    }

    return await currentDir.getFileHandle(fileName, { create });
  }

  setVaultLocalhostRoute(serverId: string, route: string): void {
    localStorage.setItem(`${this.LOCALHOST_ROUTE_STORAGE_KEY_PREFIX}${serverId}`, route);
  }

  getVaultLocalhostRoute(serverId: string): string | null {
    return localStorage.getItem(`${this.LOCALHOST_ROUTE_STORAGE_KEY_PREFIX}${serverId}`);
  }

  isOwner(server: IServer, currentUserId: string): boolean {
    return server.owner === currentUserId;
  }

  getObsidianChannel(serverId: string): IChannel {
    return {
      _id: `obsidian-${serverId}`,
      name: 'obsidian-vault',
      type: ChannelType.Obsidian,
      icon: 'book',
      server: serverId
    };
  }

  hasVaultAttached(serverId: string): boolean {
    return !!localStorage.getItem(`${this.STORAGE_KEY_PREFIX}${serverId}_exists`) ||
           !!localStorage.getItem(`${this.LOCALHOST_ROUTE_STORAGE_KEY_PREFIX}${serverId}`);
  }

  private flattenEntries(entries: VaultEntry[]): VaultEntry[] {
    return entries.flatMap(entry => [
      entry,
      ...(entry.children ? this.flattenEntries(entry.children) : []),
    ]);
  }

  private async readCachedText(serverId: string, relativePath: string): Promise<string> {
    const cacheKey = this.fileCacheKey(serverId, relativePath);
    const cached = this.fileTextCache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const text = await this.readFile(serverId, relativePath);
      this.fileTextCache.set(cacheKey, text);
      return text;
    } catch (error) {
      console.warn('Failed to read vault file for search', relativePath, error);
      return '';
    }
  }

  private scoreVaultMatch(
    entry: VaultEntry,
    normalizedQuery: string,
    terms: string[],
    matches: { titleMatch: boolean; pathMatch: boolean; contentMatch: boolean }
  ): number {
    const name = this.normalizeSearchText(entry.name);
    const baseName = this.normalizeSearchText(entry.name.replace(/\.[^.]+$/, ''));
    const path = this.normalizeSearchText(entry.relativePath);

    let score = 0;
    if (baseName === normalizedQuery || name === normalizedQuery) score += 140;
    if (baseName.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) score += 90;
    if (matches.titleMatch) score += 65;
    if (matches.pathMatch) score += 35;
    if (matches.contentMatch) score += 20;
    score += terms.filter(term => path.includes(term)).length * 3;
    return score;
  }

  private buildSnippet(content: string, terms: string[]): string {
    const compact = content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[\[[^\]]+]]/g, ' ')
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?]]/g, '$1')
      .replace(/[#>*_`|[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!compact) {
      return '';
    }

    const lower = compact.toLowerCase();
    const matchIndex = terms
      .map(term => lower.indexOf(term))
      .filter(index => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;

    const start = Math.max(0, matchIndex - 80);
    const snippet = compact.slice(start, start + 220);
    return `${start > 0 ? '...' : ''}${snippet}${start + 220 < compact.length ? '...' : ''}`;
  }

  private isSearchableTextFile(name: string): boolean {
    return /\.(md|markdown|canvas|txt|json|yaml|yml|csv)$/i.test(name);
  }

  private normalizeSearchText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
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

  private fileCacheKey(serverId: string, relativePath: string): string {
    return `${serverId}::${relativePath}`;
  }
}
