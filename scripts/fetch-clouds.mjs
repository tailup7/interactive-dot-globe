import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOUD_API = 'https://thredds.ucar.edu/thredds/ncss/grid/grib/NCEP/GFS/Global_0p5deg/best';
export const CLOUD_VARIABLE = 'Total_cloud_cover_entire_atmosphere';
const OUTPUT = fileURLToPath(new URL('../public/data/clouds.json', import.meta.url));
const TYPE_BYTES = [0, 1, 1, 2, 4, 4, 8];

/** Read the small, fixed-size classic NetCDF response supplied by NCSS.
 * Record variables / NetCDF-4 are deliberately rejected rather than misread.
 * Format: https://docs.unidata.ucar.edu/netcdf-c/current/file_format_specifications.html
 */
export function readNetcdf(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 4).toString('hex') !== '43444601') {
    throw new Error('The weather API did not return a classic NetCDF (CDF-1) file.');
  }
  let offset = 4;
  const uint = () => { const value = buffer.readUInt32BE(offset); offset += 4; return value; };
  const name = () => {
    const size = uint();
    if (size > buffer.length - offset) throw new Error('Truncated NetCDF name.');
    const value = buffer.toString('utf8', offset, offset + size);
    offset += Math.ceil(size / 4) * 4;
    return value;
  };
  const numbers = (position, type, count) => {
    const size = TYPE_BYTES[type];
    if (!size || !Number.isSafeInteger(count) || count * size > buffer.length - position) {
      throw new Error('Unsupported or truncated NetCDF value.');
    }
    if (type === 2) return buffer.toString('utf8', position, position + count);
    const readers = { 1: 'readInt8', 3: 'readInt16BE', 4: 'readInt32BE', 5: 'readFloatBE', 6: 'readDoubleBE' };
    return Array.from({ length: count }, (_, index) => buffer[readers[type]](position + index * size));
  };
  const list = (expected, readItem) => {
    const tag = uint();
    const count = uint();
    if (tag === 0 && count === 0) return [];
    if (tag !== expected || count > 10000) throw new Error('Invalid NetCDF header list.');
    return Array.from({ length: count }, readItem);
  };
  const attributes = () => Object.fromEntries(list(12, () => {
    const key = name();
    const type = uint();
    const count = uint();
    const value = numbers(offset, type, count);
    offset += Math.ceil(count * TYPE_BYTES[type] / 4) * 4;
    return [key, value];
  }));
  const records = uint();
  if (records !== 0) throw new Error('Record-based NetCDF is not supported by this snapshot reader.');
  const dimensions = list(10, () => ({ name: name(), size: uint() }));
  const globalAttributes = attributes();
  const variables = list(11, () => {
    const variableName = name();
    const rank = uint();
    if (rank > 8) throw new Error('Unexpected NetCDF variable rank.');
    const dimensionIds = Array.from({ length: rank }, uint);
    const variableAttributes = attributes();
    const type = uint();
    uint(); // Padded storage size; actual element count comes from dimensions.
    const position = uint();
    const shape = dimensionIds.map((id) => dimensions[id]?.size);
    if (shape.some((size) => !size)) throw new Error('Invalid or unlimited NetCDF dimension.');
    const values = numbers(position, type, shape.reduce((size, item) => size * item, 1));
    return [variableName, { dimensions: dimensionIds.map((id) => dimensions[id].name), shape, attributes: variableAttributes, values }];
  });
  return { attributes: globalAttributes, variables: Object.fromEntries(variables) };
}

function coordinateTime(variable) {
  const units = variable?.attributes.units;
  const match = /^(seconds?|minutes?|hours?|days?) since (.+)$/i.exec(units ?? '');
  if (!match || variable.values.length !== 1) throw new Error('Missing or unsupported weather data timestamp.');
  const multiplier = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };
  const originText = match[2].replace(/ UTC$/i, 'Z');
  const origin = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(originText) ? originText : `${originText}Z`);
  const milliseconds = origin + variable.values[0] * multiplier[match[1].toLowerCase().replace(/s$/, '')];
  if (!Number.isFinite(milliseconds)) throw new Error('Invalid weather data timestamp.');
  return new Date(milliseconds).toISOString();
}

function regularAxis(values, label) {
  if (values.length < 2) throw new Error(`Missing ${label} coordinate grid.`);
  const step = values[1] - values[0];
  if (!Number.isFinite(step) || step === 0 || values.some((value, index) => !Number.isFinite(value) || Math.abs(value - values[0] - index * step) > 0.001)) {
    throw new Error(`Unexpected ${label} coordinate spacing.`);
  }
  return step;
}

/** Resample using the actual coordinate axes, including longitude wrap.
 * The output cells are centered at (-179.5, 89.5), ... (179.5, -89.5).
 */
