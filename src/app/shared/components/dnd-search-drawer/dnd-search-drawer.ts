import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { marked } from 'marked';
import { BroadcastData, BroadcastDialog } from '../../../objects/broadcast-dialog/broadcast-dialog';
import {
  Open5eApiService,
  Open5eDetail,
  Open5eSearchResult,
} from '../../services/open5e-api/open5e-api.service';
import {
  ObsidianVaultService,
  VaultSearchResult,
} from '../../services/ObsidianVault/obsidian-vault-service';
import { ServerService } from '../../services/server/server';
import { TabService } from '../../services/tab/tab-service';

interface DetailFact {
  label: string;
  value: string;
}

interface DetailSection {
  title: string;
  entries: string[];
}

interface RichTextBlock {
  text: string;
  html: string;
  isMarkdown: boolean;
}

interface RichDetailSection {
  title: string;
  entries: RichTextBlock[];
  hasMarkdown: boolean;
}

interface SearchResultItem {
  id: string;
  source: 'open5e' | 'vault';
  title: string;
  category: string;
  subtitle: string;
  snippet: string;
  open5e?: Open5eSearchResult;
  vault?: VaultSearchResult;
}

@Component({
  selector: 'app-dnd-search-drawer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dnd-search-drawer.html',
  styleUrl: './dnd-search-drawer.scss',
})
export class DndSearchDrawer {
  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;

  private readonly open5eApi = inject(Open5eApiService);
  private readonly obsidianVaultService = inject(ObsidianVaultService);
  private readonly serverService = inject(ServerService);
  private readonly tabService = inject(TabService);
  private readonly dialog = inject(MatDialog);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly isOpen = signal(false);
  readonly query = signal('');
  readonly results = signal<SearchResultItem[]>([]);
  readonly selectedItem = signal<SearchResultItem | null>(null);
  readonly selectedDetail = signal<Open5eDetail | null>(null);
  readonly isSearching = signal(false);
  readonly isDetailLoading = signal(false);
  readonly isBroadcasting = signal(false);
  readonly error = signal<string | null>(null);

  readonly detailTitle = computed(() => {
    const item = this.selectedItem();
    const detail = this.selectedDetail();
    return this.stringValue(detail?.['name']) ?? item?.title ?? 'Search Detail';
  });

  readonly detailDescription = computed(() => {
    const item = this.selectedItem();
    const detail = this.selectedDetail();

    if (!item || !detail) {
      return '';
    }

    if (item.source === 'vault') {
      return item.snippet;
    }

    return this.open5eDescription(item.open5e, detail);
  });

  readonly detailDescriptionBlock = computed(() => this.toRichTextBlock(this.detailDescription()));

  readonly detailFacts = computed(() => {
    const item = this.selectedItem();
    const detail = this.selectedDetail();

    if (!item) {
      return [];
    }

    if (item.source === 'vault' && item.vault) {
      return [
        { label: 'Type', value: 'Vault Note' },
        { label: 'Source', value: item.subtitle },
        { label: 'Match', value: item.vault.matchType },
        { label: 'Path', value: item.vault.relativePath },
      ];
    }

    const result = item.open5e;
    if (!detail || !result) {
      return [];
    }

    return this.open5eFacts(result, detail);
  });

  readonly detailSections = computed(() => {
    const selectedItem = this.selectedItem();
    const detail = this.selectedDetail();

    if (!detail || selectedItem?.source !== 'open5e' || !selectedItem.open5e) {
      return [];
    }

    return this.open5eSections(selectedItem.open5e, detail, 8);
  });

  readonly richDetailSections = computed<RichDetailSection[]>(() => this.detailSections().map(section => {
    const entries = section.entries.map(entry => this.toRichTextBlock(entry));

    return {
      ...section,
      entries,
      hasMarkdown: entries.some(entry => entry.isMarkdown),
    };
  }));

  readonly selectedExternalUrl = computed(() => {
    const item = this.selectedItem();
    return item?.open5e ? this.open5eApi.getExternalUrl(item.open5e) : '';
  });

  private searchTimer?: ReturnType<typeof setTimeout>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private searchRequestId = 0;
  private detailRequestId = 0;
  private pointerInside = false;

  openFromTopEdge(): void {
    // this.open(true);
  }

  openAndFocus(): void {
    this.open(true);
  }

  close(): void {
    this.clearCloseTimer();
    this.isOpen.set(false);
    this.pointerInside = false;
  }

  onDrawerMouseEnter(): void {
    // this.pointerInside = true;
    // this.clearCloseTimer();
  }

