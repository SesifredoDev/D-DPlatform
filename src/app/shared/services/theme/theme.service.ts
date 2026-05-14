import { Injectable, Renderer2, RendererFactory2 } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { IServerTheme } from '../../models/server/server.model';

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

export const SERVER_THEME_FONT_OPTIONS: readonly ServerThemeFontOption[] = [
  {
    label: 'Inter / System',
    value: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  },
  {
    label: 'Roboto',
    value: 'Roboto, "Helvetica Neue", Arial, sans-serif'
  },
  {
    label: 'Segoe UI',
    value: '"Segoe UI", Arial, sans-serif'
  },
  {
    label: 'Georgia',
    value: 'Georgia, "Times New Roman", serif'
  },
  {
    label: 'Monospace',
    value: '"Roboto Mono", "Courier New", monospace'
  }
];

export const DEFAULT_SERVER_THEME: IServerTheme = {
  backgroundColor: '#121212',
  textColor: '#eef0f6',
  fontFamily: SERVER_THEME_FONT_OPTIONS[0].value,
  backgroundImage: null,
  backgroundImageBlur: false
};

export const DEFAULT_THEME_COLORS: ThemeColors = {
  primary: '#7289da',
  background: DEFAULT_SERVER_THEME.backgroundColor,
  textColor: DEFAULT_SERVER_THEME.textColor,
  fontFamily: DEFAULT_SERVER_THEME.fontFamily,
  backgroundImage: DEFAULT_SERVER_THEME.backgroundImage,
  backgroundImageBlur: DEFAULT_SERVER_THEME.backgroundImageBlur
};

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function normalizeHexColor(value: unknown, fallback: string): string {
  const color = String(value ?? '').trim();
  return HEX_COLOR_PATTERN.test(color) ? color : fallback;
}

export function normalizeServerTheme(theme: Partial<IServerTheme> | null | undefined): IServerTheme {
  const fontFamily = String(theme?.fontFamily ?? '').trim();
  const knownFont = SERVER_THEME_FONT_OPTIONS.some(option => option.value === fontFamily)
    ? fontFamily
    : DEFAULT_SERVER_THEME.fontFamily;

  return {
    backgroundColor: normalizeHexColor(theme?.backgroundColor, DEFAULT_SERVER_THEME.backgroundColor),
    textColor: normalizeHexColor(theme?.textColor, DEFAULT_SERVER_THEME.textColor),
    fontFamily: knownFont,
    backgroundImage: normalizeThemeBackgroundImage(theme?.backgroundImage),
    backgroundImageBlur: theme?.backgroundImageBlur === true,
    backgroundImageKey: normalizeThemeBackgroundImage(theme?.backgroundImageKey)
  };
}

