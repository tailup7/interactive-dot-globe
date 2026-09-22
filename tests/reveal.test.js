import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobeMotion } from '../src/motion.js';
import {
  GlobeReveal,
  REVEAL_FADE_ANGLE,
  REVEAL_SWEEP_ANGLE,
  revealOpacity,
} from '../src/reveal.js';

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);
}

function advanceFrame(motion, reveal, seconds) {
  const advanced = motion.step(seconds);
  reveal.advance(motion.lastStepAngle);
  return advanced;
}

test('entrance follows right, left, upward, and diagonal screen directions', () => {
  const sweeps = [
    { direction: [7, 0], first: { nx: -0.8, ny: 0 }, last: { nx: 0.8, ny: 0 } },
    {
      direction: [-7, 0],
      first: { nx: 0.8, ny: 0 },
      last: { nx: -0.8, ny: 0 },
    },
    {
      direction: [0, -7],
      first: { nx: 0, ny: -0.8 },
      last: { nx: 0, ny: 0.8 },
    },
    {
      direction: [3, -4],
      first: { nx: -0.48, ny: -0.64 },
      last: { nx: 0.48, ny: 0.64 },
    },
  ];

  for (const { direction, first, last } of sweeps) {
    const reveal = new GlobeReveal({ direction });
    assert.ok(Math.abs(Math.hypot(...reveal.direction) - 1) < 1e-12);
    const center = revealOpacity({ nx: 0, ny: 0 }, 0.5, reveal.direction);
    assert.ok(revealOpacity(first, 0.5, reveal.direction) > center);
    assert.ok(revealOpacity(last, 0.5, reveal.direction) < center);
    // Direction magnitude must not change which part of the globe is visible.
    const sample = { nx: 0.1, ny: 0.1 };
    assert.ok(
      Math.abs(
        revealOpacity(sample, 0.5, direction) -
          revealOpacity(sample, 0.5, reveal.direction),
      ) < 1e-12,
    );
  }
});

test('each fixed dot fades as the rotating angular front passes its position', () => {
  const direction = [1, 0];
  for (const phase of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
    const dot = { nx: Math.sin(phase - Math.PI / 2), ny: 0 };
    assert.equal(revealOpacity(dot, 0, direction), 0);
    assert.equal(revealOpacity(dot, 1, direction), 1);
    near(revealOpacity(dot, phase / REVEAL_SWEEP_ANGLE, direction), 0);
    near(
      revealOpacity(
        dot,
        (phase + REVEAL_FADE_ANGLE / 2) / REVEAL_SWEEP_ANGLE,
        direction,
      ),
      0.5,
    );
    near(
      revealOpacity(
        dot,
        (phase + REVEAL_FADE_ANGLE) / REVEAL_SWEEP_ANGLE,
        direction,
      ),
      1,
    );
  }
});

test('high latitudes follow the same angular front as the equator around the projected axis', () => {
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0.6, -0.8],
  ]) {
    for (const phase of [0.35, 1, 1.6, 2.7]) {
      const longitude = phase - Math.PI / 2;
      for (const latitudeDegrees of [-80, -60, 0, 60, 80]) {
        const latitude = (latitudeDegrees * Math.PI) / 180;
        const along = Math.cos(latitude) * Math.sin(longitude);
        const across = Math.sin(latitude);
        const dot = {
          nx: along * dx + across * dy,
          ny: -along * dy + across * dx,
          nz: Math.cos(latitude) * Math.cos(longitude),
        };
        // A shared longitude reaches the front simultaneously at every latitude,
        // even though the smaller latitude circles occupy fewer screen pixels.
        for (const [fraction, expected] of [
          [0.25, 0.15625],
          [0.5, 0.5],
          [0.75, 0.84375],
        ]) {
          const progress =
            (phase + REVEAL_FADE_ANGLE * fraction) / REVEAL_SWEEP_ANGLE;
          near(revealOpacity(dot, progress, [dx, dy]), expected);
          near(
            revealOpacity({ nx: dot.nx, ny: dot.ny }, progress, [dx, dy]),
            expected,
          );
        }
      }
    }
  }
});

