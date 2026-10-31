import type { Open5eSearchResult } from '../../open5e-api/open5e-api.service.model';
import type { VaultSearchResult } from '../../ObsidianVault/obsidian-vault-service.model';
import {IHomebrewPackItem} from '../../homebrew-pack/homebrew-pack.model';

export interface DetailFact {
  label: string;
  value: string;
}

export interface DetailSection {
  title: string;
  entries: string[];
}

export interface RichTextBlock {
  text: string;
  html: string;
  isMarkdown: boolean;
}

export interface RichDetailSection {
  title: string;
  entries: RichTextBlock[];
  hasMarkdown: boolean;
}

export interface SearchResultItem {
  id: string;
  source: 'open5e' | 'vault' | 'homebrew';
  title: string;
  category: string;
  subtitle: string;
  snippet: string;
  open5e?: Open5eSearchResult;
  vault?: VaultSearchResult;
  homebrew?: IHomebrewPackItem & { packName: string };
}
