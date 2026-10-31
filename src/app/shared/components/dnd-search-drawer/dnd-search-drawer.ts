import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  ViewChild,
  computed,
  inject,
  input,
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
import { HomebrewPackService } from '../../services/homebrew-pack/homebrew-pack.service';
import { ServerService } from '../../services/server/server';
import { TabService } from '../../services/tab/tab-service';
import type { DetailFact, DetailSection, RichTextBlock, RichDetailSection, SearchResultItem } from '../../models/components/dnd-search-drawer/dnd-search-drawer.model';
import { IHomebrewPackItem } from '../../models/homebrew-pack/homebrew-pack.model';

@Component({
  selector: 'app-dnd-search-drawer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dnd-search-drawer.html',
  styleUrl: './dnd-search-drawer.scss',
})
export class DndSearchDrawer {
  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;
  readonly showHandle = input(true);
  readonly titlebarMode = input(false);

  private readonly open5eApi = inject(Open5eApiService);
  private readonly obsidianVaultService = inject(ObsidianVaultService);
  private readonly homebrewPackService = inject(HomebrewPackService);
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
    if (!item) return '';

    if (item.source === 'homebrew') {
      return item.homebrew?.description || '';
    }

    if (item.source === 'vault') {
      return item.snippet;
    }

    const detail = this.selectedDetail();
    if (!detail) return '';

