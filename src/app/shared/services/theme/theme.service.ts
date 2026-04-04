import { Injectable, Renderer2, RendererFactory2 } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type Theme =
  | 'modern-dark'
  | 'classic-parchment'
  | 'eldritch-void'
  | 'tone-heroic'
  | 'tone-grimdark'
  | 'tone-feywild'
  | 'tone-archivist'
  | 'tone-cyber'
  | 'tone-forest'
  | 'tone-creepy'
  | 'tone-infernal'
  | 'tone-astral'
  | 'tone-underdark'
  | 'tone-royal';

export interface ThemeOption {
  id: Theme;
  name: string;
  primary: string;   // Primary brand color
  secondary: string; // Secondary/Background color
}

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private renderer: Renderer2;
  private currentTheme = new BehaviorSubject<Theme>('eldritch-void');
  currentTheme$ = this.currentTheme.asObservable();
  private _savedTheme: Theme = 'eldritch-void';

  public readonly availableThemes: ThemeOption[] = [
    { id: 'modern-dark', name: 'Modern Dark', primary: '#7289da', secondary: '#1e1f22' },
    { id: 'classic-parchment', name: 'Classic Parchment', primary: '#5d4037', secondary: '#f4e4bc' },
    { id: 'eldritch-void', name: 'Eldritch Void', primary: '#bf5af2', secondary: '#1c0a2e' },
    { id: 'tone-heroic', name: 'Heroic Paladin', primary: '#ffd700', secondary: '#fdfcf0' },
    { id: 'tone-grimdark', name: 'Iron Dungeon', primary: '#ff0000', secondary: '#1a1a1a' },
    { id: 'tone-feywild', name: 'Feywild Bloom', primary: '#ff00ff', secondary: '#1a0525' },
    { id: 'tone-archivist', name: 'Archivist Ink', primary: '#2c3e50', secondary: '#f4f1ea' },
    { id: 'tone-cyber', name: 'Cyber Neon', primary: '#00ffff', secondary: '#0a001a' },
    { id: 'tone-forest', name: 'Deep Forest', primary: '#00ff88', secondary: '#0a2e1f' },
    { id: 'tone-creepy', name: 'Abyssal Whisper', primary: '#4a5d4e', secondary: '#0f0f0f' },
    { id: 'tone-infernal', name: 'Infernal Forge', primary: '#ff4500', secondary: '#260a0a' },
    { id: 'tone-astral', name: 'Astral Sea', primary: '#448aff', secondary: '#0d1b35' },
    { id: 'tone-underdark', name: 'Underdark Gloom', primary: '#9d00ff', secondary: '#140024' },
    { id: 'tone-royal', name: 'Royal Court', primary: '#ffd700', secondary: '#4a0404' }
  ];

  constructor(rendererFactory: RendererFactory2) {
    this.renderer = rendererFactory.createRenderer(null, null);

    const savedTheme = localStorage.getItem('app-theme') as Theme;
    if (savedTheme && this.isValidTheme(savedTheme)) {
      this._savedTheme = savedTheme;
    } else {
      this._savedTheme = 'modern-dark';
    }
    this.setTheme(this._savedTheme);
  }

  private isValidTheme(theme: string): theme is Theme {
    return this.availableThemes.some(t => t.id === theme);
  }

  setTheme(theme: Theme) {
    const previousTheme = this.currentTheme.value;
    this.renderer.removeClass(document.body, previousTheme);
    this.renderer.addClass(document.body, theme);
    this.currentTheme.next(theme);
    localStorage.setItem('app-theme', theme);
    this._savedTheme = theme;
  }

  applyTemporaryTheme(theme: Theme) {
    const previousTheme = this.currentTheme.value;
    this.renderer.removeClass(document.body, previousTheme);
    this.renderer.addClass(document.body, theme);
    this.currentTheme.next(theme);
  }

  revertToSavedTheme() {
    this.applyTemporaryTheme(this._savedTheme);
  }

  getTheme(): Theme {
    return this.currentTheme.value;
  }
}
