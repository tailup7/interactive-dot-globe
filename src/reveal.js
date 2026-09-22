export const REVEAL_FADE_ANGLE = 0.08;
export const REVEAL_SWEEP_ANGLE = Math.PI + REVEAL_FADE_ANGLE;

/** A one-shot entrance; visibility follows the projected direction of spin. */
export class GlobeReveal {
  constructor({ direction = [1, 0], reducedMotion = false } = {}) {
    const length = Math.hypot(...direction);
    this.direction =
      length > 0 ? direction.map((value) => value / length) : [1, 0];
    this.progress = reducedMotion ? 1 : 0;
  }

  get active() {
    return this.progress < 1;
  }

  /** Advance by the exact angle used to rotate the globe, including its clamp. */
  advance(angleRadians) {
    if (this.active && Number.isFinite(angleRadians) && angleRadians > 0) {
      this.progress = Math.min(
        1,
        this.progress + angleRadians / REVEAL_SWEEP_ANGLE,
      );
    }
  }

  finish() {
    this.progress = 1;
  }
}

/** Only opacity changes: the cached diamond path remains untouched. */
export function revealOpacity(dot, progress, direction) {
  if (progress >= 1) return 1;
  if (progress <= 0) return 0;
  const length = Math.hypot(...direction) || 1;
  // Dot normals use y-up; the direction uses screen coordinates (y-down).
  const along = Math.max(
    -1,
    Math.min(1, (dot.nx * direction[0] - dot.ny * direction[1]) / length),
  );
  // Use spherical longitude around the projected spin axis. Unlike asin(x),
  // this follows the smaller circles near the poles as well as the equator.
  const depth =
    dot.nz ?? Math.sqrt(Math.max(0, 1 - dot.nx * dot.nx - dot.ny * dot.ny));
  const phase = Math.atan2(along, depth) + Math.PI / 2;
  const opacity = Math.max(
    0,
    Math.min(1, (progress * REVEAL_SWEEP_ANGLE - phase) / REVEAL_FADE_ANGLE),
  );
  return opacity * opacity * (3 - 2 * opacity);
}
