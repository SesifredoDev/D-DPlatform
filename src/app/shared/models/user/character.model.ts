export interface BaseStats {
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  wisdom: number;
  charisma: number;
}

export interface CharacterClass {
  className: string;
  subclassName: string | null;
  level: number;
}

export interface Character {
  _id?: string;               // MongoDB internal ID
  ownerId: string;
  servers: string[];          // Array of Server ObjectIds
  ddbId?: number | null;      // D&D Beyond ID
  pdfLink?: string | null;    // URL to PDF or server path
  name: string;
  race: string;
  icon: string;               // Can be a URL or server path
  baseStats: BaseStats;
  classes: CharacterClass[];
  ac: number;
  lastUpdated?: Date;
}
