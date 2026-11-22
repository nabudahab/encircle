import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { scoreIndianaRide, scoringVersion } from '../src/scoring.js';
import { getGame, getRide, initializeDatabase, removeRide, saveRide } from './database.js';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const maxBodyBytes = 24 * 1024 * 1024;
const maxTrackPoints = 250_000;
const clubYear = new Intl.DateTimeFormat('en-US', {
  calendar: 'iso8601',
  numberingSystem: 'latn',
  timeZone: 'America/Indiana/Indianapolis',
  year: 'numeric',
});
const datePattern = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseStartTime(value) {
  const match = typeof value === 'string' && value.match(datePattern);
  const date = new Date(match ? value : NaN);
  if (!Number.isFinite(date.getTime())) {
    throw new RequestError(400, 'startedAt must be an ISO timestamp with a time zone.');
  }

  const [, year, month, day] = match;
  const calendarDate = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (calendarDate.getUTCDate() !== Number(day) || Number(year) < 1000 || Number(year) >= 9999) {
    throw new RequestError(400, 'startedAt must be a valid calendar date between 1000 and 9998.');
  }
  return date;
}

function normalizeRide(body) {
  const date = parseStartTime(body?.startedAt);
  const segments = body?.segments;
  if (!Array.isArray(segments) || !segments.length) {
    throw new RequestError(400, 'segments must be a nonempty array of track segments.');
  }

  let pointCount = 0;
  const normalized = [];
  for (const segment of segments) {
    if (!Array.isArray(segment) || !segment.length) {
      throw new RequestError(400, 'Every track segment must include coordinates.');
    }
    pointCount += segment.length;
    if (pointCount > maxTrackPoints) {
      throw new RequestError(413, `A ride can contain up to ${maxTrackPoints} track points.`);
    }

    const points = segment.map((point) => {
      if (!Array.isArray(point) || point.length < 2 || point.length > 3 ||
          !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
        throw new RequestError(400, 'Each point must contain longitude, latitude, and optional elevation.');
      }
      return point.slice(0, 2);
    });
    if (points.length > 1) normalized.push(points);
  }
  if (!normalized.length) {
    throw new RequestError(400, 'Include at least one track segment with two or more points.');
  }

  const startedAt = date.toISOString();
  const playerId = clubYear.format(date).padStart(4, '0');
  const id = createHash('sha256').update(JSON.stringify([startedAt, normalized])).digest('hex');
  return { id, playerId, startedAt, segments: normalized };
}

function viewportBounds(url) {
  const keys = ['minColumn', 'minRow', 'maxColumn', 'maxRow'];
  if (!keys.some((key) => url.searchParams.has(key))) return null;
  const bounds = keys.map((key) => {
    const value = url.searchParams.get(key);
    const integer = /^-?\d+$/.test(value ?? '') ? Number(value) : NaN;
    if (!Number.isInteger(integer) || integer < -2147483648 || integer > 2147483647) {
      throw new RequestError(400, 'Supply minColumn, minRow, maxColumn, and maxRow as integers.');
    }
    return integer;
  });
  if (bounds[0] > bounds[2] || bounds[1] > bounds[3]) {
    throw new RequestError(400, 'Viewport minimums must be less than or equal to their maximums.');
  }
  return bounds;
}

async function readJson(request) {
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    throw new RequestError(413, 'The ride request exceeds 24 MiB.');
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      throw new RequestError(413, 'The ride request exceeds 24 MiB.');
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new RequestError(400, 'Send a valid JSON ride.');
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function importRide(pool, request, response) {
  const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new RequestError(415, 'Send the ride as application/json.');
  }
  const { id, playerId, startedAt, segments } = normalizeRide(await readJson(request));
  const existing = await getRide(pool, id);
  if (existing?.scoringVersion >= scoringVersion) {
    return sendJson(response, 200, {
      id, playerId: existing.playerId, passed: existing.passed, enclosed: existing.enclosed, duplicate: true,
    });
  }

  let scored;
  try {
    scored = await scoreIndianaRide(segments);
  } catch (error) {
    if (error instanceof RangeError) throw new RequestError(422, error.message);
    throw error;
  }
  let passed = 0;
  let enclosed = 0;
  const awards = scored.map((cell) => {
    passed += Number(cell.passed);
    enclosed += Number(cell.enclosed);
    return [cell.column, cell.row, Number(cell.passed) + Number(cell.enclosed)];
  });
  const published = { id, playerId, passed, enclosed };
  if (!awards.length && !existing) {
    return sendJson(response, 200, { ...published, duplicate: false });
  }

  const saved = await saveRide(pool, { ...published, startedAt, scoringVersion }, awards);
  return sendJson(response, saved && awards.length ? 201 : 200, { ...published, duplicate: !saved });
}

async function handleRequest(pool, request, response) {
  try {
    const host = URL.canParse(`http://${request.headers.host}`) && new URL(`http://${request.headers.host}`).hostname;
    if (!localHosts.has(host)) throw new RequestError(403, 'The pilot API accepts loopback requests only.');
    const origin = request.headers.origin;
    if (origin && (!URL.canParse(origin) || !localHosts.has(new URL(origin).hostname))) {
      throw new RequestError(403, 'Open Encircle from the local dashboard URL.');
    }
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/health') {
      await pool.query('SELECT 1');
      return sendJson(response, 200, { status: 'ok' });
    }
    if (request.method === 'GET' && url.pathname === '/api/game') {
      const game = await getGame(pool, viewportBounds(url));
      return sendJson(response, 200, game);
    }
    if (request.method === 'POST' && url.pathname === '/api/rides') {
      return await importRide(pool, request, response);
    }
    const rideMatch = url.pathname.match(/^\/api\/rides\/([a-f0-9]{64})$/);
    if (request.method === 'DELETE' && rideMatch) {
      const deleted = await removeRide(pool, rideMatch[1]);
      return sendJson(response, 200, { deleted });
    }
    return sendJson(response, 404, { error: 'API route not found.' });
  } catch (error) {
    if (error instanceof RequestError) {
      request.resume();
      return sendJson(response, error.status, { error: error.message });
    }
    console.error('API request failed.', error.message);
    return sendJson(response, 500, { error: 'The request could not be completed.' });
  }
}

async function start() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL to a PostgreSQL connection string before starting the API.');
  }
  const host = '127.0.0.1';
  const port = Number(process.env.ENCIRCLE_API_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ENCIRCLE_API_PORT must be an integer between 1 and 65535.');
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (error) => console.error('PostgreSQL connection error.', error.message));
  try {
    await initializeDatabase(pool);
    const server = createServer((request, response) => handleRequest(pool, request, response));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    console.log(`Encircle API listening on http://${host}:${port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        server.close(() => pool.end());
        server.closeIdleConnections();
      });
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
