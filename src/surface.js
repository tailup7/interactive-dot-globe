const TAU = Math.PI * 2;

/**
 * Screen-space LEDs, independent of the orientation of the Earth.
 * Build only when the layout changes. Every diamond has the same fixed
 * center-to-vertex radius, on a square lattice rotated 45 degrees.
 */
export function createDotGrid(width, height) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { dots: [], radius: 0, dotRadius: 0 };
  }
  const radius = Math.min(width, height) * 0.378;
  const spacing = Math.max(3.2, radius / 55);
  const horizontalPitch = spacing * Math.SQRT2;
  // A diamond's side is 80% of the nearest-neighbor center spacing.
  // Parallel edges therefore have half the gap of the previous circular dots.
  const dotRadius = horizontalPitch * 0.4;
  const rowHeight = horizontalPitch / 2;
  const rows = Math.floor(radius / rowHeight);
  const columns = Math.ceil(radius / horizontalPitch);
  const limit = Math.max(0, 1 - dotRadius / radius) ** 2;
  const dots = [];

  for (let row = -rows; row <= rows; row++) {
    const offset = (row & 1) * 0.5;
    for (let column = -columns; column <= columns; column++) {
      const nx = ((column + offset) * horizontalPitch) / radius;
      const ny = (-row * rowHeight) / radius;
      const distanceSquared = nx * nx + ny * ny;
      if (distanceSquared > limit) continue;
      // Inverse orthographic projection onto the visible unit hemisphere.
      const nz = Math.sqrt(Math.max(0, 1 - distanceSquared));
      dots.push({
        x: width / 2 + nx * radius,
        y: height / 2 - ny * radius,
        nx,
        ny,
        nz,
        // Lighting is fixed in screen space, never in the moving map.
        shade: 0.76 + 0.24 * nz,
      });
    }
  }
  return { dots, radius, dotRadius };
}

/**
 * Bilinear RGB lookup in a local equirectangular image: north at the top,
 * longitude -180 at the left. Wrap the date line, clamp the poles.
 * Coordinates are normalized geographic (not rotated screen) coordinates.
 */
export function sampleSurface(surface, x, y, z, output = new Float64Array(3)) {
  const { width, height, pixels } = surface;
  const u = (Math.atan2(x, z) / TAU + 0.5) * width - 0.5;
  const v = Math.max(
    0,
    Math.min(
      height - 1,
      (0.5 - Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI) * height - 0.5,
    ),
  );
  const left = Math.floor(u);
  const top = Math.floor(v);
  const x0 = ((left % width) + width) % width;
  const x1 = (x0 + 1) % width;
  const y1 = Math.min(top + 1, height - 1);
  const tx = u - left;
  const ty = v - top;
  const a = (top * width + x0) * 4;
  const b = (top * width + x1) * 4;
  const c = (y1 * width + x0) * 4;
  const d = (y1 * width + x1) * 4;
  for (let channel = 0; channel < 3; channel++) {
    const upper = pixels[a + channel] * (1 - tx) + pixels[b + channel] * tx;
    const lower = pixels[c + channel] * (1 - tx) + pixels[d + channel] * tx;
    output[channel] = upper * (1 - ty) + lower * ty;
  }
  return output;
}
