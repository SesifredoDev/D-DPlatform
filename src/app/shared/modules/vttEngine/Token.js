
import Konva from 'konva';

const TOKEN_IMAGE_CACHE = new Map();

class Token {
  constructor(x, y, engine, options = {}) {
    this.engine = engine;
    this.color = options.color || Konva.Util.getRandomColor();
    this.name = options.name || "Hero";
    this.id = options.id || crypto.randomUUID();
    this.isPlayer = options.isPlayer !== undefined ? !!options.isPlayer : !!options.ownerId;

    // NEW: Track ownership and image
    this.ownerId = options.ownerId || null;
    this.imageUrl = this.normalizeImageUrl(options.icon);
    this.notes = this.normalizeNotes(options.notes);
    this.maxHealth = this.normalizeHealthValue(options.maxHealth);
    this.currentHealth = this.normalizeHealthValue(options.currentHealth);
    this.effects = this.normalizeEffects(options.effects);

    // Token configuration for size and borders
    this.size = this.normalizeSize(options.size); // 0.5, 1, 2, 3
    this.forceBorder = !!options.forceBorder;
    this.borderColor = options.borderColor || 'white';
    this.visualRenderId = 0;

    this.group = new Konva.Group({
      id: this.id,
      x: x,
      y: y,
      draggable: this.canDrag()
    });

    this.group.tokenReference = this;
    this.initVisuals();
    this.initEvents();
  }

  checkPermissions() {
    const isDM = this.engine.isDM;
    const currentUserId = this.engine.currentUserId;
    return isDM ||
      (this.isPlayer && this.engine.playersCanControlAllPlayerTokens) ||
      (this.ownerId === currentUserId);
  }

  canDrag() {
    return this.checkPermissions() && !this.engine.isMeasuring?.();
  }

  async initVisuals() {
    const renderId = ++this.visualRenderId;
    this.group.destroyChildren();
    const radius = this.getVisualRadius();
    const requestedImageUrl = this.normalizeImageUrl(this.imageUrl);

    this.renderFallback(radius);
    this.group.getLayer()?.batchDraw();

    if (!requestedImageUrl) {
      return;
    }

    const img = await this.loadImage(requestedImageUrl);

    if (
      renderId !== this.visualRenderId ||
      this.isGroupDestroyed() ||
      requestedImageUrl !== this.normalizeImageUrl(this.imageUrl)
    ) {
      return;
    }

    if (!img?.width || !img?.height) {
      return;
    }

    this.group.destroyChildren();
    this.renderImage(img, radius);
    this.group.getLayer()?.batchDraw();
  }

  updateConfig(config, emitMove = true) {
    if (config.name !== undefined) this.name = config.name;
    if (config.icon !== undefined) this.imageUrl = this.normalizeImageUrl(config.icon);
    if (config.size !== undefined) this.size = this.normalizeSize(config.size);
    if (config.forceBorder !== undefined) this.forceBorder = !!config.forceBorder;
    if (config.borderColor !== undefined) this.borderColor = config.borderColor;
    if (config.color !== undefined) this.color = config.color;
    if (config.ownerId !== undefined) this.ownerId = config.ownerId;
    if (config.isPlayer !== undefined) this.isPlayer = !!config.isPlayer;
    if (config.notes !== undefined) this.notes = this.normalizeNotes(config.notes);
    if (config.maxHealth !== undefined) this.maxHealth = this.normalizeHealthValue(config.maxHealth);
    if (config.currentHealth !== undefined) this.currentHealth = this.normalizeHealthValue(config.currentHealth);
    if (config.effects !== undefined) this.effects = this.normalizeEffects(config.effects);

    if (this.currentHealth !== null && this.maxHealth !== null) {
      this.currentHealth = Math.min(this.currentHealth, this.maxHealth);
    }

    this.initVisuals();
    this.group.draggable(this.canDrag());
    this.snapToGrid(emitMove);
  }

  normalizeImageUrl(url) {
    if (typeof url !== 'string') return null;

    const trimmedUrl = url.trim();
    return trimmedUrl ? trimmedUrl : null;
  }

  normalizeSize(size) {
    const parsedSize = Number(size);
    return Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 1;
  }

  normalizeNotes(notes) {
    return typeof notes === 'string' ? notes : '';
  }

  normalizeHealthValue(value) {
    if (value === null || value === undefined || value === '') return null;

    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? Math.max(0, Math.round(parsedValue)) : null;
  }

  normalizeEffects(effects) {
    if (!Array.isArray(effects)) return [];

    return effects
      .map((effect, index) => {
        const name = typeof effect === 'string'
          ? effect.trim()
          : typeof effect?.name === 'string'
            ? effect.name.trim()
            : '';

        if (!name) return null;

        const id = typeof effect?.id === 'string' && effect.id.trim()
          ? effect.id.trim()
          : crypto.randomUUID();

        return {
          id,
          name,
          color: this.normalizeEffectColor(effect?.color, index)
        };
      })
      .filter(Boolean)
      .slice(0, 12);
  }

