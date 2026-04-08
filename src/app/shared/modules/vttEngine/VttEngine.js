import Konva from 'konva';
import Token from './Token.js';
import { WallManager} from "./WallManager.js";
import { LightingManager } from './LightManager.js';
import {MeasurementManager} from "./MeasurementManagement";

export class VttEngine {
  constructor(containerId, currentUserId, gridSize = 50) {
    this.gridSize = gridSize;
    this.currentMapW = 1000;
    this.currentMapH = 1000;
    this.currentMapUrl = null;
    this.containerId = containerId;
    this.localCharacter = null;
    this.currentUserId= currentUserId;

    this.isDM = false
    this.stage = new Konva.Stage({
      container: containerId,
      width: containerId.getBoundingClientRect().width,
      height: containerId.getBoundingClientRect().height,
      draggable: true
    });

    this.mapLayer = new Konva.Layer();
    this.gridLayer = new Konva.Layer();
    this.wallLayer = new Konva.Layer({ visible: false });
    this.tokenLayer = new Konva.Layer();
    this.overlayLayer = new Konva.Layer({ listening: false }); // Layer for pings and temp effects

    this.lightLayer = new Konva.Layer({
      opacity: 1,
      visible: false,
      listening: false
    });
    this.stage.add(this.mapLayer, this.gridLayer, this.wallLayer, this.tokenLayer, this.lightLayer, this.overlayLayer);

    this.lightingManager = new LightingManager(this);
    this.wallManager = new WallManager(this);
    this.measurementManager = new MeasurementManager(this);

    this.initDefaultMap();
    this.initZoom();
    this.initInteraction();
  }

  setContainer(container) {
    this.containerId = container;
    this.stage.container(container);
    this.stage.width(container.getBoundingClientRect().width);
    this.stage.height(container.getBoundingClientRect().height);
    this.stage.batchDraw();
  }

  initInteraction() {
    this.stage.on('dblclick dbltap', (e) => {
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
  }

  clearAll() {
    this.tokenLayer.destroyChildren();
    this.overlayLayer.destroyChildren();
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
    this.gridSize = parseInt(newSize);

    // 1. Redraw the background grid lines
    this.drawGrid(this.currentMapW, this.currentMapH);

    // 2. Rescale and reposition all existing tokens
    this.tokenLayer.getChildren().forEach(group => {
      const token = group.tokenReference;
      if (token) {
        token.initVisuals();
        token.snapToGrid();
      }
    });

    this.tokenLayer.batchDraw();
    this.updateLighting();

    // 3. BROADCAST: Tell the sync service to notify other players
    if (!remote) {
      this.stage.fire('gridSizeChanged', { size: this.gridSize });
    }
  }

  drawGrid(width, height) {
    this.gridLayer.destroyChildren();
    for (let i = 0; i <= width / this.gridSize; i++) {
      this.gridLayer.add(new Konva.Line({
        points: [i * this.gridSize, 0, i * this.gridSize, height],
        stroke: '#ccc', strokeWidth: 1,
      }));
    }
    for (let j = 0; j <= height / this.gridSize; j++) {
      this.gridLayer.add(new Konva.Line({
        points: [0, j * this.gridSize, width, j * this.gridSize],
        stroke: '#ccc', strokeWidth: 1,
      }));
    }
    this.gridLayer.batchDraw();

    this.updateLighting();
  }

  centerMap() {
    const mapObj = this.mapLayer.children[0];
    if (!mapObj) return;

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

      const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
      this.stage.scale({ x: newScale, y: newScale });

      const newPos = {
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      };
      this.stage.position(newPos);
      this.stage.batchDraw();
    });
  }

  addToken(x, y, options = {}, remote = false) {
    // 1. Check if token already exists to prevent duplicates
    const existingGroup = this.tokenLayer.findOne('#' + options.id);
    if (existingGroup) {
      if (remote) {
        const token = existingGroup.tokenReference;
        if (token) {
          token.updateConfig(options);
          // Only update position if x,y are provided and non-zero
          if (x || y) {
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
    const existingGroup = this.tokenLayer.findOne('#' + tokenId);
    if (existingGroup) {
      const token = existingGroup.tokenReference;
      if (token) {
        token.updateConfig(options);
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
      borderColor: token.borderColor
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

      if (config.mapUrl) {
        // ADD "true" as the second argument here to prevent redundant broadcasts
        this.setBackground(config.mapUrl, true);
        this.currentMapUrl = config.mapUrl;
      } else {
        this.initDefaultMap();
      }

      if (config.gridSize) {
        this.gridSize = config.gridSize;
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

      this.stage.batchDraw();
    } catch (e) {
      console.error("Failed to load config object", e);
    }
  }

  setMeasurementMode(mode) {
    if (mode !== 'none') this.wallManager.setMode('none');
    this.measurementManager.setMode(mode);
  }

  updateLighting() {
    this.lightingManager.update();
  }
}
