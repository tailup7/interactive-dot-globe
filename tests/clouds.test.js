import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudSnapshot, sampleCloudCover } from '../src/clouds.js';

function fixture(overrides = {}) {
  return {
    version: 1,
    width: 4,
    height: 2,
    values: [0, 0.25, 0.5, 0.75, 0.25, 0.5, 0.75, 1],
    observedAt: '2026-09-21T12:00:00Z',
    fetchedAt: '2026-09-21T12:10:00Z',
    source: {
      name: 'Test cloud analysis',
      url: 'https://example.com/clouds',
      kind: 'forecast',
      attribution: 'Test weather data',
    },
    ...overrides,
  };
}

function geographicVector(longitude, latitude) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
}

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);
}

test('cloud snapshots retain observation/source information and distinguish missing cells from clear sky', () => {
  const payload = fixture({ values: [0, null, 0.5, 0.75, 0.25, 0.5, null, 1] });
  const clouds = parseCloudSnapshot(payload);
  assert.equal(clouds.width, 4);
  assert.equal(clouds.height, 2);
  assert.ok(clouds.values instanceof Float32Array);
  assert.equal(clouds.values[0], 0);
  assert.ok(Number.isNaN(clouds.values[1]));
  assert.ok(Number.isNaN(clouds.values[6]));
  close(clouds.coverage, 6 / 8);
  assert.equal(Date.parse(clouds.observedAt), Date.parse(payload.observedAt));
  assert.equal(Date.parse(clouds.fetchedAt), Date.parse(payload.fetchedAt));
  assert.deepEqual(clouds.source, payload.source);
  assert.equal(payload.values[1], null, 'Parsing must not mutate the source snapshot');
});

test('cloud snapshots reject malformed dimensions, values, dates, and source metadata', () => {
  const invalidPayloads = [
    null,
    [],
    fixture({ version: 2 }),
    fixture({ width: 0 }),
    fixture({ height: -1 }),
    fixture({ width: 4.5 }),
    fixture({ height: '2' }),
    fixture({ values: [0, 1] }),
    fixture({ values: '00000000' }),
    ...[-0.1, 1.1, NaN, Infinity, '0.5', undefined].map((value) => fixture({
      values: [value, 0.25, 0.5, 0.75, 0.25, 0.5, 0.75, 1],
    })),
    fixture({ observedAt: 'invalid' }),
    fixture({ fetchedAt: 'invalid' }),
    fixture({ source: null }),
    fixture({ source: { ...fixture().source, name: '' } }),
    fixture({ source: { ...fixture().source, kind: 'unknown' } }),
    fixture({ source: { ...fixture().source, url: 'javascript:alert(1)' } }),
    fixture({ values: Array(8).fill(null) }),
    fixture({ width: 4096, height: 2049 }),
  ];
  for (const payload of invalidPayloads) {
    assert.throws(() => parseCloudSnapshot(payload), `Unexpectedly accepted ${JSON.stringify(payload)}`);
  }
});

test('cloud cover follows the geographic coordinates of the surface and interpolates between cells', () => {
  const clouds = parseCloudSnapshot(fixture());
  for (const [longitude, latitude, expected] of [
    [-135, 45, 0],
    [-45, 45, 0.25],
    [135, -45, 1],
    [0, 0, 0.5],
  ]) {
    close(sampleCloudCover(clouds, ...geographicVector(longitude, latitude)), expected);
  }
});

test('cloud cover wraps at the antimeridian and clamps at the poles without a seam', () => {
  const clouds = parseCloudSnapshot(fixture());
  for (const longitude of [-180, 180]) {
    close(sampleCloudCover(clouds, ...geographicVector(longitude, 45)), 0.375);
  }
  close(
    sampleCloudCover(clouds, ...geographicVector(179.999999, 0)),
    sampleCloudCover(clouds, ...geographicVector(-179.999999, 0)),
  );
  close(sampleCloudCover(clouds, ...geographicVector(-135, 90)), 0);
  close(sampleCloudCover(clouds, ...geographicVector(-135, -90)), 0.25);
});

test('missing cloud cells preserve the surface and do not dilute nearby valid cloud measurements', () => {
  const clouds = parseCloudSnapshot(fixture({
    values: [null, null, 1, null, null, null, null, null],
  }));
  close(sampleCloudCover(clouds, ...geographicVector(-135, 45)), 0);
  close(sampleCloudCover(clouds, ...geographicVector(45, 45)), 1);
  // At this boundary the only available neighboring measurement is full cloud.
  close(sampleCloudCover(clouds, ...geographicVector(0, 0)), 1);
});
