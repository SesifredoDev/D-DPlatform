import Konva from 'konva';
import Token from './Token.js';
import { WallManager} from "./WallManager.js";
import { LightingManager } from './LightManager.js';
import {MeasurementManager} from "./MeasurementManagement";
import {FxManager} from "./FxManager.js";

export class VttEngine {
  constructor(containerId, currentUserId, gridSize = 50) {
    this.gridSize = gridSize;
    this.gridColor = '#cccccc';
    this.gridThickness = 1;
    this.gridType = 'square';
    this.currentMapW = 1000;
    this.currentMapH = 1000;
    this.currentMapUrl = null;
    this.containerId = containerId;
    this.localCharacter = null;
    this.currentUserId= currentUserId;

    this.isDM = false
    this.playersCanControlAllPlayerTokens = false;
    this.playersCanUseFx = false;
    this.backgroundViewportLimitMultiplier = 1.5;
    const containerSize = this.resolveContainerSize(containerId);
    this.stage = new Konva.Stage({
      container: containerId,
      width: containerSize.width,
      height: containerSize.height,
      draggable: true
    });
    this.stage.dragBoundFunc((pos) => this.clampStagePosition(pos));

    this.mapLayer = new Konva.Layer();
    this.gridLayer = new Konva.Layer();
    this.wallLayer = new Konva.Layer({ visible: false });
    this.fxLayer = new Konva.Layer();
    this.tokenLayer = new Konva.Layer();
    this.overlayLayer = new Konva.Layer({ listening: false }); // Layer for pings and temp effects

    this.lightLayer = new Konva.Layer({
      opacity: 1,
      visible: false,
      listening: false
    });
    this.stage.add(this.mapLayer, this.gridLayer, this.fxLayer, this.wallLayer, this.tokenLayer, this.lightLayer, this.overlayLayer);

    this.lightingManager = new LightingManager(this);
    this.wallManager = new WallManager(this);
    this.fxManager = new FxManager(this);
    this.measurementManager = new MeasurementManager(this);

    this.initDefaultMap();
    this.initZoom();
    this.initInteraction();
  }

  setContainer(container) {
    const containerSize = this.resolveContainerSize(container);
    this.containerId = container;
    this.stage.container(container);
    this.fxManager?.setContainer(container);
    this.stage.width(containerSize.width);
    this.stage.height(containerSize.height);
    this.stage.batchDraw();
  }

  resolveContainerSize(container) {
    const rect = container?.getBoundingClientRect?.();
    const width = Math.floor(rect?.width || container?.clientWidth || window.innerWidth || 800);
    const height = Math.floor(rect?.height || container?.clientHeight || window.innerHeight || 600);

    return {
      width: Math.max(1, width),
      height: Math.max(1, height)
    };
  }

  initInteraction() {
    this.stage.on('dblclick dbltap', (e) => {
      if (this.fxManager?.isActive?.() || this.isMeasuring()) return;
      // Don't ping if clicking a token
      if (e.target.getParent()?.tokenReference) return;

      const pos = this.stage.getRelativePointerPosition();
      this.showPing(pos.x, pos.y, 'yellow');
      this.stage.fire('ping', { x: pos.x, y: pos.y, color: 'yellow' });
    });
  }

  showPing(x, y, color = 'yellow') {
    const group = new Konva.Group({ x, y });

    const ring1 = new Konva.Ring({
      innerRadius: 0,
      outerRadius: 2,
      stroke: color,
      strokeWidth: 2,
      opacity: 1
    });

    const ring2 = new Konva.Ring({
      innerRadius: 0,
      outerRadius: 1,
      stroke: color,
      strokeWidth: 1.5,
      opacity: 0.8
    });

    group.add(ring1, ring2);
    this.overlayLayer.add(group);

    new Konva.Tween({
      node: ring1,
      duration: 1,
      innerRadius: 40,
      outerRadius: 42,
      opacity: 0,
      easing: Konva.Easings.EaseOut,
    }).play();

    new Konva.Tween({
      node: ring2,
      duration: 1.2,
      innerRadius: 30,
      outerRadius: 31,
      opacity: 0,
      easing: Konva.Easings.EaseOut,
      onFinish: () => {
        group.destroy();
        this.overlayLayer.batchDraw();
      }
    }).play();

    this.overlayLayer.batchDraw();
  }

