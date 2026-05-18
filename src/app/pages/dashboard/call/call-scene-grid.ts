import type { PriorityGridPlacement } from '../../../shared/models/pages/dashboard/call/call.model';

const SCENE_GRID_CONFIG = {
  minMainLayoutWidthPx: 720,
  minMainLayoutHeightPx: 420,
  priorityGridColumns: 12,
  mainColumnsPerRow: 2,
  sideColumnsPerRow: 4,
  gridGapPx: 12,
  mainMinAspectRatio: 1 / 1,
  defaultMainAreaRatio: 0.5,
  expandedMainAreaRatio: 0.8
};

export interface SceneGridContentMetrics {
  contentWidthPx: number;
  contentHeightPx: number;
  hasLayoutSpace: boolean;
}

export interface PriorityGridPlacementOptions {
  participantId: string | null | undefined;
  isSceneMainLayoutActive: boolean;
  visibleIds: string[];
  sceneMainIds: string[];
  visibleParticipantCount: number;
}

export function getSceneSideRowCount(
  isSceneMainLayoutActive: boolean,
  visibleParticipantCount: number,
  visibleSceneMainCharacterCount: number
): number {
  if (!isSceneMainLayoutActive) {
    return 1;
  }

  const sideParticipantCount = Math.max(0, visibleParticipantCount - visibleSceneMainCharacterCount);
  return Math.max(1, Math.ceil(sideParticipantCount / SCENE_GRID_CONFIG.sideColumnsPerRow));
}

export function getSceneMainGridRowCount(sceneMainCount: number): number {
  return Math.max(1, Math.ceil(sceneMainCount / SCENE_GRID_CONFIG.mainColumnsPerRow));
}

export function getSceneMainRowHeightCss(
  contentHeightPx: number,
  rowCount: number,
  areaHeightPercent: number,
  rowHeightPx: number
): string {
  if (!contentHeightPx) {
    if (rowCount <= 1) {
      return `${areaHeightPercent}%`;
    }

    const rowPercent = areaHeightPercent / rowCount;
    const rowGapOffsetPx = SCENE_GRID_CONFIG.gridGapPx * (rowCount - 1) / rowCount;
    return `calc(${rowPercent}% - ${rowGapOffsetPx}px)`;
  }

  return `${rowHeightPx}px`;
}

export function getSceneSideRowHeightCss(contentHeightPx: number, rowHeightPx: number): string {
  return contentHeightPx ? `${rowHeightPx}px` : '120px';
}

export function getSceneSideTileMaxWidthCss(contentHeightPx: number, rowHeightPx: number): string {
  return contentHeightPx ? `${Math.floor(rowHeightPx * 16 / 9)}px` : '100%';
}

export function getSceneMainRowHeightPx(areaHeightPx: number, rowCount: number): number {
  const rowHeightPoolPx = Math.max(0, areaHeightPx - SCENE_GRID_CONFIG.gridGapPx * (rowCount - 1));
  return Math.max(1, Math.floor(rowHeightPoolPx / rowCount));
}

export function getSceneSideRowHeightPx(
  contentHeightPx: number,
  mainAreaHeightPx: number,
  sideRowCount: number
): number {
  const remainingHeightPx = Math.max(
    0,
    contentHeightPx - mainAreaHeightPx - (SCENE_GRID_CONFIG.gridGapPx * sideRowCount)
  );

  return Math.max(1, Math.floor(remainingHeightPx / sideRowCount));
}

export function getSceneMainAreaHeightPx(contentHeightPx: number, areaHeightRatio: number): number {
  return Math.max(0, Math.floor(contentHeightPx * areaHeightRatio));
}

export function getSceneMainAreaHeightRatio(
  visibleParticipantCount: number,
  visibleSceneMainCharacterCount: number
): number {
  if (visibleParticipantCount <= 1) {
    return 1;
  }

  return visibleSceneMainCharacterCount >= 3
    ? SCENE_GRID_CONFIG.expandedMainAreaRatio
    : SCENE_GRID_CONFIG.defaultMainAreaRatio;
}

