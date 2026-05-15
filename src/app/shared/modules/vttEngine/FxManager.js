import Konva from 'konva';

const FX_MODES = new Set(['none', 'polygon', 'square', 'circle', 'cone', 'erase']);
const MIN_EFFECT_SIZE = 8;
const MAX_TEXTURE_SIZE = 220;
const MIN_TEXTURE_SIZE = 36;

class PerlinNoise {
  constructor(seed = 1) {
    const random = this.seededRandom(seed);
    const values = Array.from({ length: 256 }, (_, index) => index);

    for (let index = values.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(random() * (index + 1));
      [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
    }

    this.permutation = [...values, ...values];
  }

  seededRandom(seed) {
    let value = Math.floor(Math.abs(Number(seed) || 1)) || 1;
    return () => {
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      return ((value >>> 0) % 100000) / 100000;
    };
  }

  fade(value) {
    return value * value * value * (value * (value * 6 - 15) + 10);
  }

  lerp(a, b, amount) {
    return a + amount * (b - a);
  }

  grad(hash, x, y) {
    switch (hash & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  }

  noise2D(x, y) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = this.fade(xf);
    const v = this.fade(yf);
    const aa = this.permutation[this.permutation[xi] + yi];
    const ab = this.permutation[this.permutation[xi] + yi + 1];
    const ba = this.permutation[this.permutation[xi + 1] + yi];
    const bb = this.permutation[this.permutation[xi + 1] + yi + 1];
    const x1 = this.lerp(this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf), u);
    const x2 = this.lerp(this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1), u);

    return this.lerp(x1, x2, v);
  }

  fbm(x, y) {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;
    let totalAmplitude = 0;

    for (let octave = 0; octave < 4; octave++) {
      value += this.noise2D(x * frequency, y * frequency) * amplitude;
      totalAmplitude += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    return totalAmplitude ? value / totalAmplitude : 0;
  }
}

export class FxManager {
  constructor(engine) {
    this.engine = engine;
    this.layer = engine.fxLayer;
    this.mode = 'none';
    this.color = '#6fd6ff';
    this.coneAngle = 53;
    this.effects = new Map();
    this.dragStart = null;
    this.dragPreview = null;
    this.dragPreviewLabel = null;
    this.polygonPoints = [];
    this.polygonPreview = null;
    this.polygonPreviewLabel = null;
    this.renderedAt = 0;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleContextMenu = this.handleContextMenu.bind(this);
    window.addEventListener('keydown', this.handleKeyDown);
    this.container = null;
    this.setContainer(this.engine.stage.container());

    this.initEvents();
    this.animation = new Konva.Animation((frame) => this.animate(frame), this.layer);
    this.animation.start();
  }

  isActive() {
    return this.mode !== 'none';
  }

  canUseFx() {
    return !!this.engine.isDM || !!this.engine.playersCanUseFx;
  }

  setContainer(container) {
    if (this.container === container) return;

    this.container?.removeEventListener('contextmenu', this.handleContextMenu);
    this.container = container;
    this.container?.addEventListener('contextmenu', this.handleContextMenu);
  }

  setMode(mode, options = {}) {
    const nextMode = FX_MODES.has(mode) ? mode : 'none';

    this.cancelCurrentDrawing();
    this.mode = nextMode !== 'none' && !this.canUseFx() ? 'none' : nextMode;

    if (options.color) {
      this.setColor(options.color);
    }
    if (options.coneAngle !== undefined) {
      this.coneAngle = this.normalizeConeAngle(options.coneAngle);
    }

    const container = this.engine.stage.container();
    container.style.cursor = this.mode === 'erase' ? 'not-allowed' : this.mode !== 'none' ? 'crosshair' : 'default';
    this.engine.stage.draggable(this.mode === 'none' && !this.engine.wallManager?.isWallMode && !this.engine.isMeasuring?.());
    this.engine.refreshTokenPermissions?.();
  }

