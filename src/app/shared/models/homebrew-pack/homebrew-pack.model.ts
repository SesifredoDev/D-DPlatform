export interface IHomebrewPackItem {
  id: string;
  name: string;
  description: string; // Markdown string
  properties: Record<string, string>; // Fluid object of tags (e.g. {"type": "item", "rarity": "common"})
}

export interface IHomebrewPack {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  attachedServerIds: string[];
  items: IHomebrewPackItem[];
  createdAt: number;
  updatedAt: number;
}