  normalizeEffectColor(color, index = 0) {
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim())) {
      return color.trim().toLowerCase();
    }

    const fallbackColors = ['#f44336', '#ff9800', '#ffeb3b', '#4caf50', '#2196f3', '#9c27b0'];
    return fallbackColors[index % fallbackColors.length];
  }

  getVisualRadius() {
    return Math.max(4, (this.engine.gridSize * this.size) / 2.2);
  }

  renderFallback(radius) {
    this.group.add(new Konva.Circle({
      x: 0,
      y: 0,
      radius,
      fill: this.color || 'grey'
    }));
    this.renderBorder(radius);
    this.renderEffectMarkers(radius);
  }

  renderImage(img, radius) {
    const diameter = radius * 2;
    const imageScale = Math.max(diameter / img.width, diameter / img.height);
    const width = img.width * imageScale;
    const height = img.height * imageScale;

    const imageClip = new Konva.Group({
      clipFunc: (ctx) => {
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2, false);
        ctx.closePath();
      }
    });

    imageClip.add(new Konva.Image({
      image: img,
      x: -width / 2,
      y: -height / 2,
      width,
      height
    }));

    this.group.add(imageClip);
    this.renderBorder(radius);
    this.renderEffectMarkers(radius);
  }

  renderBorder(radius) {
    if (!this.forceBorder) return;

    this.group.add(new Konva.Circle({
      x: 0,
      y: 0,
      radius,
      stroke: this.borderColor || 'white',
      strokeWidth: 4,
      fillEnabled: false,
      listening: false
    }));
  }

  renderEffectMarkers(radius) {
    if (!this.engine.isDM || !this.effects?.length) return;

    const dotRadius = Math.max(4, Math.min(7, radius * 0.14));
    const spacing = (dotRadius * 2) + 3;
    const maxFit = Math.max(1, Math.floor(((radius * 2) - 6) / spacing));
    const visibleEffects = this.effects.slice(0, Math.min(6, maxFit));
    const startX = -((visibleEffects.length - 1) * spacing) / 2;
    const y = radius - dotRadius - 3;

    visibleEffects.forEach((effect, index) => {
      this.group.add(new Konva.Circle({
        x: startX + (index * spacing),
        y,
        radius: dotRadius,
        fill: this.normalizeEffectColor(effect.color, index),
        stroke: '#111827',
        strokeWidth: 2,
        shadowColor: 'rgba(0,0,0,0.55)',
        shadowBlur: 4,
        shadowOffset: { x: 0, y: 1 },
        shadowOpacity: 1,
        listening: false
      }));
    });
  }

  isGroupDestroyed() {
    return typeof this.group?.isDestroyed === 'function' && this.group.isDestroyed();
  }

  loadImage(url) {
    const imageUrl = this.normalizeImageUrl(url);
    if (!imageUrl) {
      return Promise.resolve(null);
    }

    if (TOKEN_IMAGE_CACHE.has(imageUrl)) {
      return TOKEN_IMAGE_CACHE.get(imageUrl);
    }

    const imageLoad = new Promise((resolve) => {
      const img = new Image();

      // Do not set crossOrigin here; the app serves uploaded files through its own proxy.
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => {
        TOKEN_IMAGE_CACHE.delete(imageUrl);
        console.warn('Image failed to load:', imageUrl);
        resolve(null);
      };

      img.src = imageUrl;
    });

    TOKEN_IMAGE_CACHE.set(imageUrl, imageLoad);
    return imageLoad;
  }

  setVisibility(isVisible) {
    if (this.isPlayer) {
      this.group.opacity(1);
    } else {
      this.group.opacity(isVisible ? 1 : 0.6);
    }
  }

  snapToGrid(emitMove = true) {
    const { x: centerX, y: centerY } = this.engine.getSnapPosition(
      this.group.x(),
      this.group.y(),
      this.size
    );

    this.group.position({ x: centerX, y: centerY });
    this.engine.updateLighting();
    this.group.getLayer()?.batchDraw();

    if (emitMove) {
      this.engine.stage.fire('tokenMoved', {
        id: this.group.id(),
        x: centerX,
        y: centerY
      });
    }
  }

  initEvents() {
    this.group.on('dragmove', () => {
      this.engine.updateLighting(); //
    });

    this.group.on('dragend', () => {
      const size = this.engine.gridSize; //

      const tileX = Math.floor(this.group.x() / size); //
      const tileY = Math.floor(this.group.y() / size); //

      const { x: centerX, y: centerY } = this.engine.getSnapPosition(
        this.group.x(),
        this.group.y(),
        this.size
      );

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
      if (!this.engine.isDM) return;

      this.engine.stage.fire('tokenContextMenu', {
        token: this,
        evt: e.evt
      });
    });
  }
}

export default Token;