  setColor(color) {
    this.color = this.normalizeColor(color);
  }

  normalizeConeAngle(angle) {
    const parsedAngle = Number(angle);
    return Number.isFinite(parsedAngle) ? Math.min(359, Math.max(1, parsedAngle)) : 53;
  }

  setPermissionMode(playersCanUseFx) {
    this.engine.playersCanUseFx = !!playersCanUseFx;
    if (!this.canUseFx()) {
      this.setMode('none');
    } else {
      this.engine.refreshTokenPermissions?.();
    }
  }

  initEvents() {
    const stage = this.engine.stage;

    stage.on('mousedown', (e) => {
      if (!this.isActive()) return;
      if (!this.canUseFx()) {
        this.setMode('none');
        return;
      }

      e.cancelBubble = true;
      e.evt.preventDefault();

      if (this.mode === 'erase') {
        if (e.evt.button === 0) {
          this.deleteEffectFromTarget(e.target);
        }
        return;
      }

      if (this.mode === 'polygon') {
        this.handlePolygonMouseDown(e);
        return;
      }

      if (e.evt.button !== 0) return;
      this.startDragShape();
    });

    stage.on('mousemove', (e) => {
      if (!this.isActive()) return;
      e.cancelBubble = true;

      if (this.mode === 'polygon') {
        this.updatePolygonPreview();
        return;
      }

      this.updateDragPreview();
    });

    stage.on('mouseup mouseleave', (e) => {
      if (!this.isActive() || this.mode === 'polygon' || this.mode === 'erase') return;
      e.cancelBubble = true;
      this.finishDragShape();
    });

    stage.on('dblclick dbltap', (e) => {
      if (this.mode !== 'polygon') return;
      e.cancelBubble = true;
      e.evt.preventDefault();
      this.finishPolygon();
    });
  }

  handleKeyDown(e) {
    if (!this.isActive()) return;

    if (e.key === 'Escape') {
      this.cancelCurrentDrawing();
    } else if (e.key === 'Enter' && this.mode === 'polygon') {
      this.finishPolygon();
    }
  }

  handleContextMenu(e) {
    if (!this.isActive()) return;
    e.preventDefault();

    if (this.mode === 'polygon') {
      this.finishPolygon();
    }
  }

  getRelativePointerPosition() {
    const pointer = this.engine.stage.getPointerPosition();
    if (!pointer) return null;

    const transform = this.engine.stage.getAbsoluteTransform().copy().invert();
    return transform.point(pointer);
  }

  getSnappedPointerPosition() {
    const pos = this.getRelativePointerPosition();
    return this.engine.snapPointToGrid?.(pos) || pos;
  }

  startDragShape() {
    const pos = this.getSnappedPointerPosition();
    if (!pos) return;

    this.dragStart = pos;
    this.dragPreview = this.createPreviewShape(this.mode, pos);
    this.dragPreviewLabel = this.createMeasureLabel('0 ft', pos.x, pos.y - 28);
    this.layer.add(this.dragPreview);
    this.layer.add(this.dragPreviewLabel);
    this.layer.batchDraw();
  }

  createPreviewShape(type, pos) {
    const shared = {
      stroke: this.color,
      strokeWidth: 2,
      dash: [8, 4],
      fill: this.color,
      opacity: 0.25,
      listening: false
    };

    if (type === 'circle') {
      return new Konva.Circle({ ...shared, x: pos.x, y: pos.y, radius: 0 });
    }

    if (type === 'cone') {
      return new Konva.Wedge({
        ...shared,
        x: pos.x,
        y: pos.y,
        radius: 0,
        angle: this.coneAngle,
        rotation: -this.coneAngle / 2
      });
    }

    return new Konva.Rect({ ...shared, x: pos.x, y: pos.y, width: 0, height: 0 });
  }

