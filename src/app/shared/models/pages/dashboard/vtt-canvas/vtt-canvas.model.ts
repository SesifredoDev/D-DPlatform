export type HostTakeoverChoice = 'take-control' | 'player';

export type FxShapeTool = 'polygon' | 'square' | 'circle' | 'cone' | 'erase';

export type TokenConfigTab = 'main' | 'style';

export type ActiveTool =
  'select' | 'pointer' | 'draw' | 'delete' |
  'line' | 'radius' | 'cone' |
  'fx-polygon' | 'fx-square' | 'fx-circle' | 'fx-cone' | 'fx-erase' |
  'none';

export interface TokenEffect {
  id: string;
  name: string;
  color: string;
}

export interface TokenEditConfig {
  name: string;
  icon: string | null;
  iconFile: File | null;
  size: number;
  forceBorder: boolean;
  borderColor: string;
  color: string;
  notes: string;
  currentHealth: number | null;
  maxHealth: number | null;
  healthDelta: number;
  effects: TokenEffect[];
  newEffectName: string;
  newEffectColor: string;
}

export type TokenConfigPayload = Omit<TokenEditConfig, 'healthDelta' | 'newEffectName' | 'newEffectColor'>;