  onDrawerMouseLeave(): void {
    this.pointerInside = false;

    if (!this.host.nativeElement.contains(document.activeElement)) {
      this.scheduleClose(500);
    }
  }

  onFocusIn(): void {
    this.clearCloseTimer();
  }

  onFocusOut(event: FocusEvent): void {
    const nextTarget = event.relatedTarget;

    if (
      nextTarget instanceof Node
      && this.host.nativeElement.contains(nextTarget)
    ) {
      return;
    }

    if (!this.pointerInside) {
      this.scheduleClose(250);
    }
  }

  onQueryChange(value: string): void {
    const query = value.trimStart();
    this.query.set(query);
    this.error.set(null);
    this.selectedItem.set(null);
    this.selectedDetail.set(null);

    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }

    if (query.trim().length < 2) {
      this.isSearching.set(false);
      this.results.set([]);
      this.selectedItem.set(null);
      this.selectedDetail.set(null);
      return;
    }

    this.isSearching.set(true);
    const requestId = ++this.searchRequestId;

    this.searchTimer = setTimeout(() => {
      void this.runSearch(query, requestId);
    }, 180);
  }

  async selectResult(item: SearchResultItem): Promise<void> {
    this.selectedItem.set(item);
    this.selectedDetail.set(null);
    this.error.set(null);
    const requestId = ++this.detailRequestId;

    if (item.source === 'vault') {
      this.isDetailLoading.set(false);
      this.openVaultResult(item);
      return;
    }

    if (!item.open5e) {
      return;
    }

    this.isDetailLoading.set(true);

    try {
      const detail = await this.open5eApi.getDetail(item.open5e);

      if (requestId !== this.detailRequestId) {
        return;
      }

      this.selectedDetail.set(detail);
    } catch (error) {
      if (requestId !== this.detailRequestId) {
        return;
      }

      console.warn('Failed to load Open5e detail', error);
      this.error.set('That Open5e entry could not be loaded.');
    } finally {
      if (requestId === this.detailRequestId) {
        this.isDetailLoading.set(false);
      }
    }
  }

  async broadcastSelectedRule(): Promise<void> {
    const item = this.selectedItem();

    if (!item?.open5e || item.source !== 'open5e') {
      return;
    }

    this.error.set(null);
    this.isBroadcasting.set(true);

    try {
      const detail = await this.ensureSelectedOpen5eDetail(item);
      const data: BroadcastData = {
        text: this.buildRuleBroadcastMarkdown(item, detail),
        source: 'open5e-search',
        filename: `${this.safeFilename(this.stringValue(detail['name']) ?? item.title)}.md`,
      };

      this.dialog.open(BroadcastDialog, {
        data,
        maxWidth: '600px',
        width: '100%',
      });
    } catch (error) {
      console.warn('Failed to prepare Open5e broadcast', error);
      this.error.set('That Open5e entry could not be prepared for broadcast.');
    } finally {
      this.isBroadcasting.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    const openShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';

    if (openShortcut) {
      event.preventDefault();
      this.openAndFocus();
      return;
    }

    if (event.key === 'Escape' && this.isOpen()) {
      event.preventDefault();
      this.close();
    }
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    if (!this.isOpen()) {
      return;
    }

    const target = event.target;

    if (target instanceof Node && this.host.nativeElement.contains(target)) {
      return;
    }

    this.close();
  }

  private open(shouldFocus: boolean): void {
    this.clearCloseTimer();
    this.isOpen.set(true);

    if (shouldFocus) {
      setTimeout(() => this.searchInput?.nativeElement.focus(), 0);
    }
  }

  private async ensureSelectedOpen5eDetail(item: SearchResultItem): Promise<Open5eDetail> {
    const currentDetail = this.selectedDetail();
    if (currentDetail) {
      return currentDetail;
    }

    if (!item.open5e) {
      throw new Error('No Open5e result selected.');
    }

    const requestId = ++this.detailRequestId;
    this.isDetailLoading.set(true);

    try {
      const detail = await this.open5eApi.getDetail(item.open5e);

      if (requestId === this.detailRequestId) {
        this.selectedDetail.set(detail);
      }

      return detail;
    } finally {
      if (requestId === this.detailRequestId) {
        this.isDetailLoading.set(false);
      }
    }
  }

  private buildRuleBroadcastMarkdown(item: SearchResultItem, detail: Open5eDetail): string {
    const title = this.stringValue(detail['name']) ?? item.title;
    const source = detail.document?.display_name ?? detail.document?.name ?? item.open5e?.document?.name ?? 'Open5e';
    const category = this.objectModelLabel(item.open5e?.object_model ?? item.category);
    const parts = [
      `# ${title}`,
      `_${[category, source].filter(Boolean).join(' - ')}_`,
    ];

    const facts = this.open5eFacts(item.open5e!, detail)
      .filter(fact => !['Type', 'Source'].includes(fact.label));

    if (facts.length > 0) {
      parts.push([
        '| Detail | Value |',
        '|---|---|',
        ...facts.map(fact => `| ${this.escapeMarkdownTableCell(fact.label)} | ${this.escapeMarkdownTableCell(fact.value)} |`),
      ].join('\n'));
    }

    const description = this.open5eDescription(item.open5e, detail);
    if (description) {
      parts.push(this.normalizeOpen5eMarkdown(description));
    }

    for (const section of this.open5eSections(item.open5e!, detail, 8)) {
      const entries = section.entries
        .map(entry => this.normalizeOpen5eMarkdown(entry))
        .filter(Boolean);

      if (entries.length > 0) {
        parts.push(`## ${section.title}\n\n${entries.join('\n\n')}`);
      }
    }

    return parts
      .filter(Boolean)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private escapeMarkdownTableCell(value: string): string {
    return value
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>');
  }

  private safeFilename(value: string): string {
    return value
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
      || 'open5e-rule';
  }

  private async runSearch(query: string, requestId: number): Promise<void> {
    const currentServer = this.serverService.getCurrentServer();
    const vaultSearch = currentServer
      ? this.obsidianVaultService.searchVault(currentServer._id, query, 25)
      : Promise.resolve<VaultSearchResult[]>([]);

    const [open5eResult, vaultResult] = await Promise.allSettled([
      this.open5eApi.search(query),
      vaultSearch,
    ]);

    if (requestId !== this.searchRequestId) {
      return;
    }

    const open5eResults = open5eResult.status === 'fulfilled' ? open5eResult.value : [];
    const vaultResults = vaultResult.status === 'fulfilled' ? vaultResult.value : [];

    if (open5eResult.status === 'rejected') {
      console.warn('Failed to search Open5e API', open5eResult.reason);
    }

    if (vaultResult.status === 'rejected') {
      console.warn('Failed to search Obsidian vault', vaultResult.reason);
    }

    this.results.set([
      ...vaultResults.map(result => this.mapVaultResult(result, currentServer?.name ?? 'Obsidian Vault')),
      ...open5eResults.map(result => this.mapOpen5eResult(result)),
    ]);

    if (open5eResult.status === 'rejected' && vaultResult.status === 'rejected') {
      this.error.set('Search could not be loaded.');
    }

    if (requestId === this.searchRequestId) {
      this.isSearching.set(false);
    }
  }

  private mapOpen5eResult(result: Open5eSearchResult): SearchResultItem {
    return {
      id: `open5e:${result.object_pk}`,
      source: 'open5e',
      title: result.object_name,
      category: result.object_model,
      subtitle: result.document?.name ?? 'Open5e',
      snippet: this.compactText(result.highlighted || result.text),
      open5e: result,
    };
  }

  private mapVaultResult(result: VaultSearchResult, vaultName: string): SearchResultItem {
    return {
      id: `vault:${result.serverId}:${result.relativePath}`,
      source: 'vault',
      title: result.name.replace(/\.md$/i, ''),
      category: 'Vault',
      subtitle: vaultName,
      snippet: result.snippet,
      vault: result,
    };
  }

  private openVaultResult(item: SearchResultItem): void {
    const result = item.vault;
    if (!result) return;

    this.tabService.openTab(`obsidian-${result.serverId}`, 'obsidian-vault', 'obsidian', 'left', {
      serverId: result.serverId,
      openPath: result.relativePath,
      openRequestId: Date.now(),
    });
    this.close();
  }

  private scheduleClose(delayMs: number): void {
    this.clearCloseTimer();
    this.closeTimer = setTimeout(() => this.close(), delayMs);
  }

  private clearCloseTimer(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
  }

  private open5eDescription(result: Open5eSearchResult | undefined, detail: Open5eDetail): string {
    return this.textList(detail['desc'])
      || this.textList(detail['higher_level'])
      || this.textList(result?.text)
      || this.stringValue(detail['language_desc'])
      || this.stringValue(detail['equipment_category'] ?? detail['feature_specific'])
      || '';
  }

  private open5eFacts(result: Open5eSearchResult, detail: Open5eDetail): DetailFact[] {
    const summary = result.object ?? {};
    const facts: Array<{ label: string; value: string | undefined }> = [
      { label: 'Type', value: this.objectModelLabel(result.object_model) },
      { label: 'Source', value: detail.document?.display_name ?? detail.document?.name ?? result.document?.name },
      { label: 'Match', value: this.matchLabel(result) },
      { label: 'Level', value: this.spellLevel(detail['level']) },
      { label: 'School', value: this.referenceName(detail['school']) || this.stringValue(summary['school']) },
      { label: 'Casting', value: this.stringValue(detail['casting_time']) },
      { label: 'Range', value: this.stringValue(detail['range_text']) || this.stringValue(detail['range']) },
      { label: 'Duration', value: this.duration(detail) },
      { label: 'Components', value: this.components(detail) },
      { label: 'Size', value: this.referenceName(detail['size']) || this.stringValue(summary['size']) },
      { label: 'Creature Type', value: this.referenceName(detail['type']) || this.stringValue(summary['type']) },
      { label: 'Alignment', value: this.stringValue(detail['alignment']) },
      { label: 'AC', value: this.armorClass(detail['armor_class']) },
      { label: 'HP', value: this.numberValue(detail['hit_points']) },
      { label: 'Speed', value: this.speed(detail['speed']) },
      { label: 'CR', value: this.numberValue(detail['challenge_rating']) || this.numberValue(summary['cr']) },
      { label: 'XP', value: this.numberValue(detail['experience_points']) },
      { label: 'Hit Dice', value: this.stringValue(detail['hit_dice']) },
      { label: 'Cost', value: this.cost(detail['cost']) },
      { label: 'Weight', value: this.numberValue(detail['weight']) },
      { label: 'Damage', value: this.damage(detail['damage']) || this.stringValue(detail['damage_roll']) },
      { label: 'Category', value: this.referenceName(detail['equipment_category']) },
    ];

    return facts.filter((fact): fact is DetailFact => !!fact.value);
  }

  private open5eSections(result: Open5eSearchResult, detail: Open5eDetail, maxEntries?: number): DetailSection[] {
    const sections: DetailSection[] = [
      { title: 'Higher Levels', entries: this.arrayTextEntries(detail['higher_level']) },
      { title: 'Actions', entries: this.namedDescEntries(detail['actions']) },
      { title: 'Traits', entries: this.namedDescEntries(detail['traits']) },
      { title: 'Special Abilities', entries: this.namedDescEntries(detail['special_abilities']) },
      { title: 'Legendary Actions', entries: this.namedDescEntries(detail['legendary_actions']) },
      { title: 'Classes', entries: this.referenceEntries(detail['classes']) },
      { title: 'Subclass Of', entries: this.referenceEntries([detail['subclass_of']]) },
      { title: 'Proficiencies', entries: this.referenceEntries(detail['proficiencies']) },
      { title: 'Snippet', entries: this.arrayTextEntries(result.text) },
    ];

    return sections
      .map(section => ({
        ...section,
        entries: maxEntries ? section.entries.slice(0, maxEntries) : section.entries,
      }))
      .filter(section => section.entries.length > 0);
  }

  private spellLevel(value: unknown): string {
    if (typeof value !== 'number') {
      return '';
    }

    return value === 0 ? 'Cantrip' : `${value}`;
  }

  private duration(detail: Open5eDetail): string {
    const duration = this.stringValue(detail['duration']);
    const flags = [
      detail['concentration'] === true ? 'Concentration' : '',
      detail['ritual'] === true ? 'Ritual' : '',
    ].filter(Boolean);

    return [duration, ...flags].filter(Boolean).join(' / ');
  }

  private armorClass(value: unknown): string {
    if (typeof value === 'number') {
      return `${value}`;
    }

    if (!Array.isArray(value)) {
      return '';
    }

    return value
      .map(entry => {
        if (!this.isRecord(entry)) return '';
        const ac = this.numberValue(entry['value']);
        const type = this.referenceName(entry['type']) || this.stringValue(entry['type']);
        return [ac, type].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join(', ');
  }

  private speed(value: unknown): string {
    if (!this.isRecord(value)) {
      return '';
    }

    return Object.entries(value)
      .map(([key, entryValue]) => `${this.titleCase(key)} ${String(entryValue)}`)
      .join(', ');
  }

  private components(detail: Open5eDetail): string {
    const flags = [
      detail['verbal'] === true ? 'V' : '',
      detail['somatic'] === true ? 'S' : '',
      detail['material'] === true ? 'M' : '',
    ].filter(Boolean);

    const material = this.stringValue(detail['material_specified']);
    const parts = [flags.join(', '), material ? `(${material})` : ''].filter(Boolean);

    return parts.join(' ');
  }

  private matchLabel(result: Open5eSearchResult): string {
    const pieces = [
      this.stringValue(result.match_type),
      this.stringValue(result.matched_term),
    ].filter(Boolean);

    return pieces.join(': ');
  }

  private objectModelLabel(value: string): string {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, character => character.toUpperCase());
  }

  private cost(value: unknown): string {
    if (!this.isRecord(value)) {
      return '';
    }

    const quantity = this.numberValue(value['quantity']);
    const unit = this.stringValue(value['unit']);
    return [quantity, unit].filter(Boolean).join(' ');
  }

  private damage(value: unknown): string {
    if (!this.isRecord(value)) {
      return '';
    }

    const dice = this.stringValue(value['damage_dice']);
    const type = this.referenceName(value['damage_type']);
    return [dice, type].filter(Boolean).join(' ');
  }

  private namedDescEntries(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map(entry => {
        if (!this.isRecord(entry)) return '';

        const name = this.stringValue(entry['name']);
        const desc = this.textList(entry['desc']);

        return [name, desc].filter(Boolean).join(': ');
      })
      .filter(Boolean);
  }

  private referenceEntries(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map(entry => this.referenceName(entry))
      .filter(Boolean);
  }

  private arrayTextEntries(value: unknown): string[] {
    if (typeof value === 'string') {
      return value.trim() ? [value] : [];
    }

    if (!Array.isArray(value)) {
      return [];
    }

    return value.map(entry => String(entry)).filter(Boolean);
  }

  private textList(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    if (!Array.isArray(value)) {
      return '';
    }

    return value.map(entry => String(entry)).filter(Boolean).join('\n\n');
  }

  private referenceName(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    if (!this.isRecord(value)) {
      return '';
    }

    return this.stringValue(value['name']) ?? this.stringValue(value['index']) ?? '';
  }

  private stringArray(value: unknown): string {
    if (!Array.isArray(value)) {
      return '';
    }

    return value.map(entry => String(entry)).filter(Boolean).join(', ');
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private numberValue(value: unknown): string {
    return typeof value === 'number' ? `${value}` : '';
  }

  private compactText(value: string): string {
    return value
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  private titleCase(value: string): string {
    return value
      .replace(/_/g, ' ')
      .replace(/\b\w/g, character => character.toUpperCase());
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private toRichTextBlock(value: string): RichTextBlock {
    const markdown = this.normalizeOpen5eMarkdown(value);
    const isMarkdown = this.looksLikeMarkdown(markdown);

    return {
      text: value,
      html: isMarkdown ? this.parseMarkdown(markdown) : '',
      isMarkdown,
    };
  }

  private parseMarkdown(value: string): string {
    const parsed = marked.parse(value, {
      async: false,
      breaks: false,
      gfm: true,
    });

    return typeof parsed === 'string' ? parsed : '';
  }

  private normalizeOpen5eMarkdown(value: string): string {
    const lines = value.replace(/\r\n/g, '\n').split('\n');

    return lines
      .map((line, index) => {
        const trimmed = line.trim();

        if (trimmed === '[Column data]') {
          return '';
        }

        if (/^Table:\s+\S/.test(trimmed)) {
          return `#### ${trimmed}`;
        }

        if (this.isOpen5eHeadingLine(lines, index)) {
          return `### ${trimmed}`;
        }

        return line;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private isOpen5eHeadingLine(lines: string[], index: number): boolean {
    const trimmed = lines[index].trim();
    const next = lines[index + 1]?.trim() ?? '';

    if (!trimmed || next !== '') {
      return false;
    }

    if (trimmed.length > 80 || /[.!?,:;]$/.test(trimmed)) {
      return false;
    }

    if (/^(#{1,6}|[-*+]\s|\d+\.|\||>|`|\[|<)/.test(trimmed)) {
      return false;
    }

    if (/[*_{}()[\]]/.test(trimmed)) {
      return false;
    }

    return /[A-Za-z]/.test(trimmed);
  }

  private looksLikeMarkdown(value: string): boolean {
    const trimmed = value.trim();

    if (!trimmed) {
      return false;
    }

    return [
      /^#{1,6}\s+\S/m,
      /^\s{0,3}[-*+]\s+\S/m,
      /^\s{0,3}\d+\.\s+\S/m,
      /^\s{0,3}>\s+\S/m,
      /```[\s\S]*```/,
      /`[^`\n]+`/,
      /(\*\*|__)\S[\s\S]*?\S\1/,
      /(\*|_)\S[^*_]*?\S\1/,
      /\[[^\]]+]\([^)]+\)/,
      /^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*\|/m,
    ].some(pattern => pattern.test(trimmed));
  }
}