  createMeasureLabel(text, x, y) {
    const label = new Konva.Label({
      x,
      y,
      opacity: 0.92,
      listening: false
    });

    label.add(new Konva.Tag({
      fill: 'black',
      cornerRadius: 4,
      pointerDirection: 'down',
      pointerWidth: 8,
      pointerHeight: 6
    }));
    label.add(new Konva.Text({
      text,
      fill: 'white',
      padding: 5,
      fontSize: 13,
      fontStyle: 'bold'
    }));

    return label;
  }

  setMeasureLabel(label, text, x, y) {
    if (!label) return;

    label.getText().text(text);
    label.position({ x, y });
  }

  destroyDragPreviewLabel() {
    if (!this.dragPreviewLabel) return;

    this.dragPreviewLabel.destroy();
    this.dragPreviewLabel = null;
  }

  updateDragPreview() {
    if (!this.dragStart || !this.dragPreview) return;

    const pos = this.getSnappedPointerPosition();
    if (!pos) return;

    if (this.mode === 'circle') {
      this.dragPreview.radius(this.getSnappedDistance(this.dragStart, pos));
    } else if (this.mode === 'cone') {
      this.updateConeShape(this.dragPreview, this.dragStart, pos, this.coneAngle);
    } else {
      this.dragPreview.setAttrs(this.getSquareFromDrag(this.dragStart, pos));
    }

    this.updateDragPreviewLabel(this.dragStart, pos, this.mode);
    this.layer.batchDraw();
  }

  updateDragPreviewLabel(start, current, mode) {
    if (!this.dragPreviewLabel) return;

    const radius = this.getSnappedDistance(start, current);
    const distanceText = this.formatFeet(radius);

    if (mode === 'square') {
      const rect = this.getSquareFromDrag(start, current);
      this.setMeasureLabel(
        this.dragPreviewLabel,
        `${this.formatFeet(rect.width)} x ${this.formatFeet(rect.height)}`,
        rect.x + rect.width / 2,
        rect.y - 26
      );
      return;
    }

    if (mode === 'cone') {
      const endpoint = this.getConeLabelPoint(start, current, radius * 0.72);
      this.setMeasureLabel(this.dragPreviewLabel, `${distanceText} / ${this.coneAngle} deg`, endpoint.x, endpoint.y - 18);
      return;
    }

    this.setMeasureLabel(this.dragPreviewLabel, distanceText, current.x, current.y - 26);
  }

  finishDragShape() {
    if (!this.dragStart || !this.dragPreview) return;

    const pos = this.getSnappedPointerPosition();
    const start = this.dragStart;
    const mode = this.mode;

    this.dragPreview.destroy();
    this.dragPreview = null;
    this.destroyDragPreviewLabel();
    this.dragStart = null;

    if (!pos) {
      this.layer.batchDraw();
      return;
    }

    const effect = mode === 'circle'
      ? this.createCircleEffect(start, pos)
      : mode === 'cone'
        ? this.createConeEffect(start, pos)
        : this.createSquareEffect(start, pos);

    if (effect) {
      this.addEffect(effect, false);
    }

    this.layer.batchDraw();
  }

  handlePolygonMouseDown(e) {
    if (e.evt.button === 2) {
      this.finishPolygon();
      return;
    }

    if (e.evt.button !== 0) return;

    const pos = this.getSnappedPointerPosition();
    if (!pos) return;

    if (this.polygonPoints.length >= 6 && this.isNearFirstPolygonPoint(pos)) {
      this.finishPolygon();
      return;
    }

    this.polygonPoints.push(pos.x, pos.y);

    if (!this.polygonPreview) {
      this.polygonPreview = new Konva.Line({
        points: [pos.x, pos.y, pos.x, pos.y],
        stroke: this.color,
        strokeWidth: 2,
        dash: [8, 4],
        closed: false,
        listening: false
      });
      this.layer.add(this.polygonPreview);
    }

    if (!this.polygonPreviewLabel) {
      this.polygonPreviewLabel = this.createMeasureLabel('0 ft', pos.x, pos.y - 26);
      this.layer.add(this.polygonPreviewLabel);
    }

    this.updatePolygonPreview(pos);
  }

