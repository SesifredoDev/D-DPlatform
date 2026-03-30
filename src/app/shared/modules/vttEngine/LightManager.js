import Konva from 'konva';

export class LightingManager {
    constructor(engine) {
        this.engine = engine;
        this.layer = engine.lightLayer;
    }

  update() {
    this.layer.destroyChildren();
    let opacity = 1;
    if(this.engine.isDM){
      opacity = 0.7
    }
    const darkness = new Konva.Rect({
      x: 0, y: 0,
      width: this.engine.currentMapW,
      height: this.engine.currentMapH,
      fill: 'black',
      opacity
    });


    this.layer.add(darkness);

    const walls = this.engine.wallManager.getLinesForRaycasting();
    const playerVisionPolygons = [];

    // 1. Carve vision ONLY for Players
    this.engine.tokenLayer.getChildren().forEach(tokenGroup => {
      const token = tokenGroup.tokenReference;

      if (token && token.isPlayer) {
        const points = this.calculateVisibility(tokenGroup.x(), tokenGroup.y(), walls);
        playerVisionPolygons.push(points);

        const visionHole = new Konva.Line({
          points: points,
          fill: 'white',
          closed: true,
          globalCompositeOperation: 'destination-out'
        });
        this.layer.add(visionHole);
      }
    });

    // 2. Hide/Show NPCs based on vision polygons
    this.engine.tokenLayer.getChildren().forEach(tokenGroup => {
      const token = tokenGroup.tokenReference;
      if (token && !token.isPlayer) {
        const isVisible = playerVisionPolygons.some(polyPoints =>
          this.isPointInPolygon(tokenGroup.x(), tokenGroup.y(), polyPoints)
        );
        token.setVisibility(isVisible);
      }
    });

    this.layer.batchDraw();
    this.engine.tokenLayer.batchDraw();
  }

    calculateVisibility(x, y, walls) {
        const radius = 2000;
        const points = [];
        const angles = new Set();

        walls.forEach(w => {
            // Calculate angles to both ends of the wall
            const a1 = Math.atan2(w[1] - y, w[0] - x);
            const a2 = Math.atan2(w[3] - y, w[2] - x);

            // THE FIX: Add the angle AND tiny offsets
            // This forces the raycaster to see just past the corner and just inside it
            [a1, a2].forEach(a => {
                angles.add(a);
                angles.add(a - 0.0001);
                angles.add(a + 0.0001);
            });
        });

        // Sort angles to draw the polygon correctly
        const sortedAngles = Array.from(angles).sort((a, b) => a - b);

        sortedAngles.forEach(angle => {
            const dx = Math.cos(angle) * radius;
            const dy = Math.sin(angle) * radius;

            let closest = { x: x + dx, y: y + dy, dist: 1 };

            walls.forEach(w => {
                const intersect = this.getIntersection(x, y, x + dx, y + dy, w[0], w[1], w[2], w[3]);
                if (intersect && intersect.dist < closest.dist) {
                    closest = intersect;
                }
            });
            points.push(closest.x, closest.y);
        });

        return points;
    }

    isPointInPolygon(x, y, points) {
      let inside = false;
      for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
        const xi = points[i], yi = points[i + 1];
        const xj = points[j], yj = points[j + 1];
        const intersect = ((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }

    getIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
        const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (den === 0) return null;
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) {
            return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), dist: t };
        }
        return null;
    }
}
