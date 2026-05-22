import { Component, Input, OnChanges, OnInit, SimpleChanges } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ICharacter } from '../../../shared/models/user/character.model';
import { CommonModule, KeyValuePipe } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { PdfViewerModule } from 'ng2-pdf-viewer';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FileService } from '../../../shared/services/file/file';
import { CharacterService } from '../../../shared/services/character/character';
import { firstValueFrom } from 'rxjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfFormKind = 'none' | 'acroform' | 'xfa' | 'widget';
type CharacterPdfKind = 'custom' | 'ddb';

interface PdfJsFieldWidget {
  id?: string;
  fieldName?: string;
  fieldType?: string;
  readOnly?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  combo?: boolean;
  multiSelect?: boolean;
  options?: unknown[];
}

interface PdfFieldSummary {
  total: number;
  editable: number;
  readOnly: number;
  kind: PdfFormKind;
}

interface PdfViewerState {
  kind: CharacterPdfKind;
  sourceUrl: string | null;
  viewerUrl: string | null;
  loadError: string | null;
  saveError: string | null;
  saveMessage: string | null;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;
  detectedFieldCount: number;
  editableFieldCount: number;
  readOnlyFieldCount: number;
  formKind: PdfFormKind;
  loadToken: number;
  pdfDocument: PDFDocumentProxy | null;
}

@Component({
  selector: 'app-character-viewer',
  templateUrl: './character-viewer.html',
  styleUrls: ['./character-viewer.scss'],
  standalone: true,
  imports: [
    CommonModule,
    KeyValuePipe,
    MatTabsModule,
    MatIconModule,
    MatTooltipModule,
    PdfViewerModule,
    MatButtonModule,
  ]
})
export class CharacterViewer implements OnInit, OnChanges {
  @Input() character!: ICharacter | undefined;

  zoom = 1.0;
  page = 1;
  ddbUrl: SafeResourceUrl = '';
  customPdf = this.createPdfViewerState('custom');
  ddbPdf = this.createPdfViewerState('ddb');

  private hasInitialized = false;

  constructor(
    private sanitizer: DomSanitizer,
    private fileService: FileService,
    private characterService: CharacterService,
  ) {}

