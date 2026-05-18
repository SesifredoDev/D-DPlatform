export interface ThemeColors {
  primary: string;
  background: string;
  textColor?: string;
  fontFamily?: string;
  backgroundImage?: string | null;
  backgroundImageBlur?: boolean;
}

export interface ServerThemeFontOption {
  label: string;
  value: string;
}

export interface PinnedTheme {
  id: string;
  name: string;
  colors: ThemeColors;
}