  updatePolygonPreview(pointerPos = null) {
    if (!this.polygonPreview || this.polygonPoints.length < 2) return;

    const pos = pointerPos || this.getSnappedPointerPosition();
    if (!pos) return;

    this.polygonPreview.points([...this.polygonPoints, pos.x, pos.y]);
    this.updatePolygonPreviewLabel(pos);
    this.layer.batchDraw();
  }

  updatePolygonPreviewLabel(pos) {
    if (!this.polygonPreviewLabel || this.polygonPoints.length < 2) return;

    const lastPoint = {
      x: this.polygonPoints[this.polygonPoints.length - 2],
      y: this.polygonPoints[this.polygonPoints.length - 1]
    };
    const distance = this.getSnappedDistance(lastPoint, pos);
    const previewPoints = [...this.polygonPoints, pos.x, pos.y];
    const bounds = this.getPolygonBounds(previewPoints);
    const boundsText = bounds
      ? ` (${this.formatFeet(bounds.width)} x ${this.formatFeet(bounds.height)})`
      : '';

    this.setMeasureLabel(
      this.polygonPreviewLabel,
      `${this.formatFeet(distance)}${boundsText}`,
      pos.x,
      pos.y - 26
    );
  }

  destroyPolygonPreviewLabel() {
    if (!this.polygonPreviewLabel) return;

    this.polygonPreviewLabel.destroy();
    this.polygonPreviewLabel = null;
  }

  finishPolygon() {
    if (this.polygonPreview) {
      this.polygonPreview.destroy();
      this.polygonPreview = null;
    }
    this.destroyPolygonPreviewLabel();

    const points = [...this.polygonPoints];
    this.polygonPoints = [];

    if (points.length >= 6) {
      const effect = this.createPolygonEffect(points);
      if (effect) this.addEffect(effect, false);
    }

    this.layer.batchDraw();
  }

  cancelCurrentDrawing() {
    this.dragStart = null;
    if (this.dragPreview) {
      this.dragPreview.destroy();
      this.dragPreview = null;
    }
    this.destroyDragPreviewLabel();

    this.polygonPoints = [];
    if (this.polygonPreview) {
      this.polygonPreview.destroy();
      this.polygonPreview = null;
    }
    this.destroyPolygonPreviewLabel();

    this.layer.batchDraw();
  }

  createCircleEffect(start, current) {
    const radius = this.getSnappedDistance(start, current);
    if (radius < MIN_EFFECT_SIZE) return null;

    return {
      id: this.createId(),
      type: 'circle',
      x: start.x,
      y: start.y,
      radius,
      color: this.color,
      seed: this.createSeed(),
      opacity: 0.82
    };
  }

  createConeEffect(start, current) {
    const radius = this.getSnappedDistance(start, current);
    if (radius < MIN_EFFECT_SIZE) return null;

    const angle = this.normalizeConeAngle(this.coneAngle);
    const directionDegrees = Math.atan2(current.y - start.y, current.x - start.x) * 180 / Math.PI;

    return {
      id: this.createId(),
      type: 'cone',
      x: start.x,
      y: start.y,
      radius,
      angle,
      rotation: directionDegrees - angle / 2,
      color: this.color,
      seed: this.createSeed(),
      opacity: 0.82
    };
  }

  createSquareEffect(start, current) {
    const rect = this.getSquareFromDrag(start, current);
    if (rect.width < MIN_EFFECT_SIZE || rect.height < MIN_EFFECT_SIZE) return null;

    return {
      id: this.createId(),
      type: 'square',
      ...rect,
      color: this.color,
      seed: this.createSeed(),
      opacity: 0.82
    };
  }

