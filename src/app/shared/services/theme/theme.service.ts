import { Injectable, Renderer2, RendererFactory2 } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type Theme = 'modern-dark' | 'classic-parchment';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private renderer: Renderer2;
  private currentTheme = new BehaviorSubject<Theme>('classic-parchment');
  currentTheme$ = this.currentTheme.asObservable();

  constructor(rendererFactory: RendererFactory2) {
    this.renderer = rendererFactory.createRenderer(null, null);

    // Load initial theme from localStorage or default
    const savedTheme = localStorage.getItem('app-theme') as Theme;
    if (savedTheme) {
      this.setTheme(savedTheme);
    } else {
      this.setTheme('modern-dark');
    }
  }

  setTheme(theme: Theme) {
    const previousTheme = this.currentTheme.value;

    // Remove old theme class and add new one to body
    this.renderer.removeClass(document.body, previousTheme);
    this.renderer.addClass(document.body, theme);

    // Update state and persistence
    this.currentTheme.next(theme);
    localStorage.setItem('app-theme', theme);
  }

  toggleTheme() {
    const nextTheme = this.currentTheme.value === 'modern-dark' ? 'classic-parchment' : 'modern-dark';
    this.setTheme(nextTheme);
  }

  getTheme(): Theme {
    return this.currentTheme.value;
  }
}