  setLocalCharacter(character) {
    this.localCharacter = character;
  }

  initDefaultMap() {
    this.mapLayer.destroyChildren();
    const defaultMap = new Konva.Rect({
      x: 0, y: 0,
      width: 1000, height: 1000,
      fill: 'white',
      name: 'map-bg'
    });
    this.currentMapW = 1000;
    this.currentMapH = 1000;

    this.mapLayer.add(defaultMap);
    this.drawGrid(this.currentMapW, this.currentMapH);
    this.centerMap();
    this.updateLighting();
  }

  setPermissions(isDM) {
    this.isDM = isDM;
    this.fxManager?.setPermissionMode(this.playersCanUseFx);
    this.refreshTokenPermissions();
    this.updateLighting();
  }

  setPlayerTokenControlMode(playersCanControlAllPlayerTokens) {
    this.playersCanControlAllPlayerTokens = !!playersCanControlAllPlayerTokens;
    this.refreshTokenPermissions();
  }

  setPlayerFxPermissionMode(playersCanUseFx) {
    this.playersCanUseFx = !!playersCanUseFx;
    this.fxManager?.setPermissionMode(this.playersCanUseFx);
  }

  refreshTokenPermissions() {
    this.tokenLayer.getChildren().forEach(group => {
      const token = group.tokenReference;
      if (token) {
        group.draggable((typeof token.canDrag === 'function' ? token.canDrag() : token.checkPermissions()) && !this.isFxActive());
      }
    });
    this.tokenLayer.batchDraw();
  }

  isMeasuring() {
    return !!this.measurementManager && this.measurementManager.mode !== 'none';
  }

  isFxActive() {
    return !!this.fxManager && this.fxManager.isActive();
  }

  clearAll() {
    this.tokenLayer.destroyChildren();
    this.overlayLayer.destroyChildren();
    this.fxManager?.clearAll(true);
    if (this.wallManager && typeof this.wallManager.clearAll === 'function') {
      this.wallManager.clearAll();
    } else {
      this.wallLayer.destroyChildren();
    }
    this.currentMapUrl = null;
    this.initDefaultMap();
    this.tokenLayer.batchDraw();
    this.updateLighting();
    console.log("VTT Engine cleared: Map, Tokens, and Walls have been reset.");
  }

  updateGridSize(newSize, remote = false) {
    this.updateGridSettings({ size: newSize }, remote);
  }

  updateGridSettings(settings = {}, remote = false) {
    const previousSize = this.gridSize;
    const previousType = this.gridType;
    const nextSettings = this.normalizeGridSettings(settings);

    this.gridSize = nextSettings.size;
    this.gridColor = nextSettings.color;
    this.gridThickness = nextSettings.thickness;
    this.gridType = nextSettings.type;

    // 1. Redraw the background grid lines
    this.drawGrid(this.currentMapW, this.currentMapH);

    if (previousSize !== this.gridSize || previousType !== this.gridType) {
      // 2. Rescale and reposition all existing tokens
      this.tokenLayer.getChildren().forEach(group => {
        const token = group.tokenReference;
        if (token) {
          token.initVisuals();
          token.snapToGrid(!remote);
        }
      });
    }

    this.tokenLayer.batchDraw();
    this.updateLighting();

    // 3. BROADCAST: Tell the sync service to notify other players
    if (!remote) {
      this.stage.fire('gridSettingsChanged', this.getGridSettings());
    }
  }