  createPolygonEffect(points) {
    const bounds = this.getPolygonBounds(points);
    if (!bounds || bounds.width < MIN_EFFECT_SIZE || bounds.height < MIN_EFFECT_SIZE) return null;

    return {
      id: this.createId(),
      type: 'polygon',
      points,
      color: this.color,
      seed: this.createSeed(),
      opacity: 0.82
    };
  }

  addEffect(effect, remote = false) {
    const normalized = this.normalizeEffect(effect);
    if (!normalized) return false;

    if (this.effects.has(normalized.id)) {
      this.removeEffect(normalized.id, true);
    }

    const record = this.createEffectRecord(normalized);
    this.effects.set(normalized.id, record);
    this.layer.add(record.group);
    this.renderFog(record, performance.now());
    this.layer.batchDraw();

    if (!remote) {
      this.publishFxAdded(this.serializeEffect(normalized));
    }

    return true;
  }

  removeEffect(effectId, remote = false) {
    const record = this.effects.get(effectId);
    if (!record) return false;

    record.group.destroy();
    this.effects.delete(effectId);
    this.layer.batchDraw();

    if (!remote) {
      this.publishFxDeleted(effectId);
    }

    return true;
  }

  clearAll(remote = false) {
    this.cancelCurrentDrawing();
    this.effects.forEach(record => record.group.destroy());
    this.effects.clear();
    this.layer.batchDraw();

    if (!remote) {
      this.publishFxCleared();
    }

    return true;
  }

  publishFxAdded(effect) {
    if (!effect) return;

    if (typeof this.engine.publishFxAdded === 'function') {
      this.engine.publishFxAdded(effect);
      return;
    }

    this.engine.stage.fire('fxAdded', { effect });
  }

  publishFxDeleted(effectId) {
    if (!effectId) return;

    if (typeof this.engine.publishFxDeleted === 'function') {
      this.engine.publishFxDeleted(effectId);
      return;
    }

    this.engine.stage.fire('fxDeleted', { id: effectId });
  }

  publishFxCleared() {
    if (typeof this.engine.publishFxCleared === 'function') {
      this.engine.publishFxCleared();
      return;
    }

    this.engine.stage.fire('fxCleared', {});
  }

  deleteEffectFromTarget(target) {
    const effectId = this.findEffectId(target);
    if (effectId) {
      this.removeEffect(effectId, false);
    }
  }

  findEffectId(target) {
    let node = target;
    while (node && node !== this.layer && node !== this.engine.stage) {
      if (node.fxEffectId) return node.fxEffectId;
      node = typeof node.getParent === 'function' ? node.getParent() : null;
    }
    return null;
  }

  createEffectRecord(effect) {
    const bounds = this.getEffectBounds(effect);
    const textureSize = this.getTextureSize(bounds.width, bounds.height);
    const canvas = document.createElement('canvas');
    canvas.width = textureSize.width;
    canvas.height = textureSize.height;

    const group = new Konva.Group({
      id: `fx-${effect.id}`,
      x: bounds.x,
      y: bounds.y
    });
    group.fxEffectId = effect.id;

    const clipGroup = new Konva.Group({
      clipFunc: (ctx) => this.drawClipPath(ctx, effect, bounds)
    });
    clipGroup.fxEffectId = effect.id;

    const imageNode = new Konva.Image({
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
      image: canvas,
      opacity: 1,
      name: 'fx-effect'
    });
    imageNode.fxEffectId = effect.id;

    const outline = this.createOutline(effect, bounds);
    outline.fxEffectId = effect.id;

    clipGroup.add(imageNode, outline);
    group.add(clipGroup);

    return {
      ...effect,
      bounds,
      canvas,
      context: canvas.getContext('2d', { willReadFrequently: true }),
      group,
      imageNode,
      outline,
      noise: new PerlinNoise(effect.seed),
      rgb: this.hexToRgb(effect.color),
      lastRenderTime: 0
    };
  }

