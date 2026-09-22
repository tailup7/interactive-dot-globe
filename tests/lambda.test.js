import test from 'node:test';
import assert from 'node:assert/strict';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createCloudHandler } from '../lambda/index.mjs';

const NOW = new Date('2026-09-22T08:00:00.000Z');

function snapshot(fetchedAt = NOW.toISOString()) {
  return {
    version: 1,
    width: 2,
    height: 2,
    values: [0, 0.25, 0.5, 1],
    observedAt: '2026-09-22T06:00:00.000Z',
    fetchedAt,
    source: {
      name: 'test source',
      url: 'https://example.test/clouds',
      attribution: 'test',
      kind: 'forecast',
    },
  };
}

function cachedObject(value) {
  return { Body: { transformToString: async () => JSON.stringify(value) } };
}

function testHandler({ cached, fetchSnapshot, sends = [] } = {}) {
  const s3 = {
    async send(command) {
      sends.push(command);
      if (command instanceof GetObjectCommand) {
        if (cached) return cachedObject(cached);
        const error = new Error('missing');
        error.name = 'NoSuchKey';
        throw error;
      }
      return {};
    },
  };
  return {
    sends,
    handler: createCloudHandler({
      s3,
      fetchSnapshot,
      now: () => NOW,
      environment: {
        CLOUD_BUCKET: 'unit-test-clouds',
        CLOUD_KEY: 'clouds/current.json',
        CACHE_TTL_SECONDS: '3600',
        WEATHER_TIMEOUT_MS: '12345',
      },
      logger: { error() {} },
    }),
  };
}

function json(result) {
  return JSON.parse(result.body);
}

test('a fresh S3 cloud snapshot is returned without a weather request', async () => {
  let requested = false;
  const { handler, sends } = testHandler({
    cached: snapshot('2026-09-22T07:30:00.000Z'),
    fetchSnapshot: async () => {
      requested = true;
      return snapshot();
    },
  });

  const result = await handler({ requestContext: { http: { method: 'GET' } } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['x-cloud-cache'], 'cached');
  assert.equal(json(result).cache.status, 'cached');
  assert.equal(json(result).cache.ageSeconds, 1800);
  assert.equal(requested, false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].input.Bucket, 'unit-test-clouds');
});

test('an expired snapshot is refreshed and only a validated result is written to S3', async () => {
  const fresh = snapshot(NOW.toISOString());
  let options;
  const { handler, sends } = testHandler({
    cached: snapshot('2026-09-22T06:00:00.000Z'),
    fetchSnapshot: async (request) => {
      options = request;
      return fresh;
    },
  });

  const result = await handler({ requestContext: { http: { method: 'GET' } } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['x-cloud-cache'], 'refreshed');
  assert.equal(json(result).cache.status, 'refreshed');
  assert.equal(options.now, NOW);
  assert.equal(options.timeoutMs, 12345);
  assert.equal(sends.length, 2);
  assert.ok(sends[1] instanceof PutObjectCommand);
  assert.equal(sends[1].input.Key, 'clouds/current.json');
  assert.deepEqual(JSON.parse(sends[1].input.Body), fresh);
});

test('a failed refresh serves the last verified snapshot and never overwrites it', async () => {
  const { handler, sends } = testHandler({
    cached: snapshot('2026-09-22T06:00:00.000Z'),
    fetchSnapshot: async () => {
      throw new Error('weather provider timed out');
    },
  });

  const result = await handler({ requestContext: { http: { method: 'GET' } } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['x-cloud-cache'], 'stale');
  assert.equal(json(result).cache.status, 'stale');
  assert.equal(sends.length, 1);
});

test('an unavailable first refresh returns a clear 503 and non-GET requests are rejected', async () => {
  const { handler, sends } = testHandler({
    fetchSnapshot: async () => {
      throw new Error('weather provider timed out');
    },
  });

  const unavailable = await handler({ requestContext: { http: { method: 'GET' } } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers['x-cloud-cache'], 'unavailable');
  const methodNotAllowed = await handler({ requestContext: { http: { method: 'POST' } } });
  assert.equal(methodNotAllowed.statusCode, 405);
  assert.equal(sends.length, 1);
});