  normalizeGridSettings(settings = {}) {
    const parsedSize = parseInt(settings.size ?? settings.gridSize ?? this.gridSize, 10);
    const parsedThickness = parseFloat(settings.thickness ?? settings.gridThickness ?? this.gridThickness);
    const type = settings.gridType ?? settings.type ?? this.gridType;

    return {
      size: Number.isFinite(parsedSize) ? Math.max(8, parsedSize) : this.gridSize,
      color: settings.color ?? settings.gridColor ?? this.gridColor,
      thickness: Number.isFinite(parsedThickness) ? Math.max(0.25, parsedThickness) : this.gridThickness,
      type: type === 'hex' ? 'hex' : 'square'
    };
  }

  getGridSettings() {
    return {
      size: this.gridSize,
      color: this.gridColor,
      thickness: this.gridThickness,
      type: this.gridType,
      gridType: this.gridType
    };
  }

  drawGrid(width, height) {
    this.gridLayer.destroyChildren();
    this.gridLayer.clip({
      x: 0,
      y: 0,
      width,
      height
    });

    if (this.gridType === 'hex') {
      this.drawHexGrid(width, height);
      this.gridLayer.batchDraw();
      this.updateLighting();
      return;
    }

    for (let i = 0; i <= width / this.gridSize; i++) {
      this.gridLayer.add(new Konva.Line({
        points: [i * this.gridSize, 0, i * this.gridSize, height],
        stroke: this.gridColor,
        strokeWidth: this.gridThickness,
      }));
    }
    for (let j = 0; j <= height / this.gridSize; j++) {
      this.gridLayer.add(new Konva.Line({
        points: [0, j * this.gridSize, width, j * this.gridSize],
        stroke: this.gridColor,
        strokeWidth: this.gridThickness,
      }));
    }
    this.gridLayer.batchDraw();

    this.updateLighting();
  }

  drawHexGrid(width, height) {
    const radius = this.getHexRadius();
    const hexWidth = Math.sqrt(3) * radius;
    const rowStep = 1.5 * radius;
    const originX = hexWidth / 2;
    const originY = radius;
    const minRow = Math.floor((-originY - radius) / rowStep) - 1;
    const maxRow = Math.ceil((height - originY + radius) / rowStep) + 1;
    const columnPadding = Math.ceil(width / hexWidth) + maxRow + 4;

    for (let row = minRow; row <= maxRow; row++) {
      for (let column = -columnPadding; column <= columnPadding; column++) {
        const center = this.hexAxialToPixel(column, row, originX, originY, radius);
        if (
          center.x < -hexWidth ||
          center.x > width + hexWidth ||
          center.y < -radius ||
          center.y > height + radius
        ) {
          continue;
        }

        this.gridLayer.add(new Konva.Line({
          points: this.getHexPoints(center.x, center.y, radius),
          stroke: this.gridColor,
          strokeWidth: this.gridThickness,
          closed: true,
          listening: false
        }));
      }
    }
  }

  getHexRadius() {
    return this.gridSize / Math.sqrt(3);
  }

  hexAxialToPixel(q, r, originX, originY, radius) {
    return {
      x: originX + radius * Math.sqrt(3) * (q + r / 2),
      y: originY + radius * 1.5 * r
    };
  }

  getHexPoints(centerX, centerY, radius) {
    const points = [];
    for (let i = 0; i < 6; i++) {
      const angle = (-90 + 60 * i) * Math.PI / 180;
      points.push(
        centerX + radius * Math.cos(angle),
        centerY + radius * Math.sin(angle)
      );
    }
    return points;
  }

  getSnapPosition(x, y, tokenSize = 1) {
    if (this.gridType === 'hex') {
      return this.getHexSnapPosition(x, y);
    }

    const size = this.gridSize;

    if (tokenSize % 2 === 0) {
      return {
        x: Math.round(x / size) * size,
        y: Math.round(y / size) * size
      };
    }

    if (tokenSize === 0.5) {
      return {
        x: (Math.floor(x / size) * size) + (size / 2),
        y: (Math.floor(y / size) * size) + (size / 2)
      };
    }

    return {
      x: (Math.floor(x / size) * size) + (size / 2),
      y: (Math.floor(y / size) * size) + (size / 2)
    };
  }

  getGridSnapPoint(x, y) {
    return this.getSnapPosition(x, y, 1);
  }