export function createSnapshot(dataset, { width = 360, height = 180, now = new Date(), requestUrl = CLOUD_API } = {}) {
  const { variables } = dataset;
  const cloud = variables[CLOUD_VARIABLE];
  const latitude = variables.latitude?.values;
  const longitude = variables.longitude?.values;
  if (!cloud || !latitude || !longitude || cloud.attributes.units !== '%') throw new Error('The API response is missing percent cloud cover or coordinates.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width * height > 1000000) throw new Error('Invalid snapshot dimensions.');
  if (cloud.dimensions.at(-2) !== 'latitude' || cloud.dimensions.at(-1) !== 'longitude' || cloud.shape.slice(0, -2).some((size) => size !== 1)) {
    throw new Error('Unexpected cloud cover dimension order.');
  }
  const latStep = regularAxis(latitude, 'latitude');
  const lonStep = regularAxis(longitude, 'longitude');
  const sourceWidth = longitude.length;
  const sourceHeight = latitude.length;
  if (cloud.shape.at(-2) !== sourceHeight || cloud.shape.at(-1) !== sourceWidth) throw new Error('Cloud cover shape does not match its coordinate axes.');
  if (lonStep <= 0 || Math.abs(sourceWidth * lonStep - 360) > 0.001 || Math.min(...latitude) > -89 || Math.max(...latitude) < 89) {
    throw new Error('The weather API did not return a complete global coordinate grid.');
  }
  if (cloud.values.length !== sourceWidth * sourceHeight) throw new Error('Cloud cover data length does not match its coordinates.');
  const timeName = cloud.dimensions.find((dimension) => /^time/.test(dimension));
  const observedAt = coordinateTime(variables[timeName]);
  if (Math.abs(Date.parse(observedAt) - now.getTime()) > 6 * 3600000) {
    throw new Error(`Cloud data valid at ${observedAt} is over six hours away from the requested current time.`);
  }
  const missing = [...(cloud.attributes._FillValue ?? []), ...(cloud.attributes.missing_value ?? [])];
  const normalized = cloud.values.map((value) => {
    if (!Number.isFinite(value) || missing.includes(value)) return null;
    if (value < -0.01 || value > 100.01) throw new Error(`Invalid cloud cover percentage: ${value}.`);
    return Math.max(0, Math.min(1, value / 100));
  });
  const values = new Array(width * height);
  for (let row = 0; row < height; row++) {
    const lat = 90 - (row + 0.5) * 180 / height;
    const sourceY = Math.max(0, Math.min(sourceHeight - 1, (lat - latitude[0]) / latStep));
    const top = Math.floor(sourceY);
    const bottom = Math.min(top + 1, sourceHeight - 1);
    const fy = sourceY - top;
    for (let column = 0; column < width; column++) {
      const lon = -180 + (column + 0.5) * 360 / width;
      const sourceX = ((lon - longitude[0]) / lonStep % sourceWidth + sourceWidth) % sourceWidth;
      const left = Math.floor(sourceX);
      const right = (left + 1) % sourceWidth;
      const fx = sourceX - left;
      const cells = [[top * sourceWidth + left, (1 - fx) * (1 - fy)], [top * sourceWidth + right, fx * (1 - fy)], [bottom * sourceWidth + left, (1 - fx) * fy], [bottom * sourceWidth + right, fx * fy]];
      // Missing cells remain missing; a lack of observations must not mean clear sky.
      values[row * width + column] = cells.some(([index, weight]) => weight > 0 && normalized[index] === null)
        ? null
        : Math.round(cells.reduce((sum, [index, weight]) => sum + (normalized[index] ?? 0) * weight, 0) * 1000) / 1000;
    }
  }
  const validCellCount = values.filter((value) => value !== null).length;
  if (validCellCount < values.length * 0.95) throw new Error('The current global cloud grid is incomplete (more than 5% missing).');
  const referenceName = cloud.attributes.coordinates?.split(/\s+/).find((coordinate) => variables[coordinate]?.attributes.standard_name === 'forecast_reference_time');
  const modelRunAt = referenceName ? coordinateTime(variables[referenceName]) : undefined;
  if (modelRunAt && (Date.parse(modelRunAt) < now.getTime() - 24 * 3600000 || Date.parse(modelRunAt) > now.getTime())) {
    throw new Error(`Cloud model run ${modelRunAt} is not a recent completed GFS run.`);
  }
  return {
    version: 1,
    width,
    height,
    values,
    observedAt,
    fetchedAt: now.toISOString(),
    ...(modelRunAt ? { modelRunAt } : {}),
    source: {
      name: 'NOAA GFS / NSF Unidata',
      url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast',
      attribution: 'NOAA/NCEP Global Forecast System; distributed by NSF Unidata / UCAR THREDDS',
      kind: 'forecast',
      requestUrl,
      variable: CLOUD_VARIABLE,
    },
    ...(validCellCount < values.length ? { warning: 'Missing cloud cells are displayed without a cloud overlay.' } : {}),
  };
}

export async function fetchCloudSnapshot({ fetchImpl = fetch, now = new Date(), timeoutMs = 45000 } = {}) {
  const url = new URL(CLOUD_API);
  url.search = new URLSearchParams({ var: CLOUD_VARIABLE, time: now.toISOString(), horizStride: '2', accept: 'netCDF' });
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/x-netcdf' } });
  if (!response.ok) throw new Error(`Weather API returned HTTP ${response.status} ${response.statusText}.`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 5000000) throw new Error('The weather API response is unexpectedly large.');
  return createSnapshot(readNetcdf(bytes), { now, requestUrl: url.href });
}

/** Replace the previous snapshot only after fetching and validating the new one. */
export async function updateCloudSnapshot({ output = OUTPUT, ...options } = {}) {
  const snapshot = await fetchCloudSnapshot(options);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8');
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const snapshot = await updateCloudSnapshot();
    console.log(`Cloud snapshot saved: ${snapshot.width}×${snapshot.height}, valid ${snapshot.observedAt} (NOAA GFS model estimate).`);
  } catch (error) {
    console.error(`Cloud snapshot download failed: ${error.message}\nThe existing snapshot was left unchanged. Check your internet connection and retry npm run fetch:clouds.`);
    process.exitCode = 1;
  }
}
