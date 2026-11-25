import { Injectable } from '@angular/core';
import type { VttCharacterTokenPayload } from '../../models/vttsync/vttsync.model';
import { FileService } from '../file/file';
import { VttSync } from '../vttsync/vttsync';
import { ObsidianVaultService } from './obsidian-vault-service';
import { BlockKind, StatblockData, blockNoun, rollInitiative, statblockImage, tokenNames, tokenStats } from './statblock';
import { VaultIndexService } from './vault-index.service';
import { getVaultDisplayName, getVaultFileType } from './vault-file-types';

export interface AddStatblockToVttRequest {
  serverId: string;
  /** The note holding the statblock (token pictures are resolved relative to it). */
  notePath: string;
  data: StatblockData;
  /** Creature (default) or item. Items get no HP or initiative. */
  kind?: BlockKind;
  /** How many tokens to add ("Goblin 1", "Goblin 2"…). */
  count?: number;
  /** Roll initiative for each token and add it to the turn order (when one is running). */
  rollInitiative?: boolean;
}

export interface AddStatblockToVttResult {
  /** Tokens the map accepted; 0 when no map is open for this server. */
  added: number;
  /** Initiative rolled per added token (empty when not rolled). */
  initiative: number[];
  /** The token picture couldn't be found or uploaded, so tokens were added without it. */
  imageProblem: string | null;
}

/**
 * Puts statblocks on the VTT map. Vault pictures only exist on the GM's computer, so they're
 * uploaded once (per file version) and players load the uploaded copy.
 */
@Injectable({ providedIn: 'root' })
export class StatblockVttService {
  /** Uploaded URL per vault file version. */
  private readonly uploads = new Map<string, Promise<string>>();

  constructor(
    private vttSync: VttSync,
    private vaultService: ObsidianVaultService,
    private vaultIndexService: VaultIndexService,
    private fileService: FileService
  ) {}

  async addToVtt(request: AddStatblockToVttRequest): Promise<AddStatblockToVttResult> {
    const kind = request.kind ?? 'creature';
    const stats = tokenStats(request.data, kind);
    const { url, problem } = await this.tokenImageUrl(request.serverId, request.notePath, request.data);
    const names = tokenNames(stats.name, Math.max(1, Math.min(20, Math.floor(request.count ?? 1))));
    const source = getVaultDisplayName(request.notePath.split('/').pop() || request.notePath);

    let added = 0;
    const initiative: number[] = [];
    for (const [i, name] of names.entries()) {
      const roll = request.rollInitiative && kind === 'creature' ? rollInitiative(stats.initiativeBonus) : null;
      const token: VttCharacterTokenPayload = {
        name,
        icon: url,
        ownerId: null,
        isPlayer: false,
        maxHealth: stats.maxHealth,
        size: stats.size,
        notes: `From ${blockNoun(kind)}: ${source}`,
        initiative: roll,
      };
      // Spread copies out a little so they don't stack on one square.
      const ok = await this.vttSync.addTokenToActiveVtt(token, request.serverId, 100 + i * 60, 100);
      if (!ok) break;
      added++;
      if (roll !== null) initiative.push(roll);
    }
    return { added, initiative, imageProblem: problem };
  }

  /** A URL every player can load for the statblock's picture, or null for none. */
  private async tokenImageUrl(serverId: string, notePath: string, data: StatblockData): Promise<{ url: string | null; problem: string | null }> {
    const ref = statblockImage(data);
    if (!ref) return { url: null, problem: null };
    if (/^https?:\/\//i.test(ref)) return { url: ref, problem: null };

    const index = this.vaultIndexService.get(serverId) ?? await this.vaultIndexService.load(serverId);
    const entry = index.resolveFile(ref, notePath) ?? index.resolveLink(ref, notePath);
    if (!entry || entry.kind !== 'file' || getVaultFileType(entry.name).viewer !== 'image') {
      return { url: null, problem: `Token picture not found: ${ref}` };
    }

    try {
      const file = await this.vaultService.readFileAsBlob(serverId, entry.relativePath);
      const key = `${serverId}|${entry.relativePath}|${file.lastModified}|${file.size}`;
      let upload = this.uploads.get(key);
      if (!upload) {
        upload = this.fileService.uploadFileInChunks(file).then(result => result.url);
        this.uploads.set(key, upload);
        upload.catch(() => this.uploads.delete(key));
      }
      return { url: await upload, problem: null };
    } catch (error) {
      console.error('[Statblock] Failed to upload token picture', entry.relativePath, error);
      return { url: null, problem: 'Couldn’t upload the token picture' };
    }
  }
}