  snapPointToGrid(point) {
    if (!point) return null;

    return this.getGridSnapPoint(point.x, point.y);
  }

  snapDistanceToGrid(distance) {
    const parsedDistance = Number(distance);
    const size = Number(this.gridSize) || 1;

    if (!Number.isFinite(parsedDistance)) {
      return 0;
    }

    return Math.round(parsedDistance / size) * size;
  }

  getGridDistanceFeet(distance) {
    const size = Number(this.gridSize) || 1;
    return Math.round(this.snapDistanceToGrid(distance) / size) * 5;
  }

  getHexSnapPosition(x, y) {
    const radius = this.getHexRadius();
    const originX = this.gridSize / 2;
    const originY = radius;
    const localX = x - originX;
    const localY = y - originY;
    const q = ((Math.sqrt(3) / 3) * localX - (1 / 3) * localY) / radius;
    const r = ((2 / 3) * localY) / radius;
    const rounded = this.roundHex(q, r);

    return this.hexAxialToPixel(rounded.q, rounded.r, originX, originY, radius);
  }

  roundHex(q, r) {
    const s = -q - r;
    let roundedQ = Math.round(q);
    let roundedR = Math.round(r);
    let roundedS = Math.round(s);

    const qDiff = Math.abs(roundedQ - q);
    const rDiff = Math.abs(roundedR - r);
    const sDiff = Math.abs(roundedS - s);

    if (qDiff > rDiff && qDiff > sDiff) {
      roundedQ = -roundedR - roundedS;
    } else if (rDiff > sDiff) {
      roundedR = -roundedQ - roundedS;
    }

    return { q: roundedQ, r: roundedR };
  }

  centerMap() {
    const mapObj = this.mapLayer.children[0];
    if (!mapObj) return;

    this.enforceZoomLimits();

    const x = (this.stage.width() / 2) - (this.currentMapW / 2) * this.stage.scaleX();
    const y = (this.stage.height() / 2) - (this.currentMapH / 2) * this.stage.scaleY();

    this.stage.position({ x, y });
    this.stage.batchDraw();
  }

  setBackground(url, isRemote = false) {
    this.currentMapUrl = url;
    this.stage.fire('mapLoadingStarted');
    console.log("Setting Background to "+this.currentMapUrl);
    const imageObj = new Image();
    imageObj.onload = () => {
      this.mapLayer.destroyChildren();
      this.currentMapW = imageObj.width;
      this.currentMapH = imageObj.height;

      const mapImage = new Konva.Image({
        x: 0, y: 0,
        image: imageObj,
        width: this.currentMapW,
        height: this.currentMapH,
      });
      this.mapLayer.add(mapImage);
      this.drawGrid(this.currentMapW, this.currentMapH);
      this.centerMap();
      this.stage.fire('mapLoadingFinished');
    };
    imageObj.onerror = () => {
        this.stage.fire('mapLoadingFinished');
        console.error("Failed to load map image");
    }
    imageObj.src = url;
  }

  initZoom() {
    const scaleBy = 1.1;
    this.stage.on('wheel', (e) => {
      e.evt.preventDefault();
      const oldScale = this.stage.scaleX();
      const pointer = this.stage.getPointerPosition();

      const mousePointTo = {
        x: (pointer.x - this.stage.x()) / oldScale,
        y: (pointer.y - this.stage.y()) / oldScale,
      };

      const requestedScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
      const newScale = this.clampZoomScale(requestedScale);
      this.stage.scale({ x: newScale, y: newScale });

      const newPos = {
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      };
      this.stage.position(this.clampStagePosition(newPos));
      this.stage.batchDraw();
    });
  }

  getMinZoomScale() {
    const stageWidth = this.stage?.width?.() || 0;
    const stageHeight = this.stage?.height?.() || 0;

    if (!stageWidth || !stageHeight || !this.currentMapW || !this.currentMapH) {
      return 1;
    }

    const fitToBackgroundScale = Math.min(
      stageWidth / this.currentMapW,
      stageHeight / this.currentMapH
    );

    return Math.min(1, fitToBackgroundScale / this.backgroundViewportLimitMultiplier);
  }

