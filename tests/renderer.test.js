import test from 'node:test';
import assert from 'node:assert/strict';
import { createDotGrid, sampleSurface } from '../src/surface.js';

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);
}

function geographicVector(longitude, latitude) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
}

function fixtureSurface() {
  return {
    width: 4,
    height: 2,
    pixels: new Uint8ClampedArray([
      10, 20, 30, 255, 50, 60, 70, 255, 90, 100, 110, 255, 130, 140, 150, 255,
      30, 40, 50, 255, 70, 80, 90, 255, 110, 120, 130, 255, 150, 160, 170, 255,
    ]),
  };
}

test('the fixed circular grid maps every dot onto the visible unit hemisphere', () => {
  for (const [width, height] of [[420, 420], [720, 420], [320, 460]]) {
    const { dots, radius, dotRadius } = createDotGrid(width, height);
    assert.ok(dots.length > 1000, 'The display should contain a dense dot field');
    assert.ok(dotRadius > 0);
    assert.ok(radius < Math.min(width, height) / 2);
    for (const dot of dots) {
      assert.ok(Math.hypot(dot.x - width / 2, dot.y - height / 2) + dotRadius <= radius + 1e-9);
      close(dot.nx, (dot.x - width / 2) / radius);
      close(dot.ny, (height / 2 - dot.y) / radius);
      close(Math.hypot(dot.nx, dot.ny, dot.nz), 1);
      assert.ok(dot.nz >= 0);
    }
    assert.deepEqual(createDotGrid(width, height), { dots, radius, dotRadius });
  }
});

test('surface sampling preserves geographic orientation and interpolates pixel centers', () => {
  const surface = fixtureSurface();
  const samples = [
    [-135, 45, [10, 20, 30]],
    [135, -45, [150, 160, 170]],
    [0, 0, [80, 90, 100]],
  ];
  for (const [longitude, latitude, expected] of samples) {
    const actual = sampleSurface(surface, ...geographicVector(longitude, latitude));
    expected.forEach((channel, index) => close(actual[index], channel));
  }
});

test('surface colours wrap continuously across the dateline and clamp at the poles', () => {
  const surface = fixtureSurface();
  for (const longitude of [-180, 180]) {
    const actual = sampleSurface(surface, ...geographicVector(longitude, 45));
    [70, 80, 90].forEach((channel, index) => close(actual[index], channel));
  }
  const east = sampleSurface(surface, ...geographicVector(179.999999, 0));
  const west = sampleSurface(surface, ...geographicVector(-179.999999, 0));
  east.forEach((channel, index) => close(channel, west[index], 1e-5));
  for (const [latitude, expected] of [[90, [10, 20, 30]], [-90, [30, 40, 50]]]) {
    const actual = sampleSurface(surface, ...geographicVector(-135, latitude));
    expected.forEach((channel, index) => close(actual[index], channel));
  }
});

test('surface sampling can reuse a caller-provided RGB buffer', () => {
  const output = new Float64Array(3);
  const result = sampleSurface(fixtureSurface(), ...geographicVector(0, 0), output);
  assert.equal(result, output);
  [80, 90, 100].forEach((channel, index) => close(output[index], channel));
});
