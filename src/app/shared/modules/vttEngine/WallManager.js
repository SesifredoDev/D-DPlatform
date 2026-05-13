import Konva from 'konva';

export class WallManager {
  constructor(engine) {
    this.engine = engine;
    this.layer = engine.wallLayer;
    this.isWallMode = false;
    this.isDeleteMode = false;
    this.activeLine = null;

    // Bind keyboard events to the window
    this.handleKeyDown = this.handleKeyDown.bind(this);
    window.addEventListener('keydown', this.handleKeyDown);

    this.initEvents();
  }

  setMode(mode) {
    this.isWallMode = (mode === 'draw');
    this.isDeleteMode = (mode === 'delete');

    // Toggle visibility and stage interactivity
    this.layer.visible(this.isWallMode || this.isDeleteMode);
    this.engine.stage.draggable(!this.isWallMode && !this.isDeleteMode);

    // UI Feedback via cursor
    const container = this.engine.stage.container();
    if (this.isDeleteMode) {
      container.style.cursor = 'crosshair';
    } else if (this.isWallMode) {
      container.style.cursor = 'cell';
    } else {
      container.style.cursor = 'default';
    }

    this.stopCurrentWall();
    this.layer.batchDraw();
  }

  handleKeyDown(e) {
    if (e.key === 'Escape' && this.activeLine) {
      this.cancelCurrentWall();
    }
  }

  initEvents() {
    const stage = this.engine.stage;

    stage.on('mousedown', (e) => {
      // --- DELETE LOGIC ---
      if (this.isDeleteMode) {
        const shape = e.target;
        if (shape.name() === 'wall-segment' && typeof shape.points === 'function') {
          const wallPoints = shape.points(); // Capture coordinates

          shape.destroy(); // Remove from local stage
          this.layer.batchDraw();
          this.engine.updateLighting();

          // Emit the specific points so other clients can find it
          this.engine.stage.fire('wallDeleted', { points: wallPoints });
        }
        return;
      }

      // --- DRAW LOGIC ---
      if (!this.isWallMode) return;

      // Right click (button 2) finishes the wall
      if (e.evt.button === 2) {
        this.stopCurrentWall();
        return;
      }

      // Left click (button 0) adds/starts a point
      if (e.evt.button === 0) {
        const pos = this.getRelativePointerPosition();

        if (!this.activeLine) {
          // Start new line
          this.activeLine = new Konva.Line({
            points: [pos.x, pos.y, pos.x, pos.y],
            stroke: '#4a90e2', // Blue while drawing
            strokeWidth: 3,
            lineCap: 'round',
            lineJoin: 'round',
            name: 'wall-segment',
            hitStrokeWidth: 15 // Invisible area for easier clicking/deleting
          });
          this.layer.add(this.activeLine);
        } else {
          // Add point to existing line
          const points = this.activeLine.points();
          this.activeLine.points([...points, pos.x, pos.y]);
        }
        this.layer.batchDraw();
      }
    });

    stage.on('mousemove', () => {
      if (!this.isWallMode || !this.activeLine) return;

      const pos = this.getRelativePointerPosition();
      const points = this.activeLine.points();

      // Update the very last point to follow the cursor (the "ghost" segment)
      points[points.length - 2] = pos.x;
      points[points.length - 1] = pos.y;

      this.activeLine.points(points);
      this.layer.batchDraw();
    });

    // Prevent context menu from appearing when right-clicking to finish a wall
    stage.container().addEventListener('contextmenu', (e) => {
      if (this.isWallMode) e.preventDefault();
    });
  }

  getRelativePointerPosition() {
    // Corrects for stage zoom and panning
    const transform = this.engine.stage.getAbsoluteTransform().copy().invert();
    return transform.point(this.engine.stage.getPointerPosition());
  }

  stopCurrentWall() {
    if (this.activeLine) {
      const points = this.activeLine.points();
      // Remove the "ghost" point that was following the mouse
      const finalPoints = points.slice(0, -2);
      let wallWasCreated = false;

      if (finalPoints.length < 4) {
        this.activeLine.destroy();
      } else {
        this.activeLine.points(finalPoints);
        this.activeLine.stroke('#888'); // Change back to standard wall color
        wallWasCreated = true;
      }

      this.activeLine = null;
      this.engine.updateLighting();
      this.layer.batchDraw();
      if (wallWasCreated) {
        this.engine.stage.fire('wallAdded', { points: finalPoints });
      }
    }
  }

  cancelCurrentWall() {
    if (this.activeLine) {
      this.activeLine.destroy();
      this.activeLine = null;
      this.layer.batchDraw();
    }
  }


  addSingleWall(points) {
    const line = new Konva.Line({
      points: points,
      stroke: '#888',
      strokeWidth: 3,
      lineCap: 'round',
      lineJoin: 'round',
      name: 'wall-segment',
      hitStrokeWidth: 15
    });
    this.layer.add(line);
    this.engine.updateLighting();
    this.layer.batchDraw();
  }

  deleteWallByPoints(points) {
    const wallStr = JSON.stringify(points);
    // Find the specific line that matches these coordinates
    const wallToDelete = this.layer.getChildren().find(line =>
      JSON.stringify(line.points()) === wallStr
    );

    if (wallToDelete) {
      wallToDelete.destroy();
      this.engine.updateLighting();
      this.layer.batchDraw();
    }
  }

  clearAll() {
      this.layer.destroyChildren();
      this.layer.batchDraw();
      this.engine.updateLighting();
  }

  getWallsData() {
    return this.layer.getChildren().map(line => line.points());
  }

  loadWalls(wallsData) {
    this.layer.destroyChildren();
    if (!wallsData) return;

    wallsData.forEach(points => {
      const line = new Konva.Line({
        points: points,
        stroke: '#888',
        strokeWidth: 3,
        lineCap: 'round',
        lineJoin: 'round',
        name: 'wall-segment',
        hitStrokeWidth: 15
      });
      this.layer.add(line);
    });
    this.layer.batchDraw();
    this.engine.updateLighting();
  }

  getLinesForRaycasting() {
    const lines = [];
    // Map Boundaries
    const w = this.engine.currentMapW;
    const h = this.engine.currentMapH;
    lines.push([0, 0, w, 0], [w, 0, w, h], [w, h, 0, h], [0, h, 0, 0]);

    // User Walls
    this.layer.getChildren().forEach(line => {
      const points = line.points();
      for (let i = 0; i < points.length - 2; i += 2) {
        lines.push([points[i], points[i+1], points[i+2], points[i+3]]);
      }
    });
    return lines;
  }
}