  clampZoomScale(scale) {
    return Math.max(scale, this.getMinZoomScale());
  }

  enforceZoomLimits() {
    const clampedScale = this.clampZoomScale(this.stage.scaleX());
    if (clampedScale !== this.stage.scaleX()) {
      this.stage.scale({ x: clampedScale, y: clampedScale });
    }
  }

  clampStagePosition(pos) {
    const stageWidth = this.stage?.width?.() || 0;
    const stageHeight = this.stage?.height?.() || 0;
    const scale = this.stage?.scaleX?.() || 1;
    const mapWidth = this.currentMapW * scale;
    const mapHeight = this.currentMapH * scale;

    if (!stageWidth || !stageHeight || !mapWidth || !mapHeight) {
      return pos;
    }

    return {
      x: this.clampAxisPosition(pos.x, stageWidth, mapWidth),
      y: this.clampAxisPosition(pos.y, stageHeight, mapHeight)
    };
  }

  clampAxisPosition(position, viewportSize, contentSize) {
    const edgeBuffer = Math.min(
      viewportSize / 2,
      contentSize * ((this.backgroundViewportLimitMultiplier - 1) / 2)
    );
    const min = viewportSize - contentSize - edgeBuffer;
    const max = edgeBuffer;

    if (min > max) {
      return (viewportSize - contentSize) / 2;
    }

    return Math.min(max, Math.max(min, position));
  }

  addToken(x, y, options = {}, remote = false) {
    // 1. Check if token already exists to prevent duplicates
    const existingGroup = this.tokenLayer.findOne('#' + options.id);
    if (existingGroup) {
      if (remote) {
        const token = existingGroup.tokenReference;
        if (token) {
          token.updateConfig(options, false);
          if (x !== undefined && y !== undefined) {
            existingGroup.x(x);
            existingGroup.y(y);
          }
        }
        this.tokenLayer.batchDraw();
      }

      this.updateLighting();
      return;
    }

    const token = new Token(x, y, this, options);
    this.tokenLayer.add(token.group);
    this.tokenLayer.batchDraw();
    console.log(token.id);

    if (!remote) {
      const broadcastOptions = this.getTokenConfig(token);
      this.stage.fire('tokenAdded', { x, y, options: broadcastOptions, remote: false });
    }

    this.updateLighting();
  }

  updateTokenConfig(tokenId, options, remote = false) {
    if (!remote && !this.isDM) {
      return;
    }

    const existingGroup = this.tokenLayer.findOne('#' + tokenId);
    if (existingGroup) {
      const token = existingGroup.tokenReference;
      if (token) {
        token.updateConfig(options, !remote);
        this.tokenLayer.batchDraw();
        this.updateLighting();
        if (!remote) {
          this.stage.fire('tokenUpdated', { id: tokenId, options, remote: false });
        }
      }
    }
  }

  getTokenConfig(token) {
    return {
      id: token.id,
      name: token.name,
      color: token.color,
      icon: token.imageUrl,
      ownerId: token.ownerId,
      isPlayer: token.isPlayer,
      size: token.size,
      forceBorder: token.forceBorder,
      borderColor: token.borderColor,
      notes: token.notes,
      currentHealth: token.currentHealth,
      maxHealth: token.maxHealth,
      effects: token.effects
    };
  }

  animateTokenMove(tokenId, newX, newY) {
    // Search using the ID selector
    const tokenGroup = this.tokenLayer.findOne('#' + tokenId);

    if (!tokenGroup) {
      console.error(`Token ${tokenId} not found. Current IDs:`,
        this.tokenLayer.getChildren().map(g => g.id()));
      return;
    }

    new Konva.Tween({
      node: tokenGroup,
      duration: 0.2,
      x: newX,
      y: newY,
      easing: Konva.Easings.EaseInOut,
      onUpdate: () => this.updateLighting()
    }).play();
  }