test('entrance advances by the actual rotation angle and follows speed changes', () => {
  const motion = new GlobeMotion();
  const reveal = new GlobeReveal();
  const originalOrientation = [...motion.orientation];
  for (let frame = 0; frame < 60; frame += 1)
    advanceFrame(motion, reveal, 1 / 60);

  const quaternionDot = originalOrientation.reduce(
    (sum, value, index) => sum + value * motion.orientation[index],
    0,
  );
  const measuredAngle = 2 * Math.acos(Math.min(1, Math.abs(quaternionDot)));
  near(reveal.progress * REVEAL_SWEEP_ANGLE, measuredAngle);
  near(measuredAngle, 0.2925);

  const initialProgress = reveal.progress;
  motion.setSpeed(motion.speed * 2);
  for (let frame = 0; frame < 60; frame += 1)
    advanceFrame(motion, reveal, 1 / 60);
  near(reveal.progress - initialProgress, initialProgress * 2);
});

test('pause, dragging, zero speed, and invalid frames do not advance the entrance', () => {
  const motion = new GlobeMotion();
  const reveal = new GlobeReveal();
  advanceFrame(motion, reveal, 1 / 60);
  const originalProgress = reveal.progress;

  const assertStopped = (seconds = 1 / 60) => {
    assert.equal(advanceFrame(motion, reveal, seconds), false);
    assert.equal(motion.lastStepAngle, 0);
    assert.equal(reveal.progress, originalProgress);
  };
  motion.setAutoRotate(false);
  assertStopped();
  motion.setAutoRotate(true);
  motion.beginDrag();
  assertStopped();
  motion.endDrag();
  motion.setSpeed(0);
  assertStopped();
  motion.setSpeed(0.2925);
  for (const seconds of [0, -1, NaN, Infinity]) assertStopped(seconds);
  for (const angle of [0, -1, NaN, Infinity]) reveal.advance(angle);
  assert.equal(reveal.progress, originalProgress);

  assert.equal(advanceFrame(motion, reveal, 1 / 60), true);
  assert.ok(reveal.progress > originalProgress);
});

test('a long frame gap advances the entrance only as far as the clamped rotation', () => {
  const motion = new GlobeMotion();
  const reveal = new GlobeReveal();
  assert.equal(advanceFrame(motion, reveal, 60), true);
  near(motion.lastStepAngle, motion.speed * 0.05);
  near(reveal.progress * REVEAL_SWEEP_ANGLE, motion.lastStepAngle);
});

test('equal rotation at different frame rates reveals the same amount and completes after a hemisphere plus fade', () => {
  const midway = [];
  for (const framesPerSecond of [30, 60, 144]) {
    const motion = new GlobeMotion();
    const reveal = new GlobeReveal();
    let frames = 0;
    for (; frames < framesPerSecond; frames += 1) {
      advanceFrame(motion, reveal, 1 / framesPerSecond);
    }
    midway.push(reveal.progress);
    assert.equal(reveal.active, true);

    const duration = REVEAL_SWEEP_ANGLE / motion.speed;
    const latestFinish = Math.ceil(duration * framesPerSecond) + 1;
    while (reveal.active && frames < latestFinish) {
      advanceFrame(motion, reveal, 1 / framesPerSecond);
      frames += 1;
    }
    const elapsed = frames / framesPerSecond;
    assert.equal(reveal.active, false);
    assert.equal(reveal.progress, 1);
    assert.ok(elapsed >= duration - 1e-12);
    assert.ok(elapsed <= duration + 1 / framesPerSecond + 1e-12);
  }
  assert.ok(midway.every((progress) => Math.abs(progress - midway[0]) < 1e-12));
});

test('finishing early and reduced motion both keep the entrance permanently visible', () => {
  const interrupted = new GlobeReveal();
  interrupted.advance(0.2);
  assert.equal(interrupted.active, true);
  interrupted.finish();

  for (const reveal of [
    interrupted,
    new GlobeReveal({ reducedMotion: true }),
  ]) {
    assert.equal(reveal.progress, 1);
    assert.equal(reveal.active, false);
    for (const angle of [0.001, 0.5, 10]) reveal.advance(angle);
    reveal.finish();
    assert.equal(reveal.progress, 1);
    assert.equal(reveal.active, false);
  }
});
