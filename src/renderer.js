import { rotateVector } from './motion.js';
import { createDotGrid, sampleSurface } from './surface.js';
import { sampleCloudCover } from './clouds.js';
import { revealOpacity } from './reveal.js';

const TAU = Math.PI * 2;

/**
 * A fixed screen-space dot display. Rotation only changes the RGB sampled for
 * each dot: neither its path, position, nor radius depends on orientation.
 */
export class GlobeRenderer {
  constructor(canvas, surface, clouds = null) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true });
    if (!this.context) throw new Error('Canvas 2D is unavailable');
    if (
      !Number.isInteger(surface.width) ||
      !Number.isInteger(surface.height) ||
      surface.width <= 0 ||
      surface.height <= 0 ||
      surface.pixels?.length !== surface.width * surface.height * 4
    ) {
      throw new Error('Invalid surface image');
    }
    this.surface = surface;
    this.clouds = clouds;
    this.showClouds = true;
    this.showGrid = false;
    this.width = 0;
    this.height = 0;
    this.radius = 0;
    this.dotRadius = 0;
    this.pixelRatio = 0;
    this.dots = [];
    this.dotPaths = [];
    this.colorCache = new Array(32768);
    this.sample = new Float64Array(3);
    this.resize();
  }

  resize() {
    const { width, height } = this.canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const layoutChanged = this.width !== width || this.height !== height;
    if (!layoutChanged && this.pixelRatio === pixelRatio) return;
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.canvas.width = Math.round(width * pixelRatio);
    this.canvas.height = Math.round(height * pixelRatio);
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (layoutChanged) {
      const grid = createDotGrid(width, height);
      this.radius = grid.radius;
      this.dotRadius = grid.dotRadius;
      this.dots = grid.dots;
      // Construct the exact diamonds once. Every animation frame fills these
      // same paths; no moving positions or size animation can be introduced.
      this.dotPaths = this.dots.map((dot) => {
        const path = new Path2D();
        path.moveTo(dot.x, dot.y - this.dotRadius);
        path.lineTo(dot.x + this.dotRadius, dot.y);
        path.lineTo(dot.x, dot.y + this.dotRadius);
        path.lineTo(dot.x - this.dotRadius, dot.y);
        path.closePath();
        return path;
      });
      this.canvas.dataset.pointCount = String(this.dots.length);
    }
  }

  draw(orientation, reveal = null) {
    this.resize();
    const ctx = this.context;
    const r = this.radius;
    const cx = this.width / 2;
    const cy = this.height / 2;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!r) return;

    const halo = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    halo.addColorStop(0, 'rgba(178,203,199,0.025)');
    halo.addColorStop(1, 'rgba(178,203,199,0.12)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();

    const [qx, qy, qz, qw] = orientation;
    // Transpose of the forward rotation matrix: each screen dot asks which
    // unrotated geographic point is currently facing its fixed normal.
    const inverse = [
      1 - 2 * (qy * qy + qz * qz),
      2 * (qx * qy + qz * qw),
      2 * (qx * qz - qy * qw),
      2 * (qx * qy - qz * qw),
      1 - 2 * (qx * qx + qz * qz),
      2 * (qy * qz + qx * qw),
      2 * (qx * qz + qy * qw),
      2 * (qy * qz - qx * qw),
      1 - 2 * (qx * qx + qy * qy),
    ];
    for (let i = 0; i < this.dots.length; i++) {
      const dot = this.dots[i];
      const alpha = reveal
        ? revealOpacity(dot, reveal.progress, reveal.direction)
        : 1;
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      const { nx, ny, nz, shade } = dot;
      const x = inverse[0] * nx + inverse[1] * ny + inverse[2] * nz;
      const y = inverse[3] * nx + inverse[4] * ny + inverse[5] * nz;
      const z = inverse[6] * nx + inverse[7] * ny + inverse[8] * nz;
      const color = sampleSurface(this.surface, x, y, z, this.sample);
      if (this.showClouds && this.clouds) {
        const opacity =
          Math.pow(sampleCloudCover(this.clouds, x, y, z), 1.1) * 0.6;
        // Even total cloud cover retains 40% of the terrain color.
        color[0] += (205 - color[0]) * opacity;
        color[1] += (225 - color[1]) * opacity;
        color[2] += (245 - color[2]) * opacity;
      }
      // Five bits per channel retains the atlas's many terrain colors while
      // letting us reuse CSS color strings instead of allocating per dot/frame.
      const red = Math.min(31, Math.round(((color[0] * shade) / 255) * 31));
      const green = Math.min(31, Math.round(((color[1] * shade) / 255) * 31));
      const blue = Math.min(31, Math.round(((color[2] * shade) / 255) * 31));
      const key = red * 1024 + green * 32 + blue;
      this.colorCache[key] ??=
        `rgb(${Math.round((red * 255) / 31)},${Math.round((green * 255) / 31)},${Math.round((blue * 255) / 31)})`;
      ctx.fillStyle = this.colorCache[key];
      ctx.fill(this.dotPaths[i]);
    }
    ctx.globalAlpha = 1;
    if (this.showGrid) this.drawGraticule(orientation);
  }

  drawGraticule(orientation) {
    const ctx = this.context;
    ctx.strokeStyle = 'rgba(72,95,106,0.25)';
    ctx.lineWidth = 0.65;
    ctx.setLineDash([2, 4]);
    const line = (points) => {
      ctx.beginPath();
      let visible = false;
      for (const point of points) {
        const [x, y, z] = rotateVector(point, orientation);
        if (z < 0) {
          visible = false;
          continue;
        }
        const px = this.width / 2 + x * this.radius;
        const py = this.height / 2 - y * this.radius;
        if (visible) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        visible = true;
      }
      ctx.stroke();
    };
    for (let latitude = -60; latitude <= 60; latitude += 30) {
      const lat = (latitude * Math.PI) / 180;
      line(
        Array.from({ length: 181 }, (_, i) => {
          const lon = (i * TAU) / 180;
          return [
            Math.cos(lat) * Math.sin(lon),
            Math.sin(lat),
            Math.cos(lat) * Math.cos(lon),
          ];
        }),
      );
    }
    for (let longitude = 0; longitude < 360; longitude += 30) {
      const lon = (longitude * Math.PI) / 180;
      line(
        Array.from({ length: 91 }, (_, i) => {
          const lat = -Math.PI / 2 + (i * Math.PI) / 90;
          return [
            Math.cos(lat) * Math.sin(lon),
            Math.sin(lat),
            Math.cos(lat) * Math.cos(lon),
          ];
        }),
      );
    }
    ctx.setLineDash([]);
  }
}
