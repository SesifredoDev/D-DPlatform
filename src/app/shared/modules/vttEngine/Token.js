// src/app/shared/modules/vttEngine/Token.js
import Konva from 'konva';

// noinspection JSAnnotator
class Token {
  constructor(x, y, engine, options = {}) {
    this.engine = engine;
    this.color = options.color || Konva.Util.getRandomColor();
    this.name = options.name || "Hero";
    this.id = options.id || crypto.randomUUID();
    this.isPlayer = !!options.ownerId || false;

    // NEW: Track ownership and image
    this.ownerId = options.ownerId || null;
    this.imageUrl = options.icon || null;

    // Token configuration for size and borders
    this.size = options.size || 1; // 0.5, 1, 2, 3
    this.forceBorder = options.forceBorder || false;
    this.borderColor = options.borderColor || 'white';

    this.group = new Konva.Group({
      id: this.id,
      x: x,
      y: y,
      draggable: this.checkPermissions()
    });

    this.group.tokenReference = this;
    this.initVisuals();
    this.initEvents();
  }

  checkPermissions() {
    const isDM = this.engine.isDM; // Assuming engine tracks if user is host
    const currentUserId = this.engine.currentUserId; // You'll need to pass this to the engine
    return isDM || (this.ownerId === currentUserId);
  }

  async initVisuals() {
    this.group.destroyChildren();
    const gridSize = this.engine.gridSize;
    const size = gridSize * this.size;
    const radius = size / 2.2;

    const baseConfig = {
      x: 0,
      y: 0,
      radius,
      stroke: this.forceBorder ? this.borderColor : 'none',
      strokeWidth: this.forceBorder ? 4 : 2,
    };

    let circle;

    if (this.imageUrl) {
      const img = await this.loadImage(this.imageUrl);

      if (img && img.width && img.height) {
        // Use REAL image dimensions instead of hardcoded 150
        const scale = (size / 1.1) / img.width;

        circle = new Konva.Circle({
          ...baseConfig,
          fillPatternImage: img,
          fillPatternRepeat: 'no-repeat',
          fillPatternScaleX: scale,
          fillPatternScaleY: scale,
          fillPatternOffset: {
            x: img.width / 2,
            y: img.height / 2,
          },
        });
      } else {
        // Fallback if image fails
        circle = new Konva.Circle({
          ...baseConfig,
          fill: this.color || 'grey',
        });
      }
    } else {
      circle = new Konva.Circle({
        ...baseConfig,
        fill: this.color || 'grey',
      });
    }

    this.group.add(circle);
    //
    // // Text label
    // const text = new Konva.Text({
    //   text: this.name,
    //   fontSize: 12 * Math.max(1, this.size),
    //   fill: 'white',
    //   width: size,
    //   x: -size / 2,
    //   y: size / 2 + 2,
    //   align: 'center',
    // });
    //
    // this.group.add(text);
    this.group.getLayer()?.batchDraw();
  }

  updateConfig(config) {
    if (config.name !== undefined) this.name = config.name;
    if (config.icon !== undefined) this.imageUrl = config.icon;
    if (config.size !== undefined) this.size = config.size;
    if (config.forceBorder !== undefined) this.forceBorder = config.forceBorder;
    if (config.borderColor !== undefined) this.borderColor = config.borderColor;
    if (config.color !== undefined) this.color = config.color;

    this.initVisuals();
    this.snapToGrid();
  }

  loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();

      // IMPORTANT: do not set crossOrigin (your note is correct)
      img.onload = () => resolve(img);
      img.onerror = () => {
        console.warn('Image failed to load:', url);
        resolve(null);
      };

      img.src = url;
    });
  }

  setVisibility(isVisible) {
    if (this.isPlayer) {
      this.group.opacity(1);
    } else {
      this.group.opacity(isVisible ? 1 : 0.6);
    }
  }

  snapToGrid() {
    const size = this.engine.gridSize;

    // For multi-tile tokens, we might want to snap differently,
    // but standard behavior is snapping the center to a grid intersection or center.
    // If size is 1, it snaps to center of tile.
    // If size is 2, it snaps to grid intersection (between 4 tiles).
    // Let's use a simpler approach for now: snap based on size.

    let centerX, centerY;
    if (this.size % 2 === 0) {
      // Even sizes snap to grid intersections
      centerX = Math.round(this.group.x() / size) * size;
      centerY = Math.round(this.group.y() / size) * size;
    } else if (this.size === 0.5) {
       // Small tokens snap to quarter tiles? Let's just snap to tile centers for now.
       const tileX = Math.floor(this.group.x() / size);
       const tileY = Math.floor(this.group.y() / size);
       centerX = (tileX * size) + (size / 2);
       centerY = (tileY * size) + (size / 2);
    } else {
      // Odd sizes snap to tile centers
      const tileX = Math.floor(this.group.x() / size);
      const tileY = Math.floor(this.group.y() / size);
      centerX = (tileX * size) + (size / 2);
      centerY = (tileY * size) + (size / 2);
    }

    this.group.position({ x: centerX, y: centerY });
    this.engine.updateLighting();
    this.group.getLayer()?.batchDraw();

    this.engine.stage.fire('tokenMoved', {
      id: this.group.id(),
      x: centerX,
      y: centerY
    });
  }

  initEvents() {
    this.group.on('dragmove', () => {
      this.engine.updateLighting();
    });

    this.group.on('dragend', () => {
      this.snapToGrid();
    });

    this.group.on('contextmenu', (e) => {
      e.evt.preventDefault();
      this.engine.stage.fire('tokenContextMenu', {
        token: this,
        evt: e.evt
      });
    });
  }
}

export default Token;