  ngOnInit() {
    this.hasInitialized = true;
    this.loadCharacterAssets();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['character'] && this.hasInitialized) {
      this.loadCharacterAssets();
    }
  }

  isInteractivePdf(state: PdfViewerState): boolean {
    return state.detectedFieldCount > 0 || state.formKind === 'xfa';
  }

  canSavePdfEdits(state: PdfViewerState): boolean {
    return !!this.character?._id &&
      state.isDirty &&
      !!state.pdfDocument &&
      this.isInteractivePdf(state) &&
      !state.isLoading &&
      !state.isSaving;
  }

  pdfStatusLabel(state: PdfViewerState): string {
    if (state.isLoading) {
      return 'Checking PDF';
    }

    if (state.loadError) {
      return 'PDF unavailable';
    }

    if (state.formKind === 'xfa') {
      return 'XFA form detected';
    }

    if (state.editableFieldCount > 0) {
      return `${state.editableFieldCount} fillable fields`;
    }

    if (state.detectedFieldCount > 0) {
      return 'PDF form detected';
    }

    return 'Static PDF';
  }

  modifierValue(stat: number): number {
    return Math.floor((stat - 10) / 2);
  }

  modifier(stat: number): string {
    const mod = this.modifierValue(stat);
    return mod >= 0 ? `+${mod}` : `${mod}`;
  }

  reloadPdfForm(state: PdfViewerState) {
    this.loadPdfState(state, this.getPdfLinkForState(state.kind), true, false);
  }

  onPdfViewerLoaded(state: PdfViewerState, pdfDocument: PDFDocumentProxy) {
    state.pdfDocument = pdfDocument;
    void this.inspectPdfViewerDocument(state, pdfDocument, state.loadToken);
  }

  onPdfViewerError(state: PdfViewerState, error: unknown) {
    console.error('Failed to load PDF', error);
    state.loadError = 'Could not load PDF';
    state.isLoading = false;
  }

  onPdfViewerFormInput(state: PdfViewerState) {
    if (!this.isInteractivePdf(state)) {
      state.detectedFieldCount = 1;
      state.editableFieldCount = 1;
      state.formKind = 'widget';
    }

    state.isDirty = true;
    state.saveError = null;
    state.saveMessage = null;
  }

  async savePdfEdits(state: PdfViewerState) {
    if (!this.canSavePdfEdits(state) || !this.character?._id || !state.pdfDocument) {
      return;
    }

    state.isSaving = true;
    state.saveError = null;
    state.saveMessage = null;

    try {
      const editedBytes = await state.pdfDocument.saveDocument();
      const editedFile = new File(
        [this.toArrayBuffer(editedBytes)],
        this.getEditedPdfFileName(state.kind),
        { type: 'application/pdf' }
      );
      const assets = state.kind === 'ddb'
        ? { ddbPdf: editedFile }
        : { pdf: editedFile };
      const updatedCharacter = await firstValueFrom(
        this.characterService.updateCharacter(this.character._id, {}, assets)
      ) as ICharacter;

      this.character = updatedCharacter;
      if (this.characterService.activeCharacter.value?._id === updatedCharacter._id) {
        this.characterService.setActiveCharacter(updatedCharacter);
      }

      state.saveMessage = 'Saved';
      state.isDirty = false;
      this.loadPdfState(state, this.getPdfLinkForState(state.kind), true, true);
      this.refreshOtherPdfState(state.kind);
    } catch (error) {
      console.error('Failed to save interactive PDF', error);
      state.saveError = 'Could not save PDF edits';
    } finally {
      state.isSaving = false;
    }
  }

  private createPdfViewerState(kind: CharacterPdfKind): PdfViewerState {
    return {
      kind,
      sourceUrl: null,
      viewerUrl: null,
      loadError: null,
      saveError: null,
      saveMessage: null,
      isLoading: false,
      isSaving: false,
      isDirty: false,
      detectedFieldCount: 0,
      editableFieldCount: 0,
      readOnlyFieldCount: 0,
      formKind: 'none',
      loadToken: 0,
      pdfDocument: null,
    };
  }

  private loadCharacterAssets() {
    if (!this.character) {
      this.ddbUrl = '';
      this.loadPdfState(this.customPdf, null);
      this.loadPdfState(this.ddbPdf, null);
      return;
    }

    this.ddbUrl = this.character.ddbId
      ? this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.dndbeyond.com/characters/${this.character.ddbId}`
      )
      : '';

    this.loadPdfState(this.customPdf, this.getCustomPdfLink());
    this.loadPdfState(this.ddbPdf, this.character.ddbPdfLink ?? null);
  }

  private loadPdfState(
    state: PdfViewerState,
    sourceLink: string | null | undefined,
    forcePdfRefresh = false,
    preserveSaveMessage = false
  ) {
    state.loadToken++;
    this.resetPdfState(state, preserveSaveMessage);

    state.sourceUrl = sourceLink
      ? this.fileService.resolveFileUrl(sourceLink)
      : null;
    state.viewerUrl = state.sourceUrl
      ? this.withCacheBust(state.sourceUrl, forcePdfRefresh)
      : null;
    state.isLoading = !!state.viewerUrl;
  }

  private resetPdfState(state: PdfViewerState, preserveSaveMessage = false) {
    state.loadError = null;
    state.saveError = null;
    if (!preserveSaveMessage) {
      state.saveMessage = null;
    }
    state.isDirty = false;
    state.pdfDocument = null;
    state.detectedFieldCount = 0;
    state.editableFieldCount = 0;
    state.readOnlyFieldCount = 0;
    state.formKind = 'none';
    state.isLoading = false;
  }

  private async inspectPdfViewerDocument(
    state: PdfViewerState,
    pdfDocument: PDFDocumentProxy,
    loadToken: number
  ) {
    state.isLoading = true;

    try {
      const fieldObjects = await pdfDocument.getFieldObjects();
      if (this.isStalePdfLoad(state, pdfDocument, loadToken)) {
        return;
      }

      let summary = this.summarizePdfJsFieldObjects(fieldObjects);

      if (summary.total === 0) {
        summary = await this.summarizePdfJsAnnotations(pdfDocument);
      }

      if (this.isStalePdfLoad(state, pdfDocument, loadToken)) {
        return;
      }

      if (summary.total === 0 && (pdfDocument.isPureXfa || pdfDocument.allXfaHtml)) {
        summary = {
          total: 1,
          editable: 1,
          readOnly: 0,
          kind: 'xfa',
        };
      }

      state.detectedFieldCount = summary.total;
      state.editableFieldCount = summary.editable;
      state.readOnlyFieldCount = summary.readOnly;
      state.formKind = summary.kind;
    } catch (error) {
      if (!this.isStalePdfLoad(state, pdfDocument, loadToken)) {
        console.error('Failed to inspect PDF form fields', error);
        state.loadError = 'Could not inspect PDF fields';
      }
    } finally {
      if (!this.isStalePdfLoad(state, pdfDocument, loadToken)) {
        state.isLoading = false;
      }
    }
  }

  private summarizePdfJsFieldObjects(fieldObjects: { [x: string]: Array<object> } | null): PdfFieldSummary {
    if (!fieldObjects) {
      return this.emptyPdfFieldSummary();
    }

    const fields = Object.values(fieldObjects) as PdfJsFieldWidget[][];
    return this.summarizePdfJsFieldGroups(fields, 'acroform');
  }

  private async summarizePdfJsAnnotations(pdfDocument: PDFDocumentProxy): Promise<PdfFieldSummary> {
    const fieldsByName = new Map<string, PdfJsFieldWidget[]>();

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const page = await pdfDocument.getPage(pageNumber);
      const annotations = await page.getAnnotations({ intent: 'display' });

      for (const annotation of annotations as PdfJsFieldWidget[]) {
        const hasFieldMetadata = !!annotation.fieldName ||
          !!annotation.fieldType ||
          annotation.checkBox === true ||
          annotation.radioButton === true ||
          annotation.combo === true ||
          annotation.multiSelect === true ||
          Array.isArray(annotation.options);
        const fieldName = annotation.fieldName || (hasFieldMetadata ? annotation.id : undefined);

        if (!hasFieldMetadata || !fieldName) {
          continue;
        }

        const widgets = fieldsByName.get(fieldName) ?? [];
        widgets.push(annotation);
        fieldsByName.set(fieldName, widgets);
      }
    }

    return this.summarizePdfJsFieldGroups(Array.from(fieldsByName.values()), 'widget');
  }

  private summarizePdfJsFieldGroups(fields: PdfJsFieldWidget[][], kind: PdfFormKind): PdfFieldSummary {
    const total = fields.length;
    const readOnly = fields.filter(widgets => widgets.length > 0 && widgets.every(widget => widget.readOnly)).length;

    return {
      total,
      editable: total - readOnly,
      readOnly,
      kind: total > 0 ? kind : 'none',
    };
  }

  private emptyPdfFieldSummary(): PdfFieldSummary {
    return {
      total: 0,
      editable: 0,
      readOnly: 0,
      kind: 'none',
    };
  }

  private isStalePdfLoad(
    state: PdfViewerState,
    pdfDocument: PDFDocumentProxy,
    loadToken: number
  ): boolean {
    return loadToken !== state.loadToken || pdfDocument !== state.pdfDocument;
  }

  private getPdfLinkForState(kind: CharacterPdfKind): string | null {
    return kind === 'ddb'
      ? this.character?.ddbPdfLink ?? null
      : this.getCustomPdfLink();
  }

  private getCustomPdfLink(): string | null {
    const customLink = this.character?.pdfLink ?? null;
    const ddbLink = this.character?.ddbPdfLink ?? null;
    if (!customLink) {
      return null;
    }

    if (ddbLink && this.arePdfLinksEquivalent(customLink, ddbLink)) {
      return null;
    }

    if (ddbLink && this.isDdbSheetPdfLink(customLink)) {
      return null;
    }

    return customLink;
  }

  private refreshOtherPdfState(savedKind: CharacterPdfKind) {
    const otherState = savedKind === 'ddb' ? this.customPdf : this.ddbPdf;
    if (!otherState.isDirty) {
      this.loadPdfState(otherState, this.getPdfLinkForState(otherState.kind));
    }
  }

  private arePdfLinksEquivalent(first: string, second: string): boolean {
    return this.normalizePdfLinkForComparison(first) === this.normalizePdfLinkForComparison(second);
  }

  private normalizePdfLinkForComparison(link: string): string {
    if (this.isRawDdbSheetPdfLink(link)) {
      return link.split('?')[0].replace(/\/+$/, '').toLowerCase();
    }

    try {
      const resolved = this.fileService.resolveFileUrl(link);
      const parsed = new URL(resolved);
      return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
    } catch {
      return link.split('?')[0].replace(/\/+$/, '').toLowerCase();
    }
  }

  private isDdbSheetPdfLink(link: string): boolean {
    if (this.isRawDdbSheetPdfLink(link)) {
      return true;
    }

    try {
      const parsed = new URL(this.fileService.resolveFileUrl(link));
      return parsed.hostname.toLowerCase().endsWith('dndbeyond.com') &&
        parsed.pathname.toLowerCase().startsWith('/sheet-pdfs/') &&
        parsed.pathname.toLowerCase().endsWith('.pdf');
    } catch {
      return /dndbeyond\.com\/sheet-pdfs\/.+\.pdf/i.test(link);
    }
  }

  private isRawDdbSheetPdfLink(link: string): boolean {
    try {
      const parsed = new URL(link);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();

      return parsed.protocol === 'https:' &&
        (hostname === 'www.dndbeyond.com' || hostname === 'dndbeyond.com') &&
        pathname.startsWith('/sheet-pdfs/') &&
        pathname.endsWith('.pdf');
    } catch {
      return /dndbeyond\.com\/sheet-pdfs\/.+\.pdf/i.test(link);
    }
  }

  private getEditedPdfFileName(kind: CharacterPdfKind): string {
    const characterName = this.character?.name || 'character';
    const safeName = characterName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'character';
    const suffix = kind === 'ddb' ? 'ddb-sheet' : 'sheet';

    return `${safeName}-${suffix}.pdf`;
  }

  private withCacheBust(url: string, force: boolean): string {
    if (!force) {
      return url;
    }

    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}v=${Date.now()}`;
  }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }
}