export function getPriorityGridPlacement(
  options: PriorityGridPlacementOptions
): PriorityGridPlacement | null {
  if (!options.isSceneMainLayoutActive || !options.participantId) {
    return null;
  }

  if (!options.visibleIds.includes(options.participantId)) {
    return null;
  }

  const sceneMainIndex = options.sceneMainIds.indexOf(options.participantId);
  if (sceneMainIndex !== -1) {
    return getSceneMainPriorityGridPlacement(
      sceneMainIndex,
      options.sceneMainIds.length,
      options.visibleParticipantCount
    );
  }

  const sideIds = options.visibleIds.filter(id => !options.sceneMainIds.includes(id));
  const sideIndex = sideIds.indexOf(options.participantId);
  if (sideIndex === -1) {
    return null;
  }

  const rowIndex = Math.floor(sideIndex / SCENE_GRID_CONFIG.sideColumnsPerRow);
  const indexInRow = sideIndex % SCENE_GRID_CONFIG.sideColumnsPerRow;
  const rowItemCount = Math.min(
    SCENE_GRID_CONFIG.sideColumnsPerRow,
    sideIds.length - rowIndex * SCENE_GRID_CONFIG.sideColumnsPerRow
  );

  return getCenteredRowPlacement(
    getSceneMainGridRowCount(options.sceneMainIds.length) + 1 + rowIndex,
    indexInRow,
    rowItemCount,
    3
  );
}

export function getPriorityGridMaxHeightPx(contentWidthPx: number, columnSpan: number): number | null {
  const cellWidthPx = getPriorityGridCellWidthPx(contentWidthPx, columnSpan);
  return cellWidthPx ? Math.floor(cellWidthPx / SCENE_GRID_CONFIG.mainMinAspectRatio) : null;
}

export function measureSceneGridContent(element: HTMLElement): SceneGridContentMetrics {
  const styles = getComputedStyle(element);
  const contentWidthPx = Math.max(
    0,
    element.clientWidth - toCssPixelValue(styles.paddingLeft) - toCssPixelValue(styles.paddingRight)
  );
  const contentHeightPx = Math.max(
    0,
    element.clientHeight - toCssPixelValue(styles.paddingTop) - toCssPixelValue(styles.paddingBottom)
  );

  return {
    contentWidthPx,
    contentHeightPx,
    hasLayoutSpace: contentWidthPx >= SCENE_GRID_CONFIG.minMainLayoutWidthPx &&
      contentHeightPx >= SCENE_GRID_CONFIG.minMainLayoutHeightPx
  };
}

function getSceneMainPriorityGridPlacement(
  sceneMainIndex: number,
  sceneMainCount: number,
  visibleParticipantCount: number
): PriorityGridPlacement {
  const rowIndex = Math.floor(sceneMainIndex / SCENE_GRID_CONFIG.mainColumnsPerRow);
  const indexInRow = sceneMainIndex % SCENE_GRID_CONFIG.mainColumnsPerRow;
  const rowItemCount = Math.min(
    SCENE_GRID_CONFIG.mainColumnsPerRow,
    sceneMainCount - rowIndex * SCENE_GRID_CONFIG.mainColumnsPerRow
  );

  const columnSpan = sceneMainCount === 1 && visibleParticipantCount === 1
    ? SCENE_GRID_CONFIG.priorityGridColumns
    : getSceneMainColumnSpan(rowItemCount);

  return getCenteredRowPlacement(
    1 + rowIndex,
    indexInRow,
    rowItemCount,
    columnSpan
  );
}

function getCenteredRowPlacement(
  row: number,
  indexInRow: number,
  rowItemCount: number,
  columnSpan: number
): PriorityGridPlacement {
  const usedColumns = rowItemCount * columnSpan;
  const offsetColumns = Math.floor((SCENE_GRID_CONFIG.priorityGridColumns - usedColumns) / 2);

  return {
    row,
    column: 1 + offsetColumns + indexInRow * columnSpan,
    columnSpan
  };
}

function getSceneMainColumnSpan(rowItemCount: number): number {
  return rowItemCount <= 1 ? 8 : 6;
}

function getPriorityGridCellWidthPx(contentWidthPx: number, columnSpan: number): number | null {
  if (!contentWidthPx) {
    return null;
  }

  const trackWidthPx = (
    contentWidthPx - SCENE_GRID_CONFIG.gridGapPx * (SCENE_GRID_CONFIG.priorityGridColumns - 1)
  ) / SCENE_GRID_CONFIG.priorityGridColumns;

  return Math.max(
    1,
    Math.floor(trackWidthPx * columnSpan + SCENE_GRID_CONFIG.gridGapPx * (columnSpan - 1))
  );
}

function toCssPixelValue(value: string): number {
  const numericValue = Number.parseFloat(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}
