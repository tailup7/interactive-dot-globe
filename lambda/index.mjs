import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { fetchCloudSnapshot } from '../scripts/fetch-clouds.mjs';

const DEFAULT_CACHE_TTL_SECONDS = 60 * 60;
const DEFAULT_TIMEOUT_MS = 40_000;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function configuration(environment = process.env) {
  return {
    bucket: environment.CLOUD_BUCKET?.trim(),
    key: environment.CLOUD_KEY?.trim() || 'clouds/current.json',
    cacheTtlSeconds: positiveInteger(
      environment.CACHE_TTL_SECONDS,
      DEFAULT_CACHE_TTL_SECONDS,
    ),
    timeoutMs: positiveInteger(environment.WEATHER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function response(statusCode, payload, cacheStatus) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Each page load asks Lambda to validate the server-side S3 cache. Do
      // not let an individual browser retain an older snapshot instead.
      'cache-control': 'no-store',
      'x-cloud-cache': cacheStatus,
    },
    body: JSON.stringify(payload),
  };
}

function missingObject(error) {
  return (
    error?.name === 'NoSuchKey' ||
    error?.Code === 'NoSuchKey' ||
    error?.$metadata?.httpStatusCode === 404
  );
}

async function bodyText(body) {
  if (!body) throw new Error('S3 returned an empty cloud snapshot.');
  if (typeof body.transformToString === 'function') return body.transformToString();
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (Symbol.asyncIterator in Object(body)) {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('S3 returned an unsupported cloud snapshot body.');
}

function validSnapshot(snapshot) {
  return (
    snapshot &&
    snapshot.version === 1 &&
    Number.isInteger(snapshot.width) &&
    Number.isInteger(snapshot.height) &&
    Array.isArray(snapshot.values) &&
    snapshot.values.length === snapshot.width * snapshot.height &&
    Number.isFinite(Date.parse(snapshot.fetchedAt))
  );
}

async function readSnapshot(s3, bucket, key) {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const snapshot = JSON.parse(await bodyText(object.Body));
    if (!validSnapshot(snapshot)) throw new Error('S3 cloud snapshot has an invalid shape.');
    return snapshot;
  } catch (error) {
    if (missingObject(error)) return null;
    throw error;
  }
}

function withCacheMetadata(snapshot, status, now) {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return {
    ...snapshot,
    cache: {
      status,
      checkedAt: now.toISOString(),
      ageSeconds: Math.max(0, Math.round((now.getTime() - fetchedAt) / 1000)),
    },
  };
}

/**
 * Build a Function URL handler. Dependencies are injectable so cache rules and
 * error paths can be tested without AWS credentials or a weather request.
 */
export function createCloudHandler({
  s3 = new S3Client({}),
  fetchSnapshot = fetchCloudSnapshot,
  environment = process.env,
  now = () => new Date(),
  logger = console,
} = {}) {
  return async function handler(event = {}) {
    const method = event.requestContext?.http?.method ?? event.httpMethod;
    if (method && method.toUpperCase() !== 'GET') {
      return response(405, { error: 'Only GET is supported.' }, 'method-not-allowed');
    }

    const { bucket, key, cacheTtlSeconds, timeoutMs } = configuration(environment);
    if (!bucket) {
      logger.error('CLOUD_BUCKET is not configured.');
      return response(500, { error: 'Cloud service is not configured.' }, 'misconfigured');
    }

    const checkedAt = now();
    let cached = null;
    try {
      cached = await readSnapshot(s3, bucket, key);
    } catch (error) {
      logger.error('Unable to read the cached cloud snapshot:', error);
    }

    const ageMilliseconds = cached
      ? checkedAt.getTime() - Date.parse(cached.fetchedAt)
      : Infinity;
    if (cached && ageMilliseconds >= 0 && ageMilliseconds < cacheTtlSeconds * 1000) {
      return response(200, withCacheMetadata(cached, 'cached', checkedAt), 'cached');
    }

    try {
      const refreshed = await fetchSnapshot({ now: checkedAt, timeoutMs });
      if (!validSnapshot(refreshed)) throw new Error('Weather service returned an invalid cloud snapshot.');
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(refreshed),
          ContentType: 'application/json; charset=utf-8',
          CacheControl: 'no-store',
        }),
      );
      return response(200, withCacheMetadata(refreshed, 'refreshed', checkedAt), 'refreshed');
    } catch (error) {
      logger.error('Unable to refresh the cloud snapshot:', error);
      if (cached) {
        return response(200, withCacheMetadata(cached, 'stale', checkedAt), 'stale');
      }
      return response(
        503,
        { error: 'Cloud data is temporarily unavailable.', checkedAt: checkedAt.toISOString() },
        'unavailable',
      );
    }
  };
}

export const handler = createCloudHandler();
