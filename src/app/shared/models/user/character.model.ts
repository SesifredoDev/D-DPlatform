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
  subclassName?: string;
  level: number;
}

export interface ICharacter {
  _id?: string;
  ownerId: string;
  servers: string[];
  ddbId?: number | null;
  ddbUsername?: string | null;
  ddbPdfLink?: string | null;
  pdfLink?: string | null;
  name: string;
  race?: string;
  icon?: string | null;
  baseStats: BaseStats;
  classes: CharacterClass[];
  ac?: number;
}