  removeToken(tokenId, remote = false) {
    const tokenGroup = this.tokenLayer.findOne('#' + tokenId);
    if (tokenGroup) {
      tokenGroup.destroy();
      this.tokenLayer.batchDraw();
      this.updateLighting();
      if (!remote) {
        this.stage.fire('tokenDeleted', { id: tokenId, remote: false });
      }
    }
  }
  toggleWallMode(active) {
    if (active) this.fxManager?.setMode('none');
    this.wallManager.toggleMode(active);
    this.updateLighting();
  }

  exportConfig() {
    const blob = new Blob([JSON.stringify(this.getRawConfig(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = "vtt_map.json";
    link.click();
  }


  getRawConfig() {
    return {
      gridSize: this.gridSize,
      gridColor: this.gridColor,
      gridThickness: this.gridThickness,
      gridType: this.gridType,
      playersCanControlAllPlayerTokens: this.playersCanControlAllPlayerTokens,
      playersCanUseFx: this.playersCanUseFx,
      lightingEnabled: this.lightLayer.visible(),
      fxEffects: this.fxManager?.getEffectsData() || [],
      tokens: this.tokenLayer.getChildren().map(group => {
        const ref = group.tokenReference;
        return {
          id: group.id(),
          x: group.x(),
          y: group.y(),
          ...this.getTokenConfig(ref)
        };
      }),
      mapUrl: this.currentMapUrl || null,
      walls: this.wallManager.getWallsData()
    };
  }

  loadConfigFromObject(config) {

    try {
      if (!config) return;
      this.clearAll();
      if (config.playersCanControlAllPlayerTokens !== undefined) {
        this.playersCanControlAllPlayerTokens = !!config.playersCanControlAllPlayerTokens;
      }
      if (config.playersCanUseFx !== undefined) {
        this.setPlayerFxPermissionMode(!!config.playersCanUseFx);
      }
      if (config.lightingEnabled !== undefined) {
        this.lightLayer.visible(!!config.lightingEnabled);
      }
      this.updateGridSettings(config, true);

      if (config.mapUrl) {
        // ADD "true" as the second argument here to prevent redundant broadcasts
        this.setBackground(config.mapUrl, true);
        this.currentMapUrl = config.mapUrl;
      } else {
        this.initDefaultMap();
      }

      this.tokenLayer.destroyChildren();
      if (config.tokens) {
        config.tokens.forEach(t => {
          this.addToken(t.x, t.y, {
            ...t
          }, true);
        });
      }

      if (config.walls) {
        this.wallManager.loadWalls(config.walls);
      }

      this.fxManager.loadEffects(config.fxEffects || []);

      this.stage.batchDraw();
    } catch (e) {
      console.error("Failed to load config object", e);
    }
  }

  setMeasurementMode(mode, options = {}) {
    if (mode !== 'none') this.wallManager.setMode('none');
    if (mode !== 'none') this.fxManager?.setMode('none');
    this.measurementManager.setMode(mode, options);
    this.refreshTokenPermissions();
  }

  setFxMode(mode, options = {}) {
    if (mode !== 'none') {
      this.wallManager.setMode('none');
      this.measurementManager.setMode('none');
    }
    this.fxManager.setMode(mode, options);
    this.refreshTokenPermissions();
  }

  setFxColor(color) {
    this.fxManager.setColor(color);
  }

  publishFxAdded(effect) {
    if (!effect) return;
    this.stage.fire('fxAdded', { effect });
  }

  publishFxDeleted(effectId) {
    if (!effectId) return;
    this.stage.fire('fxDeleted', { id: effectId });
  }

  publishFxCleared() {
    this.stage.fire('fxCleared', {});
  }

  addFxEffect(effect, remote = false) {
    return this.fxManager.addEffect(effect, remote);
  }

  removeFxEffect(effectId, remote = false) {
    return this.fxManager.removeEffect(effectId, remote);
  }

  clearFxEffects(remote = false) {
    return this.fxManager.clearAll(remote);
  }

  updateLighting() {
    this.lightingManager.update();
  }
}