  createOutline(effect, bounds) {
    const shared = {
      stroke: effect.color,
      strokeWidth: 2,
      opacity: 0.75,
      listening: true,
      name: 'fx-effect-outline'
    };

    if (effect.type === 'circle') {
      return new Konva.Circle({
        ...shared,
        x: effect.x - bounds.x,
        y: effect.y - bounds.y,
        radius: effect.radius
      });
    }

    if (effect.type === 'cone') {
      return new Konva.Wedge({
        ...shared,
        x: effect.x - bounds.x,
        y: effect.y - bounds.y,
        radius: effect.radius,
        angle: effect.angle,
        rotation: effect.rotation
      });
    }

    if (effect.type === 'square') {
      return new Konva.Rect({
        ...shared,
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height
      });
    }

    return new Konva.Line({
      ...shared,
      points: effect.points.map((value, index) => value - (index % 2 === 0 ? bounds.x : bounds.y)),
      closed: true,
      lineJoin: 'round'
    });
  }

  drawClipPath(ctx, effect, bounds) {
    ctx.beginPath();

    if (effect.type === 'circle') {
      ctx.arc(effect.x - bounds.x, effect.y - bounds.y, effect.radius, 0, Math.PI * 2);
      ctx.closePath();
      return;
    }

    if (effect.type === 'cone') {
      const centerX = effect.x - bounds.x;
      const centerY = effect.y - bounds.y;
      const startAngle = effect.rotation * Math.PI / 180;
      const endAngle = (effect.rotation + effect.angle) * Math.PI / 180;

      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, effect.radius, startAngle, endAngle);
      ctx.closePath();
      return;
    }

    if (effect.type === 'square') {
      ctx.rect(0, 0, bounds.width, bounds.height);
      return;
    }

    for (let index = 0; index < effect.points.length; index += 2) {
      const x = effect.points[index] - bounds.x;
      const y = effect.points[index + 1] - bounds.y;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
  }

  animate(frame) {
    const time = frame?.time || performance.now();
    if (time - this.renderedAt < 45) return;

    this.renderedAt = time;
    this.effects.forEach(record => this.renderFog(record, time));
  }

