const TAU = Math.PI * 2;
const MAX_PIXELS = 4096 * 2048;

function timestamp(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid cloud ${field}`);
  }
  return new Date(value).toISOString();
}

/** Validate the bundled snapshot before using it as a geographic lookup. */
export function parseCloudSnapshot(data) {
  if (
    !data ||
    data.version !== 1 ||
    !Number.isInteger(data.width) ||
    !Number.isInteger(data.height) ||
    data.width <= 0 ||
    data.height <= 0 ||
    data.width * data.height > MAX_PIXELS ||
    !Array.isArray(data.values) ||
    data.values.length !== data.width * data.height
  ) {
    throw new Error("Invalid cloud grid dimensions or version");
  }
  const source = data.source;
  if (
    !source ||
    typeof source.name !== "string" ||
    !source.name.trim() ||
    typeof source.attribution !== "string" ||
    !source.attribution.trim() ||
    !["forecast", "analysis", "satellite"].includes(source.kind)
  ) {
    throw new Error("Invalid cloud source");
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(source.url);
  } catch {
    throw new Error("Invalid cloud source URL");
  }
  if (!["https:", "http:"].includes(sourceUrl.protocol))
    throw new Error("Invalid cloud source URL");
  let count = 0;
  const values = new Float32Array(data.values.length);
  for (let i = 0; i < data.values.length; i++) {
    const value = data.values[i];
    if (value === null) {
      values[i] = NaN;
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new Error("Invalid cloud cover value");
    }
    values[i] = value;
    count++;
  }
  if (!count) throw new Error("Cloud snapshot contains no valid data");
  return {
    width: data.width,
    height: data.height,
    values,
    coverage: count / values.length,
    observedAt: timestamp(data.observedAt, "observedAt"),
    fetchedAt: timestamp(data.fetchedAt, "fetchedAt"),
    ...(data.modelRunAt
      ? { modelRunAt: timestamp(data.modelRunAt, "modelRunAt") }
      : {}),
    source: { ...source, url: sourceUrl.href },
  };
}

/**
 * Same equirectangular pixel-center convention as the terrain map. Missing
 * neighbors do not darken valid clouds; a completely missing area stays clear
 * visually, with the incomplete coverage explicitly reported in the UI.
 */
export function sampleCloudCover(clouds, x, y, z) {
  const { width, height, values } = clouds;
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
  const y1 = Math.min(height - 1, top + 1);
  const tx = u - left;
  const ty = v - top;
  const a = values[top * width + x0];
  const b = values[top * width + x1];
  const c = values[y1 * width + x0];
  const d = values[y1 * width + x1];
  let total = 0;
  let weight = 0;
  if (Number.isFinite(a)) {
    const w = (1 - tx) * (1 - ty);
    total += a * w;
    weight += w;
  }
  if (Number.isFinite(b)) {
    const w = tx * (1 - ty);
    total += b * w;
    weight += w;
  }
  if (Number.isFinite(c)) {
    const w = (1 - tx) * ty;
    total += c * w;
    weight += w;
  }
  if (Number.isFinite(d)) {
    const w = tx * ty;
    total += d * w;
    weight += w;
  }
  return weight > 0 ? Math.max(0, Math.min(1, total / weight)) : 0;
}
