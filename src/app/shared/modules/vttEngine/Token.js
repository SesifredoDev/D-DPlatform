
import Konva from 'konva';

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
    const isDM = this.engine.isDM;
    const currentUserId = this.engine.currentUserId;
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

    let centerX, centerY;
    if (this.size % 2 === 0) {
      centerX = Math.round(this.group.x() / size) * size;
      centerY = Math.round(this.group.y() / size) * size;
    } else if (this.size === 0.5) {
       // Small tokens snap to quarter tiles
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
      this.engine.updateLighting(); //
    });

    this.group.on('dragend', () => {
      const size = this.engine.gridSize; //

      const tileX = Math.floor(this.group.x() / size); //
      const tileY = Math.floor(this.group.y() / size); //

      const centerX = (tileX * size) + (size / 2); //
      const centerY = (tileY * size) + (size / 2); //

      this.group.position({ x: centerX, y: centerY }); //
      this.engine.updateLighting(); //

      this.group.getLayer().batchDraw(); //

      console.log(`${this.name} snapped to center of tile [${tileX}, ${tileY}]`); //

      this.engine.stage.fire('tokenMoved', {
        id: this.group.id(),
        x: centerX,
        y: centerY
      });
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