  renderFog(record, time) {
    if (!record.context || !record.canvas.width || !record.canvas.height) return;

    const width = record.canvas.width;
    const height = record.canvas.height;
    const imageData = record.context.createImageData(width, height);
    const data = imageData.data;
    const rgb = record.rgb;
    const phase = time * 0.0007;
    const seedPhase = (record.seed % 10000) * 0.0001;
    const scale = 0.032;
    const fineScale = 0.074;
    const opacity = Math.max(0.1, Math.min(1, record.opacity ?? 0.82));
    const centerX = record.bounds.x + record.bounds.width / 2;
    const centerY = record.bounds.y + record.bounds.height / 2;
    const longestSide = Math.max(record.bounds.width, record.bounds.height, 1);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const worldX = record.bounds.x + (x / width) * record.bounds.width;
        const worldY = record.bounds.y + (y / height) * record.bounds.height;
        const localX = (worldX - centerX) / longestSide;
        const localY = (worldY - centerY) / longestSide;
        const flow = record.noise.fbm(worldX * 0.009 + seedPhase, worldY * 0.009 - seedPhase);
        const flowAngle = flow * Math.PI * 2 + Math.sin(phase * 0.8 + seedPhase) * Math.PI;
        const pulse = Math.sin(phase * 1.37 + flow * 2.8 + seedPhase) * 0.5 + 0.5;
        const strength = 10 + pulse * 8;
        const warpX =
          Math.cos(flowAngle) * strength +
          Math.sin(localY * 8 + phase * 1.9 + seedPhase) * 6;
        const warpY =
          Math.sin(flowAngle) * strength +
          Math.cos(localX * 8 - phase * 1.7 + seedPhase) * 6;
        const fold = Math.sin(localX * localY * 18 + phase * 1.2 + seedPhase) * 4;
        const primary = record.noise.fbm((worldX + warpX + fold) * scale, (worldY + warpY - fold) * scale);
        const counter = record.noise.fbm((worldX - warpX * 0.75) * scale, (worldY - warpY * 0.75) * scale);
        const fine = record.noise.fbm(
          (worldX + Math.sin(phase + localY * 4 + seedPhase) * 3) * fineScale,
          (worldY + Math.cos(phase - localX * 4 + seedPhase) * 3) * fineScale
        );
        const blend = Math.sin(phase * 1.1 + seedPhase) * 0.5 + 0.5;
        const noise = primary * (0.45 + blend * 0.15) + counter * (0.45 - blend * 0.15) + fine * 0.1;
        const breathe = 0.86 + Math.sin(phase * 1.6 + localX * 4 - localY * 3 + seedPhase) * 0.08;
        const fog = Math.max(0, Math.min(1, this.smoothstep(0.14, 0.88, (noise + 1) * 0.5) * breathe));
        const index = (y * width + x) * 4;
        const brightness = 0.76 + fog * 0.34;

        data[index] = Math.min(255, rgb.r * brightness);
        data[index + 1] = Math.min(255, rgb.g * brightness);
        data[index + 2] = Math.min(255, rgb.b * brightness);
        data[index + 3] = Math.floor((38 + fog * 150) * opacity);
      }
    }

    record.context.putImageData(imageData, 0, 0);
  }

  smoothstep(edge0, edge1, value) {
    const amount = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return amount * amount * (3 - 2 * amount);
  }

  updateConeShape(shape, start, current, angle) {
    const normalizedAngle = this.normalizeConeAngle(angle);
    const directionDegrees = Math.atan2(current.y - start.y, current.x - start.x) * 180 / Math.PI;

    shape.setAttrs({
      x: start.x,
      y: start.y,
      radius: this.getSnappedDistance(start, current),
      angle: normalizedAngle,
      rotation: directionDegrees - normalizedAngle / 2
    });
  }

  getConeLabelPoint(start, current, distance) {
    const direction = Math.atan2(current.y - start.y, current.x - start.x);

    return {
      x: start.x + Math.cos(direction) * distance,
      y: start.y + Math.sin(direction) * distance
    };
  }

  formatFeet(distancePx) {
    const feet = this.engine.getGridDistanceFeet?.(distancePx)
      ?? Math.round((distancePx / (this.engine.gridSize || 1)) * 5);

    return `${feet} ft`;
  }

  getSquareFromDrag(start, current) {
    const side = this.engine.snapDistanceToGrid?.(
      Math.max(Math.abs(current.x - start.x), Math.abs(current.y - start.y))
    ) ?? Math.max(Math.abs(current.x - start.x), Math.abs(current.y - start.y));

    return {
      x: current.x < start.x ? start.x - side : start.x,
      y: current.y < start.y ? start.y - side : start.y,
      width: side,
      height: side
    };
  }

  getSnappedDistance(a, b) {
    const distance = this.getDistance(a, b);
    return this.engine.snapDistanceToGrid?.(distance) ?? distance;
  }

  getDistance(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  isNearFirstPolygonPoint(pos) {
    if (this.polygonPoints.length < 2) return false;
    const first = { x: this.polygonPoints[0], y: this.polygonPoints[1] };
    return this.getDistance(first, pos) <= Math.max(10, this.engine.gridSize * 0.25);
  }

  getTextureSize(width, height) {
    const longest = Math.max(width, height, 1);
    const scale = Math.min(1, MAX_TEXTURE_SIZE / longest);
    return {
      width: Math.max(MIN_TEXTURE_SIZE, Math.ceil(width * scale)),
      height: Math.max(MIN_TEXTURE_SIZE, Math.ceil(height * scale))
    };
  }

  getEffectBounds(effect) {
    if (effect.type === 'circle') {
      return {
        x: effect.x - effect.radius,
        y: effect.y - effect.radius,
        width: effect.radius * 2,
        height: effect.radius * 2
      };
    }

    if (effect.type === 'cone') {
      return {
        x: effect.x - effect.radius,
        y: effect.y - effect.radius,
        width: effect.radius * 2,
        height: effect.radius * 2
      };
    }

    if (effect.type === 'square') {
      return {
        x: effect.x,
        y: effect.y,
        width: effect.width,
        height: effect.height
      };
    }

    return this.getPolygonBounds(effect.points);
  }

  getPolygonBounds(points) {
    if (!Array.isArray(points) || points.length < 6) return null;

    const xs = [];
    const ys = [];
    for (let index = 0; index < points.length; index += 2) {
      xs.push(points[index]);
      ys.push(points[index + 1]);
    }

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY)
    };
  }

  normalizeEffect(effect) {
    if (!effect || !FX_MODES.has(effect.type) || effect.type === 'none' || effect.type === 'erase') return null;

    const base = {
      id: effect.id || this.createId(),
      type: effect.type,
      color: this.normalizeColor(effect.color || this.color),
      seed: Number.isFinite(Number(effect.seed)) ? Number(effect.seed) : this.createSeed(),
      opacity: Number.isFinite(Number(effect.opacity)) ? Math.max(0.1, Math.min(1, Number(effect.opacity))) : 0.82
    };

    if (effect.type === 'circle') {
      const radius = Math.max(0, Number(effect.radius));
      if (!Number.isFinite(radius) || radius < MIN_EFFECT_SIZE) return null;
      return {
        ...base,
        x: Number(effect.x) || 0,
        y: Number(effect.y) || 0,
        radius
      };
    }

    if (effect.type === 'cone') {
      const radius = Math.max(0, Number(effect.radius));
      if (!Number.isFinite(radius) || radius < MIN_EFFECT_SIZE) return null;
      return {
        ...base,
        x: Number(effect.x) || 0,
        y: Number(effect.y) || 0,
        radius,
        angle: this.normalizeConeAngle(effect.angle),
        rotation: Number.isFinite(Number(effect.rotation)) ? Number(effect.rotation) : 0
      };
    }

    if (effect.type === 'square') {
      const width = Math.max(0, Number(effect.width));
      const height = Math.max(0, Number(effect.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_EFFECT_SIZE || height < MIN_EFFECT_SIZE) return null;
      return {
        ...base,
        x: Number(effect.x) || 0,
        y: Number(effect.y) || 0,
        width,
        height
      };
    }

    const points = Array.isArray(effect.points)
      ? effect.points.map(value => Number(value)).filter(value => Number.isFinite(value))
      : [];

    return points.length >= 6 ? { ...base, points } : null;
  }

  serializeEffect(effect) {
    const normalized = this.normalizeEffect(effect);
    if (!normalized) return null;

    return JSON.parse(JSON.stringify(normalized));
  }

  getEffectsData() {
    return Array.from(this.effects.values())
      .map(effect => this.serializeEffect(effect))
      .filter(Boolean);
  }

  loadEffects(effects) {
    this.clearAll(true);
    if (!Array.isArray(effects)) return;

    effects.forEach(effect => this.addEffect(effect, true));
  }

  createId() {
    return globalThis.crypto?.randomUUID?.() || `fx-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  createSeed() {
    return Math.floor(Math.random() * 1000000000);
  }

  normalizeColor(color) {
    if (typeof color !== 'string') return '#6fd6ff';
    const trimmed = color.trim();
    if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
    if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
      return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
    }
    return '#6fd6ff';
  }

  hexToRgb(color) {
    const normalized = this.normalizeColor(color).replace('#', '');
    const value = parseInt(normalized, 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255
    };
  }
}
