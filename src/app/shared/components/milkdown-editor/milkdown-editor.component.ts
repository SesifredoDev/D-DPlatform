import {
  ApplicationRef,
  Component,
  EnvironmentInjector,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  ViewChild,
  ViewEncapsulation,
  SimpleChanges,
  AfterViewInit,
} from '@angular/core';
import { Crepe } from '@milkdown/crepe';
import { wikilinkPlugin } from './wikilink-plugin';
import { editorViewCtx, editorViewOptionsCtx, serializerCtx } from '@milkdown/core';
import { Selection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { insert } from '@milkdown/utils';
import { CALENDAR_MENU_ICON, CALLOUT_MENU_ITEMS, DATE_MENU_ICON, MAP_MENU_ICON, SECRET_MENU_ICON, SECRET_TEMPLATE, TIMELINE_MENU_ICON, calloutPlugin, insertCallout } from './callout-plugin';
import { ObsidianVaultService } from '../../services/ObsidianVault/obsidian-vault-service';
import { splitFrontmatter } from '../../services/ObsidianVault/frontmatter';
import { VaultIndexService } from '../../services/ObsidianVault/vault-index.service';
import { getVaultDisplayName, getVaultFileType } from '../../services/ObsidianVault/vault-file-types';
import { WikilinkCandidate, openEmbedPicker, wikilinkSuggestPlugin } from './wikilink-suggest-plugin';
import { StatblockViewHost, statblockNodeViewsPlugin } from './statblock-node-views';
import { createStatblockPaste } from './statblock-paste-plugin';
import { DICE_CLASS, dicePlugin } from './dice-plugin';
import { DateDisplay, DateHost, datePlugin, refreshDatesMeta } from './date-plugin';
import { openDatePicker } from './date-picker';
import { CalendarService, ResolvedDate } from '../../services/ObsidianVault/calendar.service';
import { Subscription } from 'rxjs';
import { DiceRollService } from '../../services/dice/dice-roll.service';

@Component({
  selector: 'app-milkdown-editor',
  standalone: true,
  // Projected content (e.g. the note's properties) sits above the text and scrolls with it.
  template: `<div class="milkdown-container"><ng-content></ng-content><div #editorRef class="milkdown-root"></div></div>`,
  styleUrls: ['./milkdown-editor.component.scss'],
  encapsulation: ViewEncapsulation.None,
})
export class MilkdownEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('editorRef') editorRef!: ElementRef;

  @Input() markdown: string = '';
  @Input() set editorMarkdown(value: string | null | undefined) {
    this.markdown = value ?? '';
  }

  @Input() isPreview: boolean = false;
  @Input() serverId: string = '';
  @Input() currentFilePath: string = '';

  @Output() markdownChange = new EventEmitter<string>();
  @Output() onLinkClick = new EventEmitter<string>();
  /**
   * Fires when the pointer enters a wikilink (with the link target and its on-screen box) and
   * `null` when it leaves. Used for hover previews; the host decides delays and what to show.
   */
  @Output() linkHover = new EventEmitter<{ target: string; rect: DOMRect } | null>();

  private hoveredLink: HTMLElement | null = null;
  /** Set once the note is clicked or typed into, so inserts go at the cursor rather than the top. */
  private cursorPlaced = false;

  /**
   * A read-aloud block's Broadcast button was clicked: the block as Markdown and as rendered HTML.
   * Read-aloud blocks only show the button when something listens to this.
   */
  @Output() blockBroadcast = new EventEmitter<{ markdown: string; html: string }>();

  /** A statblock saved a picture into the vault, so the file list should be refreshed. */
  @Output() filesAdded = new EventEmitter<void>();

  private crepe?: Crepe;
  /** Full note text (frontmatter + body) as last loaded or emitted. */
  private lastMarkdown?: string;
  /**
   * The note's YAML frontmatter block. The editor only ever sees the body: CommonMark has no
   * frontmatter and would save it as a horizontal rule plus a heading. It's re-attached on emit.
   */
  private frontmatter = '';
  private objectUrls: string[] = [];
  private observer?: MutationObserver;
  private processingEmbeds = false;
  private suppressObserver = false;
  private retryTimeouts: Map<string, any> = new Map();

  // Common image extensions to try when a wikilink doesn't provide one
  // This helps differentiate between a folder and a file with the same name.
  private readonly imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

  // Prevents concurrent createEditor() calls from stomping each other.
  // The editorView-not-found error happens when a second create() starts
  // before the first destroy() has fully resolved.
  private creationLock = false;

  constructor(
    private vaultService: ObsidianVaultService,
    private vaultIndexService: VaultIndexService,
    private diceRolls: DiceRollService,
    private calendarService: CalendarService,
    appRef: ApplicationRef,
    injector: EnvironmentInjector
  ) {
    this.statblockHost = {
      appRef,
      injector,
      serverId: () => this.serverId,
      filePath: () => this.currentFilePath,
      readonly: () => this.isPreview,
      openLink: link => this.onLinkClick.emit(link),
      filesAdded: () => this.filesAdded.emit(),
      linkHover: event => this.linkHover.emit(event),
    };
  }

  /** Dates in the note (`[date:: …]`), read with the vault's calendars. */
  private readonly dateHost: DateHost = {
    resolve: texts => {
      const list = this.calendarService.cached(this.serverId);
      if (!list) {
        if (this.serverId) void this.calendarService.load(this.serverId);
        return texts.map(() => undefined);
      }
      const index = this.vaultIndexService.get(this.serverId);
      const preferred = this.calendarService.find(list, this.noteCalendar(), index, this.currentFilePath);
      return this.calendarService.resolveSequence(list, texts, preferred).map(resolved => (resolved ? toDateDisplay(resolved) : null));
    },
    open: display => this.onLinkClick.emit(`${display.calendarPath}#${display.label}`),
  };
  private calendarsSub?: Subscription;

  /** The calendar the note asks for in its frontmatter (`calendar:` or Calendarium's `fc-calendar:`). */
  private noteCalendar(): string | null {
    const match = this.frontmatter.match(/^(?:fc-)?calendar:\s*["']?(.+?)["']?\s*$/im);
    return match ? match[1].replace(/^\[\[|\]\]$/g, '') : null;
  }

  /** Lets statblock cards and note embeds (Angular components inside the editor) reach this editor. */
  private readonly statblockHost: StatblockViewHost;

  /** Notes offered by `[[` autocomplete: every file in this server's vault except the open one. */
  private readonly wikilinkCandidates = (): WikilinkCandidate[] => {
    const index = this.vaultIndexService.get(this.serverId);
    if (!index) {
      // Not loaded yet (e.g. the session-notes panel): load it for next time.
      if (this.serverId) void this.vaultIndexService.load(this.serverId).catch(() => undefined);
      return [];
    }

    return index.files
      .filter(file => file.relativePath !== this.currentFilePath)
      .map(file => ({
        title: getVaultDisplayName(file.name),
        folder: file.parentPath,
        icon: getVaultFileType(file.name).icon,
        linkText: index.linkTextFor(file),
        kind: getVaultFileType(file.name).id,
      }));
  };

  async ngAfterViewInit() {
    setTimeout(() => this.createEditor(), 0);
  }

  async ngOnChanges(changes: SimpleChanges) {
    if (!this.crepe) return;

    // Only the frontmatter changed (e.g. tags edited from the note header): keep the editor
    // (and the cursor) and just swap the block that gets re-attached on save.
    const markdownChanged =
      (changes['markdown'] && !changes['markdown'].isFirstChange()) ||
      (changes['editorMarkdown'] && !changes['editorMarkdown'].isFirstChange());
    if (markdownChanged && this.markdown !== this.lastMarkdown && this.lastMarkdown !== undefined) {
      const incoming = splitFrontmatter(this.markdown);
      const current = splitFrontmatter(this.lastMarkdown);
      if (incoming.body === current.body) {
        this.frontmatter = incoming.block;
        this.lastMarkdown = this.markdown;
      }
    }

    const shouldRecreate =
      (changes['isPreview'] && !changes['isPreview'].isFirstChange()) ||
      (changes['editorMarkdown'] &&
        !changes['editorMarkdown'].isFirstChange() &&
        this.markdown !== this.lastMarkdown) ||
      (changes['markdown'] &&
        !changes['markdown'].isFirstChange() &&
        changes['markdown'].currentValue !== this.lastMarkdown) ||
      (changes['currentFilePath'] && !changes['currentFilePath'].isFirstChange());

    if (shouldRecreate) {
      this.createEditor();
    }
  }

  private async createEditor() {
    // If a creation is already in progress, skip — the in-flight call will use
    // the latest this.markdown / this.isPreview values when it finishes.
    if (this.creationLock) return;
    this.creationLock = true;

    this.revokeObjectUrls();
    this.observer?.disconnect();
    this.clearRetries();

    if (this.crepe) {
      try {
        await this.crepe.destroy();
      } catch (e) { /* non-fatal */ }
      this.crepe = undefined;
    }

    const { block, body } = splitFrontmatter(this.markdown);
    this.frontmatter = block;
    this.cursorPlaced = false;

    const localCrepe = new Crepe({
      root: this.editorRef.nativeElement,
      defaultValue: body,
      featureConfigs: {
        // + / slash block menu: "GM secret" next to Quote, plus a "Callouts" group.
        [Crepe.Feature.BlockEdit]: {
          buildMenu: builder => {
            const textGroup = builder.getGroup('text');
            textGroup.addItem('gm-secret', {
              label: 'GM secret',
              icon: SECRET_MENU_ICON,
              onRun: ctx => insertCallout(ctx.get(editorViewCtx), SECRET_TEMPLATE, { replaceCurrentLine: true }),
            });
            // Show it right after Quote rather than at the end of the group.
            const items = textGroup.group.items;
            const quoteAt = items.findIndex(item => item.key === 'quote');
            if (quoteAt >= 0) {
              items.splice(quoteAt + 1, 0, items.pop()!);
            }

            // Things from the vault, embedded as live cards.
            const vault = builder.addGroup('vault', 'Vault');
            vault.addItem('date', {
              label: 'Date',
              icon: DATE_MENU_ICON,
              onRun: ctx => this.openDatePickerAt(ctx.get(editorViewCtx)),
            });
            vault.addItem('timeline', {
              label: 'Timeline',
              icon: TIMELINE_MENU_ICON,
              onRun: ctx => openEmbedPicker(
                ctx.get(editorViewCtx),
                'timeline',
                'No timelines in this vault yet. Create one with + → New timeline in the file list.'
              ),
            });
            vault.addItem('calendar', {
              label: 'Calendar',
              icon: CALENDAR_MENU_ICON,
              onRun: ctx => openEmbedPicker(
                ctx.get(editorViewCtx),
                'calendar',
                'No calendars in this vault yet. Create one with + → New calendar in the file list.'
              ),
            });
            vault.addItem('map', {
              label: 'Map',
              icon: MAP_MENU_ICON,
              onRun: ctx => openEmbedPicker(
                ctx.get(editorViewCtx),
                'map',
                'No maps in this vault yet. Create one with + → New map in the file list.'
              ),
            });

            const callouts = builder.addGroup('callouts', 'Callouts');
            for (const item of CALLOUT_MENU_ITEMS) {
              callouts.addItem(item.key, {
                label: item.label,
                icon: item.icon,
                onRun: ctx => insertCallout(ctx.get(editorViewCtx), item.template, { replaceCurrentLine: true }),
              });
            }
          },
        },
      },
    });

    const statblockPaste = createStatblockPaste();
    localCrepe.editor
      .config((ctx) => {
        ctx.set(editorViewOptionsCtx, {
          editable: () => !this.isPreview,
          // Runs before the editor's clipboard plugin, which would otherwise take every paste.
          handlePaste: (view, event) => statblockPaste.handlePaste(view, event),
        });
      })
      .use(statblockPaste.plugin)
      .use(dicePlugin)
      .use(datePlugin(this.dateHost))
      .use(statblockNodeViewsPlugin(this.statblockHost))
      .use(wikilinkPlugin)
      .use(wikilinkSuggestPlugin(this.wikilinkCandidates))
      .use(calloutPlugin({
        canBroadcast: () => this.blockBroadcast.observed,
        onBroadcastBlock: pos => this.emitBlockBroadcast(pos),
      }));

    localCrepe.on((listener) => {
      listener.markdownUpdated((ctx, markdown, prevMarkdown) => {
        const full = this.frontmatter + markdown;
        this.lastMarkdown = full;
        if (markdown !== prevMarkdown) {
          this.markdownChange.emit(full);
        }
      });
    });

    try {
      await localCrepe.create();
      this.crepe = localCrepe;
      this.watchCalendars();
      this.lastMarkdown = this.markdown;

      requestAnimationFrame(() => {
        this.processEmbeds();
        this.setupObserver();
      });
    } catch (e) { /* Create failed */ } finally {
      this.creationLock = false;
    }

    this.editorRef.nativeElement.onclick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Dice expressions: a plain click rolls (the cursor still lands there), Shift+click also posts.
      // Not on double-clicks (selecting a word) or drags that end on the dice.
      const dice = target.closest<HTMLElement>(`.${DICE_CLASS}`);
      if (dice?.dataset['dice'] && e.detail <= 1 && (e.shiftKey || window.getSelection()?.isCollapsed !== false)) {
        this.diceRolls.roll(dice.dataset['dice'], { post: e.shiftKey, label: this.noteTitle() });
      }

      const link = target.closest('a');
      const href = link?.getAttribute('href') || '';
      // Identify links via class OR the custom protocol in case class was stripped
      if (link && (link.classList.contains('wikilink') || href.startsWith('wikilink:'))) {
        const targetPath = href.replace(/^wikilink:/, '');
        console.log('[Milkdown] Wikilink link clicked. Routing to:', targetPath);
        this.onLinkClick.emit(targetPath);
        e.preventDefault();
      }
    };

    this.editorRef.nativeElement.onmousedown = (e: MouseEvent) => {
      this.cursorPlaced = true;
      // Shift+click on dice posts the roll; don't let it extend the text selection too.
      if (e.shiftKey && (e.target as HTMLElement).closest(`.${DICE_CLASS}`)) e.preventDefault();
    };
    this.editorRef.nativeElement.onkeydown = () => (this.cursorPlaced = true);

    this.editorRef.nativeElement.onmouseover = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('a');
      const href = link?.getAttribute('href') || '';
      if (!link || !(link.classList.contains('wikilink') || href.startsWith('wikilink:')) || link === this.hoveredLink) return;

      this.hoveredLink = link;
      this.linkHover.emit({ target: href.replace(/^wikilink:/, ''), rect: link.getBoundingClientRect() });
    };

    this.editorRef.nativeElement.onmouseout = (e: MouseEvent) => {
      const next = e.relatedTarget as Node | null;
      if (!this.hoveredLink || (next && this.hoveredLink.contains(next))) return;

      this.hoveredLink = null;
      this.linkHover.emit(null);
    };
  }

  private setupObserver() {
    this.observer = new MutationObserver(() => {
      if (!this.processingEmbeds && !this.suppressObserver) {
        this.processEmbeds();
      }
    });
    this.observer.observe(this.editorRef.nativeElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'class'],
    });
  }

  private async processEmbeds() {
    // Find all images that need resolution.
    // We check for our custom class, our custom protocol, or raw local paths that browsers block.
    const allImgs = Array.from(this.editorRef.nativeElement.querySelectorAll('img:not([data-resolved])')) as HTMLImageElement[];
    const embeds = allImgs.filter(img => {
      const src = img.getAttribute('src') || '';
      return (
        img.classList.contains('wikilink-image') ||
        src.startsWith('wikilink-blob:') ||
        src.startsWith('file:///') ||
        /^[a-zA-Z]:[\\/]/.test(src)
      );
    });

    if (embeds.length === 0) {
      // Only log this occasionally to avoid spam; use a counter if needed
      return;
    }

    this.processingEmbeds = true;

    try {
      for (const img of Array.from(embeds)) {
        let path = img.getAttribute('data-path') || '';
        const src = img.getAttribute('src') || '';

        // Extract path from various formats if data-path is missing or stripped
        if (!path) {
          if (src.startsWith('wikilink-blob:')) {
            path = decodeURIComponent(src.replace('wikilink-blob:', ''));
          } else if (src.startsWith('file:///')) {
            path = decodeURIComponent(src.replace('file:///', ''));
          } else if (/^[a-zA-Z]:[\\/]/.test(src)) {
            path = src;
          }
        }

        if (!path || path.startsWith('blob:') || path.startsWith('http')) {
          continue;
        }

        const blob = await this.resolveBlob(path);

        if (blob) {
          if (blob.type.startsWith('image/')) {
            const url = URL.createObjectURL(blob);
            this.objectUrls.push(url);
            this.suppressObserver = true;
            img.src = url;
            img.setAttribute('data-resolved', 'true');
            img.style.maxWidth = '100%';
            img.style.display = 'block';
            img.style.margin = '1rem 0';
            img.style.borderRadius = '4px';
            await Promise.resolve(); // flush microtasks before re-enabling observer
            this.suppressObserver = false;
            this.retryTimeouts.delete(path);
          } else {
            img.setAttribute('data-resolved', 'not-an-image');
          }
        } else {
          if (!this.retryTimeouts.has(path)) {
            const timeout = setTimeout(() => {
              this.retryTimeouts.delete(path);
              this.processEmbeds();
            }, 3000);
            this.retryTimeouts.set(path, timeout);
          }
        }
      }
    } finally {
      this.processingEmbeds = false;
    }
  }

  private async resolveBlob(path: string): Promise<Blob | null> {
    if (!this.serverId) return null;

    // Normalize the path: remove hidden characters and fix slashes
    const cleanPath = path.trim()
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\\/g, '/');

    // Extract just the filename for the recursive search
    const filename = cleanPath.includes('/') ? cleanPath.split('/').pop()! : cleanPath;

    // Generate a list of candidate filenames to check.
    // If the path doesn't have an extension, we try the raw name first, then append common image extensions.
    const hasExtension = filename.includes('.');
    const candidates = hasExtension
      ? [filename]
      : [filename, ...this.imageExtensions.map(ext => `${filename}.${ext}`)];

    console.log(`[Milkdown] Resolving embed path: "${path}". Candidates:`, candidates);

    for (const candidate of candidates) {
      // Step 1: Search through every possible directory chain (Recursive Search)
      const absoluteVaultPath = await this.vaultService.findFileByFilename(this.serverId, candidate);

      if (absoluteVaultPath) {
        console.log(`[Milkdown] Match found via filename search: ${absoluteVaultPath}`);
        try {
          // Ensure we are reading a file. If the path points to a directory,
          // readFileAsBlob should ideally return null or throw.
          const blob = await this.vaultService.readFileAsBlob(this.serverId, absoluteVaultPath);
          if (blob) {
            console.log(`[Milkdown] ✓ Candidate resolved as FILE: ${absoluteVaultPath}`);
            return blob;
          }
        } catch (e) {
          console.log(`[Milkdown] ⚠ Path exists but is not a file (likely a FOLDER): ${absoluteVaultPath}`);
        }
      }

      // Step 2: root-level direct path
      // We also check the candidate at the root level in case the recursive search missed it or order matters.
      const rootPath = hasExtension ? cleanPath : (cleanPath.endsWith('/') ? cleanPath.slice(0, -1) : cleanPath) + (candidate.includes('.') ? candidate.substring(candidate.lastIndexOf('.')) : '');

      try {
        const blob = await this.vaultService.readFileAsBlob(this.serverId, rootPath);
        if (blob) {
          console.log(`[Milkdown] ✓ Resolved as FILE via root path: ${rootPath}`);
          return blob;
        }
      } catch (e) {
        // Non-fatal, continue to next candidate or step
      }

      // Step 3: relative to current file
      if (this.currentFilePath) {
        const dir = this.currentFilePath.split('/').slice(0, -1).join('/');
        const relativePath = this.vaultService.resolveRelativePath(dir, candidate);
        try {
          const blob = await this.vaultService.readFileAsBlob(this.serverId, relativePath);
          if (blob) {
            console.log(`[Milkdown] ✓ Resolved as FILE via relative path: ${relativePath}`);
            return blob;
          }
        } catch (e) {
          // Non-fatal
        }
      }
    }
    console.log(`[Milkdown] ✗ Could not resolve path to a file: ${cleanPath}`);
    return null;
  }

  private clearRetries() {
    this.retryTimeouts.forEach((t) => clearTimeout(t));
    this.retryTimeouts.clear();
  }

  private revokeObjectUrls() {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  /**
   * Inserts a GM-only `> [!secret]` callout (see `insertSecretBlock`). Returns false if the editor
   * isn't ready or is read-only.
   */
  insertSecretBlock(): boolean {
    if (!this.crepe || this.isPreview) return false;
    this.crepe.editor.action(ctx => insertCallout(ctx.get(editorViewCtx), SECRET_TEMPLATE));
    return true;
  }

  /** + → Date: a calendar picker at the cursor that inserts `[date:: …]`. */
  private async openDatePickerAt(view: EditorView): Promise<void> {
    const list = this.calendarService.cached(this.serverId) ?? (this.serverId ? await this.calendarService.load(this.serverId) : []);
    const index = this.vaultIndexService.get(this.serverId);
    openDatePicker(view, list, this.calendarService.find(list, this.noteCalendar(), index, this.currentFilePath));
  }

  /** The open note's name, used to label dice rolled from it. */
  private noteTitle(): string | undefined {
    const name = this.currentFilePath.split('/').pop();
    return name ? getVaultDisplayName(name) : undefined;
  }

  /**
   * Inserts Markdown (e.g. a statblock block or an `![[embed]]`) at the cursor, or at the end of the
   * note if it hasn't been clicked into yet. Returns false if the editor isn't ready or is read-only.
   */
  insertMarkdown(markdown: string): boolean {
    if (!this.crepe || this.isPreview) return false;
    const editor = this.crepe.editor;
    if (!this.cursorPlaced) {
      editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
      });
    }
    editor.action(insert(markdown));
    this.cursorPlaced = true;
    return true;
  }

  /** Serialises the block at `pos` (a read-aloud callout) and emits it for broadcasting. */
  private emitBlockBroadcast(pos: number): void {
    this.crepe?.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const node = view.state.doc.nodeAt(pos);
      if (!node) return;

      const markdown = ctx.get(serializerCtx)(view.state.schema.topNodeType.create(null, [node]));
      const dom = view.nodeDOM(pos);
      this.blockBroadcast.emit({ markdown, html: dom instanceof HTMLElement ? dom.outerHTML : '' });
    });
  }

  /** Re-reads dates when the vault's calendars change. */
  private watchCalendars(): void {
    this.calendarsSub?.unsubscribe();
    this.calendarsSub = this.calendarService.changed$.subscribe(serverId => {
      if (serverId !== this.serverId || !this.crepe) return;
      this.crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setMeta(refreshDatesMeta.key, refreshDatesMeta.value));
      });
    });
  }

  ngOnDestroy() {
    this.calendarsSub?.unsubscribe();
    this.clearRetries();
    this.observer?.disconnect();
    this.revokeObjectUrls();
    this.crepe?.destroy();
  }
}

/** How a resolved date shows in the editor (chip, hover card). */
function toDateDisplay(resolved: ResolvedDate): DateDisplay {
  const { engine, name, path } = resolved.calendar;
  const { date, precision } = resolved.parsed;
  return {
    label: resolved.label,
    long: precision === 'day' ? engine.formatLong(date) : resolved.label,
    calendarName: name,
    calendarPath: path,
    relative: precision === 'day' ? engine.relativeToToday(date) : null,
    holidays: precision === 'day' ? engine.holidaysOn(date).map(holiday => holiday.name) : [],
  };
}
