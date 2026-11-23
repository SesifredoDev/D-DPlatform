import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, Output, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import type { VaultEntry } from '../../../../shared/services/ObsidianVault/obsidian-vault-service';
import { getVaultDisplayName, getVaultFileType } from '../../../../shared/services/ObsidianVault/vault-file-types';
import { TextSegment, fuzzyMatch, segmentsFromIndices } from '../../../../shared/services/ObsidianVault/vault-search-utils';

interface SwitcherItem {
  entry: VaultEntry;
  icon: string;
  title: TextSegment[];
  folder: string;
  isRecent: boolean;
}

const MAX_RESULTS = 50;

/**
 * Ctrl+O "jump to note" palette. Fuzzy-matches file names (and paths when the query has a '/'),
 * shows recently opened files when the query is empty, and is fully keyboard driven.
 */
@Component({
  selector: 'app-vault-quick-switcher',
  standalone: true,
  imports: [FormsModule, MatIconModule],
  templateUrl: './quick-switcher.component.html',
  styleUrl: './quick-switcher.component.scss',
})
export class VaultQuickSwitcherComponent implements OnChanges, AfterViewInit {
  @Input() files: VaultEntry[] = [];
  /** Recently opened paths, most recent first. */
  @Input() recentPaths: string[] = [];
  @Output() pick = new EventEmitter<VaultEntry>();
  @Output() close = new EventEmitter<void>();

  @ViewChild('queryInput') private queryInput?: ElementRef<HTMLInputElement>;
  @ViewChild('list') private list?: ElementRef<HTMLElement>;

  query = '';
  items: SwitcherItem[] = [];
  activeIndex = 0;

  ngOnChanges(): void {
    this.refresh();
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.queryInput?.nativeElement.focus());
  }

  onQueryChange(): void {
    this.activeIndex = 0;
    this.refresh();
  }

  onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveActive(-1);
        break;
      case 'Enter':
        event.preventDefault();
        if (this.items[this.activeIndex]) {
          this.pick.emit(this.items[this.activeIndex].entry);
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.close.emit();
        break;
    }
  }

  private moveActive(delta: number): void {
    if (!this.items.length) return;
    this.activeIndex = (this.activeIndex + delta + this.items.length) % this.items.length;
    setTimeout(() => {
      this.list?.nativeElement
        .querySelector<HTMLElement>(`[data-index="${this.activeIndex}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  private refresh(): void {
    const query = this.query.trim();
    const recent = new Map(this.recentPaths.map((path, index) => [path, index]));

    if (!query) {
      const recentFiles = this.recentPaths
        .map(path => this.files.find(file => file.relativePath === path))
        .filter((file): file is VaultEntry => !!file);
      const others = this.files
        .filter(file => !recent.has(file.relativePath))
        .sort((a, b) => a.name.localeCompare(b.name));
      this.items = [...recentFiles, ...others]
        .slice(0, MAX_RESULTS)
        .map(entry => this.toItem(entry, [], recent.has(entry.relativePath)));
      return;
    }

    const matchPath = query.includes('/');
    this.items = this.files
      .map(entry => {
        const title = getVaultDisplayName(entry.name);
        const nameMatch = fuzzyMatch(query, title);
        const pathMatch = matchPath ? fuzzyMatch(query, entry.relativePath) : null;
        const score = Math.max(nameMatch?.score ?? -Infinity, (pathMatch?.score ?? -Infinity) * 0.8);
        // Small boost for recently opened files.
        const boost = recent.has(entry.relativePath) ? 10 - recent.get(entry.relativePath)! : 0;
        return { entry, nameMatch, score: score + boost };
      })
      .filter(candidate => Number.isFinite(candidate.score))
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, MAX_RESULTS)
      .map(candidate => this.toItem(candidate.entry, candidate.nameMatch?.indices ?? [], recent.has(candidate.entry.relativePath)));
  }

  private toItem(entry: VaultEntry, indices: number[], isRecent: boolean): SwitcherItem {
    return {
      entry,
      icon: getVaultFileType(entry.name).icon,
      title: segmentsFromIndices(getVaultDisplayName(entry.name), indices),
      folder: entry.parentPath,
      isRecent,
    };
  }
}
