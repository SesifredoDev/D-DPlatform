import { Injectable, Renderer2, RendererFactory2 } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface ThemeColors {
  primary: string;
  background: string;
}

export interface PinnedTheme {
  id: string;
  name: string;
  colors: ThemeColors;
}

export const DEFAULT_THEME_COLORS: ThemeColors = {
  primary: '#7289da',
  background: '#121212'
};

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
    if (save) {
      this._savedColors = { ...colors };
    }

    this._colors.next(colors);

    const root = document.documentElement;
    root.style.setProperty('--primary', colors.primary);
    root.style.setProperty('--background', colors.background);

    const primaryRgb = this.hexToRgb(colors.primary);
    const bgRgb = this.hexToRgb(colors.background);

    const surface = this.adjustBrightness(colors.background, 15);
    root.style.setProperty('--surface', surface);
    root.style.setProperty('--outline', `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.25)`);
    root.style.setProperty('--primary-glow', `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.4)`);

    const luminance = (0.299 * bgRgb.r + 0.587 * bgRgb.g + 0.114 * bgRgb.b) / 255;
    const onBackground = luminance > 0.5 ? '#121212' : '#eef0f6';
    root.style.setProperty('--on-background', onBackground);
    root.style.setProperty('--accent', colors.primary);

    document.body.style.backgroundColor = colors.background;
    document.body.style.color = onBackground;
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
      colors: { ...colors }
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
}
