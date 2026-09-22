export const DEFAULT_SPEED = 0.2925;
const MAX_FRAME_SECONDS = 0.05;
const DEG = Math.PI / 180;

function multiplyQuaternion(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function normalizeQuaternion(quaternion) {
  const length = Math.hypot(...quaternion);
  return quaternion.map((component) => component / length);
}

function axisAngle(axis, angle) {
  const sine = Math.sin(angle / 2);
  return [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(angle / 2)];
}

/** Rotate an [x, y, z] vector by a normalized [x, y, z, w] quaternion. */
export function rotateVector(vector, quaternion) {
  const [x, y, z] = vector;
  const [qx, qy, qz, qw] = quaternion;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

/**
 * Rotation state independent of rendering or browser events.
 * Coordinates: x right, y up, z toward the viewer. Drag deltas use CSS pixels,
 * so a positive dy (down on the screen) rotates around the positive x axis.
 */
export class GlobeMotion {
  constructor({ speed = DEFAULT_SPEED, autoRotate = true } = {}) {
    this.speed = DEFAULT_SPEED;
    this.autoRotate = Boolean(autoRotate);
    this.setSpeed(speed);
    this.reset();
  }

  /** Reset the view and drift direction while keeping the user's settings. */
  reset() {
    const yaw = axisAngle([0, 1, 0], -25 * DEG);
    const pitch = axisAngle([1, 0, 0], 12 * DEG);
    this.orientation = normalizeQuaternion(multiplyQuaternion(pitch, yaw));
    // Keep the geographic poles fixed during default spin, including the
    // initial viewing tilt. Dragging can still replace this screen-space axis.
    this.driftAxis = rotateVector([0, 1, 0], this.orientation);
    this.dragging = false;
    this.lastStepAngle = 0;
  }

  beginDrag() {
    this.dragging = true;
  }

  /**
   * Apply the complete pointer displacement immediately. A screen-radius of
   * displacement equals one radian, independently of pointer event frequency.
   * The last nonzero displacement sets the subsequent automatic rotation axis.
   */
  dragBy(dx, dy, radius) {
    if (
      !this.dragging ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      !Number.isFinite(radius) ||
      radius <= 0
    )
      return false;

    const distance = Math.hypot(dx, dy);
    const angle = distance / radius;
    if (distance === 0 || !Number.isFinite(distance) || !Number.isFinite(angle))
      return false;

    this.driftAxis = [dy / distance, dx / distance, 0];
    this.rotate(this.driftAxis, angle);
    return true;
  }

  endDrag() {
    this.dragging = false;
  }

  /** Return whether a frame advanced; clamp long gaps after hidden tabs. */
  step(deltaSeconds) {
    this.lastStepAngle = 0;
    if (
      this.dragging ||
      !this.autoRotate ||
      this.speed === 0 ||
      !Number.isFinite(deltaSeconds) ||
      deltaSeconds <= 0
    )
      return false;

    this.lastStepAngle = this.speed * Math.min(deltaSeconds, MAX_FRAME_SECONDS);
    this.rotate(this.driftAxis, this.lastStepAngle);
    return true;
  }

  setAutoRotate(enabled) {
    this.autoRotate = Boolean(enabled);
  }

  /** Ignore invalid speeds; zero deliberately stops automatic rotation. */
  setSpeed(radiansPerSecond) {
    if (Number.isFinite(radiansPerSecond) && radiansPerSecond >= 0) {
      this.speed = radiansPerSecond;
    }
  }

  rotate(axis, angle) {
    // Premultiplication keeps the drag axis in screen coordinates after any tilt.
    this.orientation = normalizeQuaternion(
      multiplyQuaternion(axisAngle(axis, angle), this.orientation),
    );
  }
}
