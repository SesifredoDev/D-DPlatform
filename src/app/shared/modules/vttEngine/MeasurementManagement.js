
import Konva from 'konva';

export class MeasurementManager {
  constructor(engine) {
    this.engine = engine;
    this.layer = new Konva.Layer();
    this.engine.stage.add(this.layer);
    this.layer.setZIndex(10); // Ensure measurements are always on top

    this.mode = 'none'; // 'none', 'line', 'radius', 'cone'
    this.coneAngle = 53;
    this.isDrawing = false;
    this.startPos = null;

    this.localGroup = null;
    this.remoteMeasures = {}; // userId -> Konva.Group

    // Generate a consistent color from the user's ID
    this.userColor = this.generateUserColor(this.engine.currentUserId || 'default');

    this.initEvents();
  }

  generateUserColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    // Convert to a hue, keep saturation high and lightness balanced
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 80%, 50%)`;
  }

  setMode(mode, options = {}) {
    this.mode = mode;
    if (options.coneAngle !== undefined) {
      this.coneAngle = this.normalizeConeAngle(options.coneAngle);
    }
    const container = this.engine.stage.container();

    if (mode !== 'none') {
      container.style.cursor = 'crosshair';
      this.engine.stage.draggable(false);
    } else {
      container.style.cursor = 'default';
      // Restore dragging if wall mode isn't active
      this.engine.stage.draggable(!this.engine.wallManager?.isWallMode);
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

  normalizeConeAngle(angle) {
    const parsedAngle = Number(angle);
    return Number.isFinite(parsedAngle) ? Math.min(359, Math.max(1, parsedAngle)) : 53;
  }

  getMeasureOptions(mode) {
    return mode === 'cone' ? { coneAngle: this.coneAngle } : {};
  }

  initEvents() {
    const stage = this.engine.stage;

    stage.on('mousedown', (e) => {
      if (this.mode === 'none' || e.evt.button !== 0) return;
      const startPos = this.getSnappedPointerPosition();
      if (!startPos) return;

      this.isDrawing = true;
      this.startPos = startPos;

      this.localGroup = this.createMeasureGroup(
        this.startPos,
        this.startPos,
        this.mode,
        this.userColor,
        this.getMeasureOptions(this.mode)
      );
      this.layer.add(this.localGroup);
      this.layer.batchDraw();

      this.broadcast('start', this.startPos, this.startPos, this.mode);
    });

    stage.on('mousemove', () => {
      if (!this.isDrawing) return;
      const currentPos = this.getSnappedPointerPosition();
      if (!currentPos) return;

      this.updateMeasureGroup(
        this.localGroup,
        this.startPos,
        currentPos,
        this.mode,
        this.getMeasureOptions(this.mode)
      );
      this.layer.batchDraw();

      this.broadcast('update', this.startPos, currentPos, this.mode);
    });

    stage.on('mouseup mouseleave', () => {
      if (!this.isDrawing) return;
      this.isDrawing = false;

      if (this.localGroup) {
        this.localGroup.destroy();
        this.localGroup = null;
      }
      this.layer.batchDraw();

      this.broadcast('end', null, null, this.mode);
    });
  }

  broadcast(action, start, current, mode) {
    this.engine.stage.fire('measureAction', {
      userId: this.engine.currentUserId,
      action: action,     // 'start', 'update', or 'end'
      measureType: mode,
      ...this.getMeasureOptions(mode),
      color: this.userColor,
      start: start,
      current: current
    });
  }

  createMeasureGroup(start, current, type, color, options = {}) {
    const group = new Konva.Group();
    let shape;

    if (type === 'line') {
      shape = new Konva.Line({
        points: [start.x, start.y, current.x, current.y],
        stroke: color,
        strokeWidth: 3,
        dash: [10, 5],
        lineCap: 'round'
      });
    } else if (type === 'cone') {
      const coneAngle = this.normalizeConeAngle(options.coneAngle ?? this.coneAngle);
      shape = new Konva.Wedge({
        x: start.x,
        y: start.y,
        radius: 0,
        angle: coneAngle,
        rotation: -coneAngle / 2,
        stroke: color,
        strokeWidth: 2,
        fill: color,
        opacity: 0.2
      });
    } else {
      shape = new Konva.Circle({
        x: start.x, y: start.y,
        radius: 0,
        stroke: color,
        strokeWidth: 2,
        fill: color,
        opacity: 0.2
      });
    }

    const label = new Konva.Label({ x: current.x, y: current.y });
    label.add(new Konva.Tag({ fill: 'black', cornerRadius: 4 }));
    label.add(new Konva.Text({ text: '0 ft', fill: 'white', padding: 5, fontSize: 14 }));

    group.add(shape);
    group.add(label);

    // Save references directly on the group so the update function can find them
    group.measureShape = shape;
    group.measureLabel = label;
    group.measureOptions = options;

    return group;
  }

  updateMeasureGroup(group, start, current, type, options = {}) {
    if (!group || !group.measureShape || !group.measureLabel) return;

    const dx = current.x - start.x;
    const dy = current.y - start.y;
    const rawDistancePx = Math.sqrt(dx * dx + dy * dy);
    const distancePx = this.engine.snapDistanceToGrid?.(rawDistancePx) ?? rawDistancePx;
    const ft = this.engine.getGridDistanceFeet?.(rawDistancePx) ?? Math.round((distancePx / this.engine.gridSize) * 5);

    // Update text
    group.measureLabel.getText().text(`${ft} ft`);

    if (type === 'line') {
      group.measureShape.points([start.x, start.y, current.x, current.y]);
      group.measureLabel.position({ x: current.x, y: current.y - 20 });
    } else if (type === 'cone') {
      const coneAngle = this.normalizeConeAngle(options.coneAngle ?? group.measureOptions?.coneAngle ?? this.coneAngle);
      const directionDegrees = Math.atan2(dy, dx) * 180 / Math.PI;

      group.measureShape.position({ x: start.x, y: start.y });
      group.measureShape.radius(distancePx);
      group.measureShape.angle(coneAngle);
      group.measureShape.rotation(directionDegrees - coneAngle / 2);
      group.measureLabel.getText().text(`${ft} ft / ${coneAngle} deg`);
      group.measureLabel.position({ x: current.x, y: current.y - 20 });
    } else {
      group.measureShape.radius(distancePx);
      group.measureLabel.position({ x: start.x, y: start.y - distancePx - 20 });
    }
  }

  handleRemoteAction(data) {
    const userId = data.userId;
    console.log(!!userId);
    if (!userId) return;

    if (data.action === 'start') {
      if (this.remoteMeasures[userId]) this.remoteMeasures[userId].destroy();

      // Use data.measureType here
      const group = this.createMeasureGroup(data.start, data.current, data.measureType, data.color, {
        coneAngle: data.coneAngle
      });
      this.remoteMeasures[userId] = group;
      this.layer.add(group);
      this.layer.batchDraw();
    }
    else if (data.action === 'update' && this.remoteMeasures[userId]) {
      // Use data.measureType here
      this.updateMeasureGroup(this.remoteMeasures[userId], data.start, data.current, data.measureType, {
        coneAngle: data.coneAngle
      });
      this.layer.batchDraw();
    }
    else if (data.action === 'end' && this.remoteMeasures[userId]) {
      this.remoteMeasures[userId].destroy();
      delete this.remoteMeasures[userId];
      this.layer.batchDraw();
    }
  }
}
