import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobeMotion, rotateVector } from '../src/motion.js';

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} should equal ${expected}`,
  );
}

function vectorClose(actual, expected, tolerance = 1e-12) {
  actual.forEach((value, index) => close(value, expected[index], tolerance));
}

function identityMotion(options) {
  const motion = new GlobeMotion(options);
  motion.orientation = [0, 0, 0, 1];
  return motion;
}

function angularDifference(a, b) {
  // This is stable for the small angles used in these tests.
  const dot = Math.abs(
    a.reduce((sum, component, index) => sum + component * b[index], 0),
  );
  return 2 * Math.acos(Math.min(1, dot));
}

test('initial view centers longitude 25° E and latitude 12° N', () => {
  const longitude = (25 * Math.PI) / 180;
  const latitude = (12 * Math.PI) / 180;
  const place = [
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.cos(longitude),
  ];
  vectorClose(rotateVector(place, new GlobeMotion().orientation), [0, 0, 1]);
});

test('right and downward drags move the visible surface in the same screen direction', () => {
  const horizontal = identityMotion();
  horizontal.beginDrag();
  assert.equal(horizontal.dragBy(100, 0, 200), true);
  vectorClose(rotateVector([0, 0, 1], horizontal.orientation), [
    Math.sin(0.5),
    0,
    Math.cos(0.5),
  ]);

  const vertical = identityMotion();
  vertical.beginDrag();
  vertical.dragBy(0, 100, 200);
  vectorClose(rotateVector([0, 0, 1], vertical.orientation), [
    0,
    -Math.sin(0.5),
    Math.cos(0.5),
  ]);
});

test('drag distance controls rotation independently of event frequency', () => {
  const single = identityMotion();
  const multiple = identityMotion();
  single.beginDrag();
  multiple.beginDrag();
  single.dragBy(150, -75, 300);
  for (let i = 0; i < 10; i += 1) multiple.dragBy(15, -7.5, 300);
  vectorClose(single.orientation, multiple.orientation);
});

test('last actual drag direction persists through zero moves and release', () => {
  const motion = identityMotion({ speed: 0.4 });
  motion.beginDrag();
  motion.dragBy(100, 0, 200);
  motion.dragBy(-3, -4, 200);
  vectorClose(motion.driftAxis, [-0.8, -0.6, 0]);
  assert.equal(motion.dragBy(0, 0, 200), false);
  motion.endDrag();
  const before = [...motion.orientation];
  motion.step(0.05);
  vectorClose(motion.driftAxis, [-0.8, -0.6, 0]);
  close(angularDifference(before, motion.orientation), 0.02, 1e-10);
});

test('diagonal and horizontal release have the same configured angular speed', () => {
  for (const [dx, dy] of [
    [10, 0],
    [0, -10],
    [-3, 4],
  ]) {
    const motion = identityMotion({ speed: 0.3 });
    motion.beginDrag();
    motion.dragBy(dx, dy, 200);
    motion.endDrag();
    const before = [...motion.orientation];
    motion.step(0.04);
    close(angularDifference(before, motion.orientation), 0.012, 1e-10);
    close(Math.hypot(...motion.driftAxis), 1);
  }
});

test('automatic movement pauses during a drag and when disabled, but manual drag still works', () => {
  const motion = new GlobeMotion();
  const initial = [...motion.orientation];
  motion.beginDrag();
  assert.equal(motion.step(0.02), false);
  vectorClose(motion.orientation, initial);
  motion.endDrag();
  motion.setAutoRotate(false);
  assert.equal(motion.step(0.02), false);
  vectorClose(motion.orientation, initial);
  motion.beginDrag();
  assert.equal(motion.dragBy(10, 5, 200), true);
  motion.endDrag();
  motion.setAutoRotate(true);
  assert.equal(motion.step(0.02), true);
});

test('automatic movement is frame-rate independent and clamps long frame gaps', () => {
  const low = new GlobeMotion();
  const high = new GlobeMotion();
  for (let i = 0; i < 30; i += 1) low.step(1 / 30);
  for (let i = 0; i < 144; i += 1) high.step(1 / 144);
  vectorClose(low.orientation, high.orientation);

  const longGap = new GlobeMotion();
  const limited = new GlobeMotion();
  longGap.step(100);
  limited.step(0.05);
  vectorClose(longGap.orientation, limited.orientation);
});

test('default rotation keeps geographic poles fixed while the equator moves, initially and after reset', () => {
  const motion = new GlobeMotion();
  for (const resetAfterDragging of [false, true]) {
    if (resetAfterDragging) {
      motion.beginDrag();
      motion.dragBy(110, -70, 200);
      motion.dragBy(-30, 90, 200);
      motion.endDrag();
      motion.reset();
    }

    const north = rotateVector([0, 1, 0], motion.orientation);
    const south = rotateVector([0, -1, 0], motion.orientation);
    const equator = rotateVector([0, 0, 1], motion.orientation);
    close(Math.hypot(...motion.driftAxis), 1);

    for (let frame = 0; frame < 600; frame += 1) {
      motion.step(1 / 60);
      vectorClose(rotateVector([0, 1, 0], motion.orientation), north);
      vectorClose(rotateVector([0, -1, 0], motion.orientation), south);
    }

    const movedEquator = rotateVector([0, 0, 1], motion.orientation);
    assert.ok(
      Math.hypot(
        ...movedEquator.map((value, index) => value - equator[index]),
      ) > 1,
    );
  }
});

test('invalid inputs never corrupt state and zero speed pauses automatic movement', () => {
  const motion = new GlobeMotion();
  const initial = [...motion.orientation];
  assert.equal(motion.dragBy(10, 10, 100), false);
  motion.beginDrag();
  for (const args of [
    [NaN, 1, 100],
    [1, Infinity, 100],
    [1, 1, 0],
    [1, 1, -1],
    [1, 1, NaN],
  ]) {
    assert.equal(motion.dragBy(...args), false);
  }
  motion.endDrag();
  for (const delta of [NaN, Infinity, -1, 0])
    assert.equal(motion.step(delta), false);
  for (const speed of [NaN, Infinity, -1]) motion.setSpeed(speed);
  assert.equal(motion.speed, 0.2925);
  vectorClose(motion.orientation, initial);
  motion.setSpeed(0);
  assert.equal(motion.step(0.01), false);
});

test('quaternions remain normalized over repeated arbitrary drags and drift', () => {
  const motion = new GlobeMotion();
  for (let i = 0; i < 10000; i += 1) {
    motion.beginDrag();
    motion.dragBy(Math.sin(i) * 11, Math.cos(i) * 8, 200);
    motion.endDrag();
    motion.step(1 / 60);
  }
  close(Math.hypot(...motion.orientation), 1);
  const rotated = rotateVector([0.6, 0.8, 0], motion.orientation);
  close(Math.hypot(...rotated), 1);
});

test('reset restores the initial view and axis while preserving user settings', () => {
  const motion = new GlobeMotion({ speed: 0.7, autoRotate: false });
  motion.beginDrag();
  motion.dragBy(-20, 10, 200);
  motion.reset();
  vectorClose(motion.orientation, new GlobeMotion().orientation);
  const tilt = (12 * Math.PI) / 180;
  vectorClose(motion.driftAxis, [0, Math.cos(tilt), Math.sin(tilt)]);
  assert.equal(motion.dragging, false);
  assert.equal(motion.autoRotate, false);
  assert.equal(motion.speed, 0.7);
});
