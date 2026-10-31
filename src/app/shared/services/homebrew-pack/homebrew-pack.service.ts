import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { IHomebrewPack, IHomebrewPackItem } from '../../models/homebrew-pack/homebrew-pack.model';

@Injectable({
  providedIn: 'root',
})
export class HomebrewPackService {
  private readonly packsState = signal<IHomebrewPack[]>([]);

  readonly packs = this.packsState.asReadonly();

  constructor() {
    void this.loadPacks();
  }

  /** Load all locally stored homebrew packs via Tauri backend */
  async loadPacks(): Promise<void> {
    try {
      const rawPacks = await invoke<string[]>('get_homebrew_packs');
      const parsedPacks: IHomebrewPack[] = rawPacks
        .map(json => {
          try {
            return JSON.parse(json) as IHomebrewPack;
          } catch {
            return null;
          }
        })
        .filter((pack): pack is IHomebrewPack => pack !== null);

      this.packsState.set(parsedPacks);
    } catch (error) {
      console.error('Failed to load homebrew packs:', error);
    }
  }

  /** Create or update a homebrew pack */
  async savePack(pack: IHomebrewPack): Promise<void> {
    const updatedPack: IHomebrewPack = {
      ...pack,
      updatedAt: Date.now(),
      createdAt: pack.createdAt || Date.now(),
    };

    const jsonString = JSON.stringify(updatedPack, null, 2);
    await invoke('save_homebrew_pack', {
      packId: updatedPack.id,
      packJson: jsonString,
    });

    // Update local reactive state
    this.packsState.update(current => {
      const index = current.findIndex(p => p.id === updatedPack.id);
      if (index >= 0) {
        const copy = [...current];
        copy[index] = updatedPack;
        return copy;
      }
      return [...current, updatedPack];
    });
  }

  /** Delete a homebrew pack */
  async deletePack(packId: string): Promise<void> {
    await invoke('delete_homebrew_pack', { packId });
    this.packsState.update(current => current.filter(p => p.id !== packId));
  }

  /** Attach or detach a pack from a server */
  async toggleServerAttachment(packId: string, serverId: string, attach: boolean): Promise<void> {
    const pack = this.packsState().find(p => p.id === packId);
    if (!pack) return;

    const serverIdsSet = new Set(pack.attachedServerIds || []);
    if (attach) {
      serverIdsSet.add(serverId);
    } else {
      serverIdsSet.delete(serverId);
    }

    await this.savePack({
      ...pack,
      attachedServerIds: Array.from(serverIdsSet),
    });
  }

  /** Get flattened homebrew items for a specific server matching a search query */
  searchServerItems(serverId: string, query: string): Array<IHomebrewPackItem & { packName: string }> {
    const lowerQuery = query.toLowerCase();
    const serverPacks = this.packs().filter(p => p.attachedServerIds?.includes(serverId));
    const results: Array<IHomebrewPackItem & { packName: string }> = [];

    for (const pack of serverPacks) {
      for (const item of pack.items || []) {
        const matchesName = item.name.toLowerCase().includes(lowerQuery);
        const matchesDesc = item.description.toLowerCase().includes(lowerQuery);
        const matchesProps = Object.entries(item.properties).some(
          ([key, val]) =>
            key.toLowerCase().includes(lowerQuery) || String(val).toLowerCase().includes(lowerQuery)
        );

        if (matchesName || matchesDesc || matchesProps) {
          results.push({ ...item, packName: pack.name });
        }
      }
    }
    return results;
  }
}