function normalizeThemeBackgroundImage(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const image = value.trim();
  return image.length ? image : null;
}

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private renderer: Renderer2;
  private _savedColors: ThemeColors = { ...DEFAULT_THEME_COLORS };

  private _colors = new BehaviorSubject<ThemeColors>(this._savedColors);
  colors$ = this._colors.asObservable();

  private _pinnedThemes = new BehaviorSubject<PinnedTheme[]>([]);
  pinnedThemes$ = this._pinnedThemes.asObservable();

  constructor(rendererFactory: RendererFactory2) {
    this.renderer = rendererFactory.createRenderer(null, null);
    this.loadPinnedThemes();
    // Always start with factory defaults on refresh/load
    this.applyTheme(DEFAULT_THEME_COLORS, true);
  }

  applyTheme(colors: ThemeColors, save: boolean = false) {
    const normalizedColors = this.normalizeThemeColors(colors);

    if (save) {
      this._savedColors = { ...normalizedColors };
    }

    this._colors.next(normalizedColors);

    const root = document.documentElement;
    root.style.setProperty('--primary', normalizedColors.primary);
    root.style.setProperty('--background', normalizedColors.background);
    root.style.setProperty('--server-theme-background', normalizedColors.background);
    root.style.setProperty('--server-theme-text', normalizedColors.textColor ?? DEFAULT_SERVER_THEME.textColor);
    root.style.setProperty('--server-theme-font-family', normalizedColors.fontFamily ?? DEFAULT_SERVER_THEME.fontFamily);
    root.style.setProperty('--server-theme-background-image', this.toCssImageValue(normalizedColors.backgroundImage ?? null));
    root.style.setProperty(
      '--server-theme-background-image-blur',
      normalizedColors.backgroundImage && normalizedColors.backgroundImageBlur ? '18px' : '0px'
    );
    root.style.setProperty(
      '--server-theme-background-image-scale',
      normalizedColors.backgroundImage && normalizedColors.backgroundImageBlur ? 'scale(1.06)' : 'scale(1)'
    );
    root.style.setProperty(
      '--server-theme-background-overlay',
      normalizedColors.backgroundImage ? 'rgba(0, 0, 0, 0.42)' : 'transparent'
    );
    root.style.setProperty('--font-family-main', normalizedColors.fontFamily ?? DEFAULT_SERVER_THEME.fontFamily);

    const primaryRgb = this.hexToRgb(normalizedColors.primary);

    const surface = this.adjustBrightness(normalizedColors.background, 15);
    root.style.setProperty('--surface', surface);
    root.style.setProperty('--outline', `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.25)`);
    root.style.setProperty('--primary-glow', `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.4)`);

    root.style.setProperty('--on-background', normalizedColors.textColor ?? DEFAULT_SERVER_THEME.textColor);
    root.style.setProperty('--accent', normalizedColors.primary);

    document.body.style.backgroundColor = normalizedColors.background;
    document.body.style.color = normalizedColors.textColor ?? DEFAULT_SERVER_THEME.textColor;
    document.body.style.fontFamily = normalizedColors.fontFamily ?? DEFAULT_SERVER_THEME.fontFamily;
  }

  applyServerTheme(theme: Partial<IServerTheme> | null | undefined) {
    const normalizedTheme = normalizeServerTheme(theme);
    this.applyTheme({
      ...this._savedColors,
      background: normalizedTheme.backgroundColor,
      textColor: normalizedTheme.textColor,
      fontFamily: normalizedTheme.fontFamily,
      backgroundImage: normalizedTheme.backgroundImage,
      backgroundImageBlur: normalizedTheme.backgroundImageBlur
    }, true);
  }

  revertToSaved() {
    this.applyTheme(this._savedColors, false);
  }

  resetToDefault() {
    this.applyTheme(DEFAULT_THEME_COLORS, true);
  }

  // --- PINNED THEMES LOGIC ---

  private loadPinnedThemes() {
    const saved = localStorage.getItem('app-pinned-themes');
    if (saved) {
      try {
        this._pinnedThemes.next(JSON.parse(saved));
      } catch (e) {
        this._pinnedThemes.next([]);
      }
    }
  }

  pinTheme(name: string, colors: ThemeColors) {
    const current = this._pinnedThemes.value;
    const newTheme: PinnedTheme = {
      id: Date.now().toString(),
      name,
      colors: this.normalizeThemeColors(colors)
    };
    const updated = [...current, newTheme];
    this._pinnedThemes.next(updated);
    localStorage.setItem('app-pinned-themes', JSON.stringify(updated));
  }

  removePinnedTheme(id: string) {
    const updated = this._pinnedThemes.value.filter(t => t.id !== id);
    this._pinnedThemes.next(updated);
    localStorage.setItem('app-pinned-themes', JSON.stringify(updated));
  }

  private hexToRgb(hex: string): { r: number, g: number, b: number } {
    let r = 0, g = 0, b = 0;
    const cleanHex = hex.startsWith('#') ? hex.substring(1) : hex;
    if (cleanHex.length === 3) {
      r = parseInt(cleanHex[0] + cleanHex[0], 16);
      g = parseInt(cleanHex[1] + cleanHex[1], 16);
      b = parseInt(cleanHex[2] + cleanHex[2], 16);
    } else if (cleanHex.length === 6) {
      r = parseInt(cleanHex.substring(0, 2), 16);
      g = parseInt(cleanHex.substring(2, 4), 16);
      b = parseInt(cleanHex.substring(4, 6), 16);
    }
    return { r, g, b };
  }

  private adjustBrightness(hex: string, percent: number): string {
    const rgb = this.hexToRgb(hex);
    const r = Math.min(255, Math.max(0, rgb.r + percent));
    const g = Math.min(255, Math.max(0, rgb.g + percent));
    const b = Math.min(255, Math.max(0, rgb.b + percent));
    return `rgb(${r}, ${g}, ${b})`;
  }

  getColors(): ThemeColors {
    return this._colors.value;
  }

  getFactoryColors(): ThemeColors {
    return { ...DEFAULT_THEME_COLORS };
  }

  private normalizeThemeColors(colors: ThemeColors): ThemeColors {
    const background = normalizeHexColor(colors?.background, DEFAULT_THEME_COLORS.background);
    const fallbackTextColor = this.getReadableTextColor(background);
    const textColor = normalizeHexColor(colors?.textColor, fallbackTextColor);
    const fontFamily = normalizeServerTheme({
      backgroundColor: background,
      textColor,
      fontFamily: colors?.fontFamily,
      backgroundImage: colors?.backgroundImage,
      backgroundImageBlur: colors?.backgroundImageBlur
    }).fontFamily;

    return {
      primary: normalizeHexColor(colors?.primary, DEFAULT_THEME_COLORS.primary),
      background,
      textColor,
      fontFamily,
      backgroundImage: normalizeThemeBackgroundImage(colors?.backgroundImage),
      backgroundImageBlur: colors?.backgroundImageBlur === true
    };
  }

  private getReadableTextColor(background: string): string {
    const bgRgb = this.hexToRgb(background);
    const luminance = (0.299 * bgRgb.r + 0.587 * bgRgb.g + 0.114 * bgRgb.b) / 255;
    return luminance > 0.5 ? '#121212' : '#eef0f6';
  }

  private toCssImageValue(imageUrl: string | null): string {
    if (!imageUrl) {
      return 'none';
    }

    return `url("${imageUrl.replace(/"/g, '\\"')}")`;
  }
}
