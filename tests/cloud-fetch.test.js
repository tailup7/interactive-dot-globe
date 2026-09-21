import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOUD_VARIABLE, createSnapshot, fetchCloudSnapshot, readNetcdf, updateCloudSnapshot } from '../scripts/fetch-clouds.mjs';

const NOW = new Date('2026-09-21T12:40:00Z');
const DIMENSIONS = ['time', 'latitude', 'longitude'];

function dataset() {
  return { variables: {
    latitude: { values: [90, 0, -90], dimensions: ['latitude'], shape: [3], attributes: { units: 'degrees_north' } },
    longitude: { values: [0, 90, 180, 270], dimensions: ['longitude'], shape: [4], attributes: { units: 'degrees_east' } },
    time: { values: [12], dimensions: ['time'], shape: [1], attributes: { units: 'Hour since 2026-09-21T00:00:00Z' } },
    reftime: { values: [6], dimensions: ['time'], shape: [1], attributes: { units: 'Hour since 2026-09-21T00:00:00Z', standard_name: 'forecast_reference_time' } },
    [CLOUD_VARIABLE]: {
      values: [0, 20, 40, 60, 10, 30, 50, 70, 20, 40, 60, 80],
      dimensions: DIMENSIONS,
      shape: [1, 3, 4],
      attributes: { units: '%', coordinates: 'reftime time latitude longitude' },
    },
  } };
}

// A tiny CDF-1 fixture writer, following the published NetCDF file grammar.
// Network tests therefore use real binary input but never contact the provider.
function binaryFixture() {
  const uint = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const padded = (bytes) => Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]);
  const name = (value) => Buffer.concat([uint(Buffer.byteLength(value)), padded(Buffer.from(value))]);
  const attributes = (entries) => Buffer.concat([
    uint(12), uint(entries.length),
    ...entries.flatMap(([key, value]) => [name(key), uint(2), uint(Buffer.byteLength(value)), padded(Buffer.from(value))]),
  ]);
  const dimensions = Buffer.concat([uint(10), uint(3), name('time'), uint(1), name('latitude'), uint(3), name('longitude'), uint(4)]);
  const variables = Object.entries(dataset().variables).map(([key, variable]) => {
    const data = Buffer.alloc(variable.values.length * 4);
    variable.values.forEach((value, index) => data.writeFloatBE(value, index * 4));
    const prefix = Buffer.concat([
      name(key), uint(variable.dimensions.length), ...variable.dimensions.map((dimension) => uint(DIMENSIONS.indexOf(dimension))),
      attributes(Object.entries(variable.attributes)), uint(5), uint(data.length),
    ]);
    return { prefix, data };
  });
  const prefix = Buffer.concat([Buffer.from('43444601', 'hex'), uint(0), dimensions, uint(0), uint(0), uint(11), uint(variables.length)]);
  let position = prefix.length + variables.reduce((size, variable) => size + variable.prefix.length + 4, 0);
  const headers = variables.map((variable) => { const result = Buffer.concat([variable.prefix, uint(position)]); position += variable.data.length; return result; });
  return Buffer.concat([prefix, ...headers, ...variables.map((variable) => variable.data)]);
}

test('decodes CDF-1 coordinates, cloud percentages and actual valid/reference timestamps', () => {
  const snapshot = createSnapshot(readNetcdf(binaryFixture()), { width: 4, height: 2, now: NOW });
  assert.equal(snapshot.observedAt, '2026-09-21T12:00:00.000Z');
  assert.equal(snapshot.modelRunAt, '2026-09-21T06:00:00.000Z');
  assert.equal(snapshot.fetchedAt, NOW.toISOString());
  assert.equal(snapshot.source.kind, 'forecast');
});

test('resamples geographic cell centers in north-to-south order across the dateline', () => {
  const snapshot = createSnapshot(dataset(), { width: 4, height: 2, now: NOW });
  // Longitudes -135, -45, 45, 135; latitudes +45, -45.
  assert.deepEqual(snapshot.values, [0.55, 0.35, 0.15, 0.35, 0.65, 0.45, 0.25, 0.45]);
  const southToNorth = dataset();
  southToNorth.variables.latitude.values.reverse();
  southToNorth.variables[CLOUD_VARIABLE].values = [20, 40, 60, 80, 10, 30, 50, 70, 0, 20, 40, 60];
  assert.deepEqual(createSnapshot(southToNorth, { width: 4, height: 2, now: NOW }).values, snapshot.values);
});

