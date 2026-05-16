import { Injectable, Renderer2, RendererFactory2 } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { IServerTheme } from '../../models/server/server.model';
import { SharedWindowStateService } from '../window-state/shared-window-state.service';

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
  private static readonly colorsStateKey = 'theme:colors';
  private static readonly pinnedThemesStateKey = 'theme:pinned';
  private static readonly themeTransitionClass = 'theme-transitioning';
  private static readonly themeTransitionDurationMs = 1000;

  private renderer: Renderer2;
  private _savedColors: ThemeColors = { ...DEFAULT_THEME_COLORS };
  private _serverDefaultColors: ThemeColors = { ...DEFAULT_THEME_COLORS };
  private themeTransitionTimeout: ReturnType<typeof setTimeout> | null = null;
  private themeTransitionFrame: number | null = null;
  private themeInitialized = false;

  private _colors = new BehaviorSubject<ThemeColors>(this._savedColors);
  colors$ = this._colors.asObservable();

  private _pinnedThemes = new BehaviorSubject<PinnedTheme[]>([]);
  pinnedThemes$ = this._pinnedThemes.asObservable();

  constructor(
    rendererFactory: RendererFactory2,
    private sharedWindowState: SharedWindowStateService
  ) {
    this.renderer = rendererFactory.createRenderer(null, null);
    const sharedColors = this.sharedWindowState.getSnapshot<ThemeColors>(ThemeService.colorsStateKey, null);
    if (sharedColors) {
      this._savedColors = this.normalizeThemeColors(sharedColors);
    }

    this.loadPinnedThemes();
    this.applyTheme(sharedColors ?? DEFAULT_THEME_COLORS, true, false);
    this.setupSharedThemeState();
  }

  applyTheme(colors: ThemeColors, save: boolean = false, broadcast: boolean = true) {
    const previousColors = this._colors.value;
    const normalizedColors = this.normalizeThemeColors(colors);
    const shouldTransition = this.themeInitialized && !this.isSameState(previousColors, normalizedColors);
    const shouldCrossfadeBackgroundImage = shouldTransition &&
      previousColors.backgroundImage !== normalizedColors.backgroundImage;

    if (shouldTransition) {
      this.startThemeTransition(shouldCrossfadeBackgroundImage ? previousColors : null);
    }

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
    root.style.setProperty('--server-theme-background-image-blur', this.getBackgroundImageBlur(normalizedColors));
    root.style.setProperty('--server-theme-background-image-scale', this.getBackgroundImageScale(normalizedColors));
    root.style.setProperty('--server-theme-background-overlay', this.getBackgroundImageOverlay(normalizedColors));
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

    if (broadcast) {
      this.sharedWindowState.publish(ThemeService.colorsStateKey, normalizedColors);
    }

    if (shouldCrossfadeBackgroundImage) {
      this.fadeInBackgroundImage();
    }

    this.themeInitialized = true;
  }

  applyServerTheme(theme: Partial<IServerTheme> | null | undefined) {
    const normalizedTheme = normalizeServerTheme(theme);

    this._serverDefaultColors = this.normalizeThemeColors({
      ...this._serverDefaultColors,
      primary: this._savedColors.primary,
      background: normalizedTheme.backgroundColor,
      textColor: normalizedTheme.textColor,
      fontFamily: normalizedTheme.fontFamily,
      backgroundImage: normalizedTheme.backgroundImage,
      backgroundImageBlur: normalizedTheme.backgroundImageBlur
    });

    this.applyTheme(this._serverDefaultColors, true);
  }

  revertToSaved() {
    this.applyTheme(this._savedColors, false);
  }

  resetToDefault() {
    this.applyTheme(this._serverDefaultColors, true);
  }

  // --- PINNED THEMES LOGIC ---

  private loadPinnedThemes() {
    const sharedPinnedThemes = this.sharedWindowState.getSnapshot<PinnedTheme[]>(ThemeService.pinnedThemesStateKey, null);
    if (sharedPinnedThemes) {
      this._pinnedThemes.next(sharedPinnedThemes);
      return;
    }

    const saved = localStorage.getItem('app-pinned-themes');
    if (saved) {
      try {
        const pinnedThemes = JSON.parse(saved);
        this._pinnedThemes.next(pinnedThemes);
        this.sharedWindowState.publish(ThemeService.pinnedThemesStateKey, pinnedThemes);
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
    this.sharedWindowState.publish(ThemeService.pinnedThemesStateKey, updated);
  }

  removePinnedTheme(id: string) {
    const updated = this._pinnedThemes.value.filter(t => t.id !== id);
    this._pinnedThemes.next(updated);
    localStorage.setItem('app-pinned-themes', JSON.stringify(updated));
    this.sharedWindowState.publish(ThemeService.pinnedThemesStateKey, updated);
  }

  private setupSharedThemeState() {
    this.sharedWindowState.observe<ThemeColors>(ThemeService.colorsStateKey, this._savedColors)
      .subscribe(colors => {
        if (colors && !this.isSameState(this._colors.value, colors)) {
          this.applyTheme(colors, true, false);
        }
      });

    this.sharedWindowState.observe<PinnedTheme[]>(ThemeService.pinnedThemesStateKey, this._pinnedThemes.value)
      .subscribe(themes => {
        const nextThemes = themes ?? [];
        if (this.isSameState(this._pinnedThemes.value, nextThemes)) {
          return;
        }

        this._pinnedThemes.next(nextThemes);
        localStorage.setItem('app-pinned-themes', JSON.stringify(nextThemes));
      });
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

  getServerDefaultColors(): ThemeColors {
    return { ...this._serverDefaultColors };
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

  private startThemeTransition(previousBackgroundColors: ThemeColors | null): void {
    const root = document.documentElement;

    if (previousBackgroundColors) {
      this.prepareBackgroundImageCrossfade(root, previousBackgroundColors);
    }

    this.renderer.addClass(root, ThemeService.themeTransitionClass);

    if (this.themeTransitionTimeout) {
      clearTimeout(this.themeTransitionTimeout);
    }

    this.themeTransitionTimeout = setTimeout(() => {
      this.renderer.removeClass(root, ThemeService.themeTransitionClass);
      this.resetBackgroundImageCrossfade(root);
      this.themeTransitionTimeout = null;
    }, ThemeService.themeTransitionDurationMs);
  }

  private prepareBackgroundImageCrossfade(root: HTMLElement, previousColors: ThemeColors): void {
    if (this.themeTransitionFrame !== null) {
      cancelAnimationFrame(this.themeTransitionFrame);
      this.themeTransitionFrame = null;
    }

    root.style.setProperty(
      '--server-theme-background-image-previous',
      this.toCssImageValue(previousColors.backgroundImage ?? null)
    );
    root.style.setProperty('--server-theme-background-image-previous-blur', this.getBackgroundImageBlur(previousColors));
    root.style.setProperty('--server-theme-background-image-previous-scale', this.getBackgroundImageScale(previousColors));
    root.style.setProperty('--server-theme-background-image-previous-overlay', this.getBackgroundImageOverlay(previousColors));
    root.style.setProperty('--server-theme-background-image-previous-opacity', previousColors.backgroundImage ? '1' : '0');
    root.style.setProperty('--server-theme-background-image-opacity', '0');
  }

  private fadeInBackgroundImage(): void {
    const root = document.documentElement;

    this.themeTransitionFrame = requestAnimationFrame(() => {
      this.themeTransitionFrame = requestAnimationFrame(() => {
        root.style.setProperty('--server-theme-background-image-opacity', '1');
        root.style.setProperty('--server-theme-background-image-previous-opacity', '0');
        this.themeTransitionFrame = null;
      });
    });
  }

  private resetBackgroundImageCrossfade(root: HTMLElement): void {
    if (this.themeTransitionFrame !== null) {
      cancelAnimationFrame(this.themeTransitionFrame);
      this.themeTransitionFrame = null;
    }

    root.style.setProperty('--server-theme-background-image-opacity', '1');
    root.style.setProperty('--server-theme-background-image-previous', 'none');
    root.style.setProperty('--server-theme-background-image-previous-opacity', '0');
    root.style.setProperty('--server-theme-background-image-previous-blur', '0px');
    root.style.setProperty('--server-theme-background-image-previous-scale', 'scale(1)');
    root.style.setProperty('--server-theme-background-image-previous-overlay', 'transparent');
  }

  private getBackgroundImageBlur(colors: ThemeColors): string {
    return colors.backgroundImage && colors.backgroundImageBlur ? '18px' : '0px';
  }

  private getBackgroundImageScale(colors: ThemeColors): string {
    return colors.backgroundImage && colors.backgroundImageBlur ? 'scale(1.06)' : 'scale(1)';
  }

  private getBackgroundImageOverlay(colors: ThemeColors): string {
    return colors.backgroundImage ? 'rgba(0, 0, 0, 0.42)' : 'transparent';
  }

  private isSameState(first: unknown, second: unknown): boolean {
    return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
  }
}