    return this.open5eDescription(item.open5e, detail);
  });

  readonly detailDescriptionBlock = computed(() => this.toRichTextBlock(this.detailDescription()));

  readonly detailFacts = computed(() => {
    const item = this.selectedItem();
    if (!item) return [];

    if (item.source === 'homebrew' && item.homebrew) {
      return Object.entries(item.homebrew.properties).map(([key, value]) => ({
        label: key.replace(/[-_]/g, ' '),
        value: String(value),
      }));
    }

    if (item.source === 'vault' && item.vault) {
      return [
        { label: 'Type', value: 'Vault Note' },
        { label: 'Source', value: item.subtitle },
        { label: 'Match', value: item.vault.matchType },
        { label: 'Path', value: item.vault.relativePath },
      ];
    }

    const detail = this.selectedDetail();
    const result = item.open5e;
    if (!detail || !result) {
      return [];
    }

    return this.open5eFacts(result, detail);
  });

  readonly availableFilters = [
    'ability-scores', 'alignments', 'backgrounds', 'classes', 'conditions',
    'damage-types', 'equipment', 'equipment-categories', 'feats', 'features',
    'languages', 'magic-items', 'magic-schools', 'monsters', 'proficiencies',
    'races', 'rule-sections', 'rules', 'skills', 'spells', 'subclasses',
    'subraces', 'traits', 'weapon-properties', 'Notes', 'Homebrew'
  ];

  readonly activeFilters = signal<Set<string>>(new Set());

  readonly filteredResults = computed(() => {
    const filters = this.activeFilters();
    const items = this.results();

    if (filters.size === 0) {
      return items;
    }

    return items.filter(item => {
      if (item.source === 'vault') {
        return filters.has('Notes');
      }
      if (item.source === 'homebrew') {
        return filters.has('Homebrew');
      }

      const normalizedCategory = (item.category || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      for (const filter of filters) {
        const normalizedFilter = filter.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedCategory === normalizedFilter) {
          return true;
        }
      }
      return false;
    });
  });

  toggleFilter(filter: string): void {
    const current = new Set(this.activeFilters());
    if (current.has(filter)) {
      current.delete(filter);
    } else {
      current.add(filter);
    }
    this.activeFilters.set(current);
  }

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

  @HostBinding('class.tauri-titlebar-mode')
  protected get isTauriTitlebarMode(): boolean {
    return this.titlebarMode();
  }

  openFromTopEdge(): void {}

  openAndFocus(): void {
    this.open(true);
  }

  close(): void {
    this.clearCloseTimer();
    this.isOpen.set(false);
    this.pointerInside = false;
  }

  onDrawerMouseEnter(): void {}

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
    if (nextTarget instanceof Node && this.host.nativeElement.contains(nextTarget)) {
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

    if (item.source === 'vault' || item.source === 'homebrew') {
      this.isDetailLoading.set(false);
      if (item.source === 'vault') {
        this.openVaultResult(item);
      }
      return;
    }

    if (!item.open5e) {
      return;
    }

    this.isDetailLoading.set(true);

    try {
      const detail = await this.open5eApi.getDetail(item.open5e);
      if (requestId !== this.detailRequestId) return;
      this.selectedDetail.set(detail);
    } catch (error) {
      if (requestId !== this.detailRequestId) return;
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
    if (!item?.open5e || item.source !== 'open5e') return;

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
        panelClass: ['glass-dialog-container', 'broadcast-dialog-panel'],
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
    if (!this.isOpen()) return;
    const target = event.target;
    if (target instanceof Node && this.host.nativeElement.contains(target)) return;
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
    if (currentDetail) return currentDetail;
    if (!item.open5e) throw new Error('No Open5e result selected.');

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

    const facts = this.open5eFacts(item.open5e!, detail).filter(fact => !['Type', 'Source'].includes(fact.label));
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

    return parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  }

  private safeFilename(value: string): string {
    return value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').slice(0, 80) || 'open5e-rule';
  }

  private async runSearch(query: string, requestId: number): Promise<void> {
    const currentServer = this.serverService.getCurrentServer();
    const vaultSearch = currentServer
      ? this.obsidianVaultService.searchVault(currentServer._id, query, 25)
      : Promise.resolve<VaultSearchResult[]>([]);

    const homebrewResults = currentServer
      ? this.homebrewPackService.searchServerItems(currentServer._id, query)
      : [];

    const [open5eResult, vaultResult] = await Promise.allSettled([
      this.open5eApi.search(query),
      vaultSearch,
    ]);

    if (requestId !== this.searchRequestId) return;

    const open5eResults = open5eResult.status === 'fulfilled' ? open5eResult.value : [];
    const vaultResults = vaultResult.status === 'fulfilled' ? vaultResult.value : [];

    this.results.set([
      ...homebrewResults.map(item => this.mapHomebrewResult(item)),
      ...vaultResults.map(result => this.mapVaultResult(result, currentServer?.name ?? 'Obsidian Vault')),
      ...open5eResults.map(result => this.mapOpen5eResult(result)),
    ]);

    if (requestId === this.searchRequestId) {
      this.isSearching.set(false);
    }
  }

  private mapHomebrewResult(item: IHomebrewPackItem & { packName: string }): SearchResultItem {
    const category = String(item.properties['type'] || 'Homebrew');
    return {
      id: `homebrew:${item.id}`,
      source: 'homebrew',
      title: item.name,
      category,
      subtitle: item.packName,
      snippet: this.compactText(item.description),
      homebrew: item,
    };
  }

  private mapOpen5eResult(result: Open5eSearchResult): SearchResultItem {
    return {
      id: `open5e:${result.object_pk}`,
      source: 'open5e',
      title: result.object_name,
      category: this.searchCategory(result),
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
      category: 'Notes',
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

  private searchCategory(result: Open5eSearchResult): string {
    const routeCategory = this.routeCategory(result.route);
    if (routeCategory) return routeCategory;
    const normalizedModel = (result.object_model || '').trim().toLowerCase();
    switch (normalizedModel) {
      case 'spell': return 'spells';
      case 'creature': return 'monsters';
      case 'rule': return 'rules';
      case 'item': return 'equipment';
      default: return result.object_model || 'Unknown';
    }
  }

  private routeCategory(route: string | undefined): string {
    if (!route) return '';
    const parts = route.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[1].toLowerCase() : '';
  }

  private open5eFacts(result: Open5eSearchResult, detail: Open5eDetail): DetailFact[] {
    const summary = result.object ?? {};
    return [
      { label: 'Type', value: this.objectModelLabel(result.object_model) },
      { label: 'Source', value: detail.document?.display_name ?? detail.document?.name ?? result.document?.name },
    ].filter((fact): fact is DetailFact => !!fact.value);
  }

  private open5eSections(result: Open5eSearchResult, detail: Open5eDetail, maxEntries?: number): DetailSection[] {
    const sections: DetailSection[] = [
      { title: 'Higher Levels', entries: this.arrayTextEntries(detail['higher_level']) },
      { title: 'Actions', entries: this.namedDescEntries(detail['actions']) },
      { title: 'Snippet', entries: this.arrayTextEntries(result.text) },
    ];
    return sections.map(s => ({ ...s, entries: maxEntries ? s.entries.slice(0, maxEntries) : s.entries })).filter(s => s.entries.length > 0);
  }

  private objectModelLabel(value: string): string {
    return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase());
  }

  private namedDescEntries(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(e => {
      if (!this.isRecord(e)) return '';
      return [this.stringValue(e['name']), this.textList(e['desc'])].filter(Boolean).join(': ');
    }).filter(Boolean);
  }

  private arrayTextEntries(value: unknown): string[] {
    if (typeof value === 'string') return value.trim() ? [value] : [];
    if (!Array.isArray(value)) return [];
    return value.map(e => String(e)).filter(Boolean);
  }

  private textList(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(e => String(e)).filter(Boolean).join('\n\n');
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private compactText(value: string | undefined | null): string {
    if (!value) return '';
    return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
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
    const parsed = marked.parse(value, { async: false, breaks: false, gfm: true });
    return typeof parsed === 'string' ? parsed : '';
  }

  private normalizeOpen5eMarkdown(value: string): string {
    return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private looksLikeMarkdown(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return [
      /^#{1,6}\s+\S/m,
      /^\s{0,3}[-*+]\s+\S/m,
      /^\s{0,3}\d+\.\s+\S/m,
      /^\s{0,3}>\s+\S/m,
      /```[\s\S]*```/,
      /`[^`\n]+`/,
      /(\*\*|__)\S[\s\S]*?\S\1/,
      /\[[^\]]+]\([^)]+\)/,
    ].some(pattern => pattern.test(trimmed));
  }
}