test('handles longitude grids beginning at -180 without shifting the map', () => {
  const shifted = dataset();
  shifted.variables.longitude.values = [-180, -90, 0, 90];
  shifted.variables[CLOUD_VARIABLE].values = [40, 60, 0, 20, 50, 70, 10, 30, 60, 80, 20, 40];
  assert.deepEqual(createSnapshot(shifted, { width: 4, height: 2, now: NOW }).values, [0.55, 0.35, 0.15, 0.35, 0.65, 0.45, 0.25, 0.45]);
});

test('rejects stale timestamps, incomplete global grids and out-of-range percentages', () => {
  assert.throws(() => createSnapshot(dataset(), { now: new Date('2026-09-22T00:00:00Z') }), /six hours/);
  const partial = dataset();
  partial.variables.latitude.values = [45, 0, -45];
  assert.throws(() => createSnapshot(partial, { now: NOW }), /complete global/);
  const oldRun = dataset();
  oldRun.variables.reftime.values[0] = -24;
  assert.throws(() => createSnapshot(oldRun, { now: NOW }), /recent completed GFS run/);
  const invalid = dataset();
  invalid.variables[CLOUD_VARIABLE].values[0] = 120;
  assert.throws(() => createSnapshot(invalid, { now: NOW }), /Invalid cloud cover percentage/);
  const missing = dataset();
  missing.variables[CLOUD_VARIABLE].values.fill(NaN);
  assert.throws(() => createSnapshot(missing, { now: NOW }), /incomplete/);
});

test('preserves missing cells as null instead of interpreting them as clear sky', () => {
  const data = dataset();
  data.variables.latitude.values = Array.from({ length: 11 }, (_, index) => 90 - 18 * index);
  data.variables.longitude.values = Array.from({ length: 20 }, (_, index) => index * 18);
  data.variables[CLOUD_VARIABLE].shape = [1, 11, 20];
  data.variables[CLOUD_VARIABLE].values = new Array(220).fill(50);
  data.variables[CLOUD_VARIABLE].values[0] = -9999;
  data.variables[CLOUD_VARIABLE].attributes.missing_value = [-9999];
  const snapshot = createSnapshot(data, { width: 20, height: 10, now: NOW });
  assert.equal(snapshot.values.filter((value) => value === null).length, 2);
  assert.match(snapshot.warning, /Missing cloud cells/);
  assert.ok(snapshot.values.every((value) => value === null || value === 0.5));
});

test('fetches exactly once and creates a snapshot from a real binary API response', async () => {
  let requests = 0;
  const snapshot = await fetchCloudSnapshot({ now: NOW, fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url.hostname, 'thredds.ucar.edu');
    assert.equal(url.searchParams.get('time'), NOW.toISOString());
    assert.equal(url.searchParams.get('var'), CLOUD_VARIABLE);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(binaryFixture());
  } });
  assert.equal(requests, 1);
  assert.equal(snapshot.values.length, 360 * 180);
  assert.equal(snapshot.observedAt, '2026-09-21T12:00:00.000Z');
});

test('rejects HTTP failures, HTML error bodies, truncated files and NetCDF-4', async () => {
  await assert.rejects(fetchCloudSnapshot({ fetchImpl: async () => new Response('unavailable', { status: 503 }), now: NOW }), /HTTP 503/);
  await assert.rejects(fetchCloudSnapshot({ fetchImpl: async () => new Response('<html>Error</html>'), now: NOW }), /classic NetCDF/);
  assert.throws(() => readNetcdf(binaryFixture().subarray(0, 40)));
  assert.throws(() => readNetcdf(Buffer.from('894844460d0a1a0a', 'hex')), /classic NetCDF/);
});

test('download or validation failure leaves the previous file untouched; success replaces it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'globe-cloud-test-'));
  const output = join(directory, 'clouds.json');
  try {
    const oldSnapshot = JSON.stringify({ previous: 'snapshot' });
    await writeFile(output, oldSnapshot);
    await assert.rejects(updateCloudSnapshot({ output, now: NOW, fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
    assert.equal(await readFile(output, 'utf8'), oldSnapshot);
    await assert.rejects(updateCloudSnapshot({ output, now: NOW, fetchImpl: async () => new Response('bad data') }), /classic NetCDF/);
    assert.equal(await readFile(output, 'utf8'), oldSnapshot);
    await updateCloudSnapshot({ output, now: NOW, fetchImpl: async () => new Response(binaryFixture()) });
    assert.equal(JSON.parse(await readFile(output, 'utf8')).observedAt, '2026-09-21T12:00:00.000Z');
    assert.deepEqual(await readdir(directory), ['clouds.json']);
  } finally {
    await unlink(output);
    await rmdir(directory);
  }
});
