import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/prose/view';
import { editorViewTimerCtx, nodeViewCtx, SchemaReady } from '@milkdown/core';
import { createTimer, type Ctx } from '@milkdown/ctx';
import {
  type DndAbilityKey,
  type DndStatsheet,
  type DndStatsheetEntry,
  type DndStatsheetSection,
  ObsidianVaultService,
} from '../../services/ObsidianVault/obsidian-vault-service';

type GetPos = () => number | undefined;

const ABILITIES: DndAbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export function dndStatsheetNodeViewPlugin(vaultService: ObsidianVaultService) {
  const timer = createTimer('DndStatsheetNodeViewReady');
  let fallback: NodeViewConstructor | undefined;

  return (ctx: Ctx) => {
    ctx.record(timer);
    ctx.update(editorViewTimerCtx, timers => timers.concat(timer));

    return async () => {
      await ctx.wait(SchemaReady);
      await new Promise(resolve => setTimeout(resolve, 0));

      ctx.update(nodeViewCtx, views => {
        fallback = [...views].reverse().find(([nodeId]) => nodeId === 'code_block')?.[1];
        const nextViews = views.filter(([nodeId]) => nodeId !== 'code_block');
        nextViews.push(['code_block', createDndStatsheetNodeView(vaultService, fallback)]);
        return nextViews;
      });

      ctx.done(timer);

      return () => {
        ctx.update(nodeViewCtx, views => {
          const nextViews = views.filter(([nodeId]) => nodeId !== 'code_block');
          if (fallback) nextViews.push(['code_block', fallback]);
          return nextViews;
        });
        ctx.update(editorViewTimerCtx, timers => timers.filter(existingTimer => existingTimer !== timer));
        ctx.clearTimer(timer);
      };
    };
  };
}

export function createDndStatsheetNodeView(
  vaultService: ObsidianVaultService,
  fallback?: NodeViewConstructor
): NodeViewConstructor {
  return (node, view, getPos, decorations, innerDecorations) => {
    const language = String(node.attrs['language'] || '');
    if (vaultService.isDndStatsheetLanguage(language)) {
      return new DndStatsheetNodeView(node, view, getPos as GetPos, vaultService);
    }

    return fallback
      ? fallback(node, view, getPos, decorations, innerDecorations)
      : new PlainCodeBlockNodeView(node);
  };
}

class DndStatsheetNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseMirrorNode;
  private statsheet: DndStatsheet;
  private pinnedSection?: DndStatsheetSection;

  constructor(
    node: ProseMirrorNode,
    private view: EditorView,
    private getPos: GetPos,
    private vaultService: ObsidianVaultService
  ) {
    this.node = node;
    this.statsheet = this.parseNode(node);
    this.pinnedSection = this.resolvePinnedSection();
    this.dom = document.createElement('article');
    this.dom.className = 'dnd-statsheet dnd-statsheet--builder';
    this.dom.contentEditable = 'false';
    this.dom.setAttribute('aria-label', 'Editable Dungeons and Dragons 5e statblock');
    this.dom.addEventListener('input', this.onInput);
    this.dom.addEventListener('click', this.onClick);
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    const language = String(node.attrs['language'] || '');
    if (node.type !== this.node.type || !this.vaultService.isDndStatsheetLanguage(language)) {
      return false;
    }

    this.node = node;
    if (!this.isFocusedInside()) {
      this.statsheet = this.parseNode(node);
      this.pinnedSection = this.resolvePinnedSection();
      this.render();
    }
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof HTMLElement && !!event.target.closest('input, textarea, button');
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.removeEventListener('input', this.onInput);
    this.dom.removeEventListener('click', this.onClick);
  }

  private parseNode(node: ProseMirrorNode): DndStatsheet {
    return this.vaultService.parseDndStatsheetSource(node.textContent) || this.vaultService.createDndStatsheet();
  }

  private render(): void {
    this.dom.replaceChildren(this.createGrid());
    this.resizeTextareas();
  }

  private createGrid(): HTMLElement {
    const grid = this.el('div', 'dnd-statsheet__grid');
    const left = this.el('div', 'dnd-statsheet__left');
    const right = this.el('div', 'dnd-statsheet__right');
    const pinnedSection = this.getPinnedSection();
    const pinnedSectionIndex = this.statsheet.sections.indexOf(pinnedSection);

    left.append(
      this.createHeader(),
      this.createRule(),
      this.createBasics(),
      this.createRule(),
      this.createAbilities(),
      this.createRule(),
      this.createAttributes(),
      this.createRule(),
      this.createSection(pinnedSectionIndex, pinnedSection, true)
    );

    right.append(...this.createRightSections(pinnedSection));
    grid.append(left, right);
    return grid;
  }

  private createHeader(): HTMLElement {
    const header = this.el('header', 'dnd-statsheet__header');
    header.append(
      this.createFieldInput('name', this.statsheet.name, 'Creature name', 'dnd-statsheet__name'),
      this.createFieldInput('meta', this.statsheet.meta, 'Tiny Dragon, Neutral Good', 'dnd-statsheet__meta')
    );
    return header;
  }

  private createBasics(): HTMLElement {
    const list = this.el('dl', 'dnd-statsheet__basics');
    [
      ['Armor Class', 'armorClass', this.statsheet.armorClass],
      ['Hit Points', 'hitPoints', this.statsheet.hitPoints],
      ['Speed', 'speed', this.statsheet.speed],
    ].forEach(([label, field, value]) => {
      const row = this.el('div');
      const dd = this.el('dd');
      dd.append(this.createFieldInput(field, value, label));
      row.append(this.el('dt', '', label), dd);
      list.append(row);
    });
    return list;
  }

  private createAbilities(): HTMLElement {
    const abilities = this.el('div', 'dnd-statsheet__abilities');
    ABILITIES.forEach(ability => {
      const score = this.statsheet.abilities[ability] || '';
      const item = this.el('label');
      const input = document.createElement('input');
      input.value = score;
      input.inputMode = 'numeric';
      input.setAttribute('aria-label', `${ability.toUpperCase()} score`);
      input.dataset['ability'] = ability;
      item.append(this.el('span', '', ability.toUpperCase()), input, this.el('small', '', this.formatModifier(score)));
      abilities.append(item);
    });
    return abilities;
  }

  private createAttributes(): HTMLElement {
    const wrapper = this.el('section', 'dnd-statsheet__attribute-section');
    const list = this.el('dl', 'dnd-statsheet__attributes');

    this.statsheet.attributes.forEach((attribute, index) => {
      const row = this.el(
        'div',
        `dnd-statsheet__attribute-row${this.isCompactAttribute(attribute.name) ? '' : ' dnd-statsheet__attribute-row--wide'}`
      );
      const name = this.createIndexedInput(attribute.name, 'Field', 'attributeIndex', index, 'attributeField', 'name');
      const value = this.createIndexedInput(attribute.text, 'Value', 'attributeIndex', index, 'attributeField', 'text');
      const term = this.el('dt');
      const definition = this.el('dd');
      const remove = this.createIconButton('remove-attribute', 'Remove field');
      remove.dataset['attributeIndex'] = String(index);
      term.append(name);
      definition.append(value);
      row.append(term, definition, remove);
      list.append(row);
    });

    wrapper.append(list, this.createTextButton('add-attribute', 'Add field'));
    return wrapper;
  }

  private createRightSections(pinnedSection: DndStatsheetSection): HTMLElement[] {
    const sections = this.statsheet.sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section !== pinnedSection);

    return [
      ...sections.map(({ section, index }) => this.createSection(index, section)),
      this.createTextButton('add-section', 'Add section'),
    ];
  }

  private createSection(sectionIndex: number, section: DndStatsheetSection, isPinned = false): HTMLElement {
    const sectionEl = this.el('section', `dnd-statsheet__section${isPinned ? ' dnd-statsheet__section--pinned' : ''}`);
    const heading = this.el('div', 'dnd-statsheet__section-heading');
    const titleInput = document.createElement('input');
    titleInput.value = section.title;
    titleInput.placeholder = 'Section';
    titleInput.setAttribute('aria-label', 'Section title');
    titleInput.dataset['sectionIndex'] = String(sectionIndex);
    titleInput.dataset['sectionField'] = 'title';
    heading.append(titleInput);

    if (!isPinned) {
      const remove = this.createIconButton('remove-section', 'Remove section');
      remove.dataset['sectionIndex'] = String(sectionIndex);
      heading.append(remove);
    }

    sectionEl.append(heading);
    section.entries.forEach((entry, entryIndex) => {
      sectionEl.append(this.createEntry(sectionIndex, entry, entryIndex));
    });

    const add = this.createTextButton('add-entry', `Add ${section.title || 'entry'}`);
    add.dataset['sectionIndex'] = String(sectionIndex);
    sectionEl.append(add);
    return sectionEl;
  }

  private createEntry(sectionIndex: number, entry: DndStatsheetEntry, entryIndex: number): HTMLElement {
    const row = this.el('div', 'dnd-statsheet__entry');
    const text = this.el('div', 'dnd-statsheet__entry-text');
    const name = this.createIndexedInput(entry.name, 'Name', 'entryIndex', entryIndex, 'entryField', 'name');
    name.dataset['sectionIndex'] = String(sectionIndex);

    const textarea = document.createElement('textarea');
    textarea.value = entry.text;
    textarea.placeholder = 'Description';
    textarea.rows = 1;
    textarea.setAttribute('aria-label', `${entry.name || 'Entry'} text`);
    textarea.dataset['sectionIndex'] = String(sectionIndex);
    textarea.dataset['entryIndex'] = String(entryIndex);
    textarea.dataset['entryField'] = 'text';

    const remove = this.createIconButton('remove-entry', 'Remove entry');
    remove.dataset['sectionIndex'] = String(sectionIndex);
    remove.dataset['entryIndex'] = String(entryIndex);
    text.append(name, textarea);
    row.append(text, remove);
    return row;
  }

  private createFieldInput(field: string, value: string, label: string, className = ''): HTMLInputElement {
    const input = document.createElement('input');
    input.className = className;
    input.value = value || '';
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    input.dataset['sheetField'] = field;
    return input;
  }

  private createIndexedInput(
    value: string,
    placeholder: string,
    indexKey: string,
    index: number,
    fieldKey: string,
    field: string
  ): HTMLInputElement {
    const input = document.createElement('input');
    input.value = value || '';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.dataset[indexKey] = String(index);
    input.dataset[fieldKey] = field;
    return input;
  }

  private createTextButton(action: string, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dnd-statsheet__add-button';
    button.dataset['action'] = action;
    button.textContent = label;
    return button;
  }

  private createIconButton(action: string, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dnd-statsheet__icon-button';
    button.dataset['action'] = action;
    button.setAttribute('aria-label', label);
    button.append(this.el('span', 'material-icons', 'close'));
    return button;
  }

  private createRule(): HTMLElement {
    return this.el('div', 'dnd-statsheet__rule');
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = ''
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  private onInput = (event: Event): void => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;

    this.applyInputValue(target);
    if (target instanceof HTMLTextAreaElement) this.resizeTextarea(target);
    if (target.dataset['ability']) {
      const modifier = target.parentElement?.querySelector('small');
      if (modifier) modifier.textContent = this.formatModifier(target.value);
    }
    this.commit();
  };

  private onClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
    if (!button) return;

    event.preventDefault();
    const action = button.dataset['action'];
    if (action === 'add-attribute') {
      this.statsheet.attributes.push({ name: 'New Field', text: '' });
    } else if (action === 'remove-attribute') {
      this.statsheet.attributes.splice(Number(button.dataset['attributeIndex']), 1);
    } else if (action === 'add-section') {
      this.statsheet.sections.push({ title: 'New Section', entries: [] });
    } else if (action === 'remove-section') {
      const index = Number(button.dataset['sectionIndex']);
      if (index >= 0) this.statsheet.sections.splice(index, 1);
    } else if (action === 'add-entry') {
      const section = this.getSectionByIndex(Number(button.dataset['sectionIndex']));
      section?.entries.push({ name: 'New Entry', text: '' });
    } else if (action === 'remove-entry') {
      const section = this.getSectionByIndex(Number(button.dataset['sectionIndex']));
      section?.entries.splice(Number(button.dataset['entryIndex']), 1);
    }

    this.commit();
    this.render();
  };

  private applyInputValue(target: HTMLInputElement | HTMLTextAreaElement): void {
    const field = target.dataset['sheetField'] as keyof Pick<
      DndStatsheet,
      'name' | 'meta' | 'armorClass' | 'hitPoints' | 'speed'
    > | undefined;
    if (field) {
      this.statsheet[field] = target.value;
      return;
    }

    const ability = target.dataset['ability'] as DndAbilityKey | undefined;
    if (ability) {
      this.statsheet.abilities[ability] = target.value;
      return;
    }

    if (target.dataset['attributeIndex'] !== undefined) {
      const attribute = this.statsheet.attributes[Number(target.dataset['attributeIndex'])];
      const attributeField = target.dataset['attributeField'] as keyof DndStatsheetEntry;
      if (attribute && attributeField) attribute[attributeField] = target.value;
      return;
    }

    const section = this.getSectionByIndex(Number(target.dataset['sectionIndex']));
    if (!section) return;

    if (target.dataset['sectionField'] === 'title') {
      section.title = target.value || 'Section';
      return;
    }

    const entry = section.entries[Number(target.dataset['entryIndex'])];
    const entryField = target.dataset['entryField'] as keyof DndStatsheetEntry;
    if (entry && entryField) entry[entryField] = target.value;
  }

  private commit(): void {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;

    const source = this.vaultService.serializeDndStatsheet(this.statsheet);
    const start = pos + 1;
    const end = pos + this.node.nodeSize - 1;
    const transaction = source
      ? this.view.state.tr.replaceWith(start, end, this.view.state.schema.text(source))
      : this.view.state.tr.delete(start, end);
    this.view.dispatch(transaction);
  }

  private findSection(title: string): DndStatsheetSection | null {
    const normalized = this.normalizeSectionTitle(title);
    return this.statsheet.sections.find(section => this.normalizeSectionTitle(section.title) === normalized) || null;
  }

  private getSectionByIndex(index: number): DndStatsheetSection | null {
    return Number.isInteger(index) && index >= 0 ? this.statsheet.sections[index] || null : null;
  }

  private getPinnedSection(): DndStatsheetSection {
    if (this.pinnedSection && this.statsheet.sections.includes(this.pinnedSection)) {
      return this.pinnedSection;
    }

    this.pinnedSection = this.resolvePinnedSection();
    return this.pinnedSection;
  }

  private resolvePinnedSection(): DndStatsheetSection {
    const traits = this.findSection('Traits');
    if (traits) return traits;

    if (this.statsheet.sections.length > 0) {
      return this.statsheet.sections[0];
    }

    const section = { title: 'Traits', entries: [] };
    this.statsheet.sections.push(section);
    return section;
  }

  private normalizeSectionTitle(title: string): string {
    return title.trim().toLowerCase().replace(/[\s_-]+/g, '_');
  }

  private isCompactAttribute(name: string): boolean {
    return ['challenge', 'proficiency_bonus', 'pb'].includes(this.normalizeSectionTitle(name));
  }

  private isFocusedInside(): boolean {
    const active = document.activeElement;
    return !!active && this.dom.contains(active);
  }

  private resizeTextareas(): void {
    this.dom.querySelectorAll('textarea').forEach(textarea => this.resizeTextarea(textarea as HTMLTextAreaElement));
  }

  private resizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  private formatModifier(value: string): string {
    const score = Number.parseInt(value, 10);
    if (!Number.isFinite(score)) return '';
    const modifier = Math.floor((score - 10) / 2);
    return modifier >= 0 ? `+${modifier}` : `${modifier}`;
  }
}

class PlainCodeBlockNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(node: ProseMirrorNode) {
    this.dom = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    this.dom.dataset['language'] = String(node.attrs['language'] || '');
    this.dom.append(this.contentDOM);
  }
}
