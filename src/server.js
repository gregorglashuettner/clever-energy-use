import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const stateFile = path.join(dataDir, 'state.json');
const subscriptionsFile = path.join(dataDir, 'subscriptions.json');

const {
  PORT = 3000,
  APG_BASE_URL = 'https://transparency.apg.at/api',
  APG_LANGUAGE = 'English',
  APG_RESOLUTION = 'PT15M',
  APG_DAY_OFFSET = '1',
  CHECK_SECRET,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:admin@example.com'
} = process.env;

if (!CHECK_SECRET) {
  throw new Error('Missing CHECK_SECRET in environment');
}
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  throw new Error('Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY in environment');
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));

async function ensureDataFiles() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(stateFile);
  } catch {
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        lastCheckedAt: null,
        lastTargetDate: null,
        lastSignature: null,
        lastAveragePrice: null,
        history: []
      }, null, 2),
      'utf8'
    );
  }

  try {
    await fs.access(subscriptionsFile);
  } catch {
    await fs.writeFile(subscriptionsFile, JSON.stringify([], null, 2), 'utf8');
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function subscriptionId(subscription) {
  return crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
}

function todayViennaDateString() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vienna',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
}

function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = String(dt.getUTCFullYear());
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toApgDateTimeStartOfDay(dateString) {
  return `${dateString}T000000`;
}

function getTargetDate(requestedDate) {
  if (requestedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD');
    }
    return requestedDate;
  }

  const offset = Number.parseInt(APG_DAY_OFFSET, 10);
  const safeOffset = Number.isFinite(offset) ? offset : 1;
  return addDays(todayViennaDateString(), safeOffset);
}

function pickPriceValue(columnNames, rowValues) {
  const priorityColumns = ['MCPrice_Chart', 'MCAuctionPrice', 'MCReferencePrice'];

  for (const name of priorityColumns) {
    const idx = columnNames.indexOf(name);
    if (idx < 0) continue;
    const candidate = rowValues?.[idx]?.V;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return { value: candidate, column: name };
    }
  }

  return { value: null, column: null };
}

function calculatePriceStats(series) {
  const values = series.map((item) => item.price).filter((v) => Number.isFinite(v));

  if (!values.length) {
    return {
      count: 0,
      average: null,
      min: null,
      max: null,
      spread: null,
      negativeHours: 0,
      first: null,
      last: null,
      dayDelta: null
    };
  }

  const sum = values.reduce((acc, v) => acc + v, 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const first = values[0];
  const last = values[values.length - 1];

  return {
    count: values.length,
    average: sum / values.length,
    min,
    max,
    spread: max - min,
    negativeHours: values.filter((v) => v < 0).length,
    first,
    last,
    dayDelta: last - first
  };
}

function buildSeriesSignature(series) {
  const compact = series.map((row) => Number(row.price).toFixed(4)).join('|');
  return crypto.createHash('sha256').update(compact).digest('hex');
}

async function fetchApgDayAhead({ date, resolution, language }) {
  const targetDate = getTargetDate(date);
  const toDate = addDays(targetDate, 1);

  const fromlocal = toApgDateTimeStartOfDay(targetDate);
  const tolocal = toApgDateTimeStartOfDay(toDate);

  const url = `${APG_BASE_URL}/v1/EXAAD1P/Data/${encodeURIComponent(language)}/${encodeURIComponent(resolution)}/${fromlocal}/${tolocal}`;

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'clever-energy-use-bot/1.0'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`APG request failed (${response.status}): ${body.slice(0, 240)}`);
  }

  const payload = await response.json();
  const responseData = payload?.ResponseData;

  if (!responseData || !Array.isArray(responseData.ValueRows) || !Array.isArray(responseData.ValueColumns)) {
    throw new Error('Unexpected APG response format');
  }

  const columnNames = responseData.ValueColumns.map((c) => c.InternalName);
  const series = [];

  for (const row of responseData.ValueRows) {
    const { value, column } = pickPriceValue(columnNames, row.V || []);
    if (typeof value !== 'number') continue;

    series.push({
      dateFrom: row.DF,
      timeFrom: row.TF,
      dateTo: row.DT,
      timeTo: row.TT,
      price: value,
      sourceColumn: column
    });
  }

  const stats = calculatePriceStats(series);

  return {
    targetDate,
    range: { fromlocal, tolocal },
    endpoint: '/v1/EXAAD1P/Data/{language}/{resolution}/{fromlocal}/{tolocal}',
    request: { language, resolution },
    sourceUrl: url,
    versionInformation: responseData.VersionInformation || null,
    description: responseData.Description || null,
    columns: columnNames,
    series,
    stats,
    signature: buildSeriesSignature(series),
    fetchedAt: new Date().toISOString()
  };
}

async function sendPushToAll(payload) {
  const subscriptions = await readJson(subscriptionsFile, []);
  if (!subscriptions.length) {
    return { sent: 0, removed: 0, total: 0 };
  }

  let sent = 0;
  let removed = 0;
  const keep = [];

  for (const entry of subscriptions) {
    try {
      await webpush.sendNotification(entry.subscription, JSON.stringify(payload));
      sent += 1;
      keep.push(entry);
    } catch (error) {
      const statusCode = error?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        removed += 1;
      } else {
        keep.push(entry);
      }
    }
  }

  if (removed > 0) {
    await writeJson(subscriptionsFile, keep);
  }

  return { sent, removed, total: subscriptions.length };
}

function assertSecret(req, res, next) {
  const authHeader = req.get('authorization');
  const headerSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const querySecret = req.query.secret;

  if (headerSecret === CHECK_SECRET || querySecret === CHECK_SECRET) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/vapid-public-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.get('/api/status', async (_req, res) => {
  const state = await readJson(stateFile, {
    lastCheckedAt: null,
    lastTargetDate: null,
    lastSignature: null,
    lastAveragePrice: null,
    history: []
  });
  const subscriptions = await readJson(subscriptionsFile, []);

  res.json({
    source: 'APG EXAAD1P day-ahead prices',
    apgBaseUrl: APG_BASE_URL,
    defaultLanguage: APG_LANGUAGE,
    defaultResolution: APG_RESOLUTION,
    defaultDayOffset: Number.parseInt(APG_DAY_OFFSET, 10),
    lastTargetDate: state.lastTargetDate,
    lastAveragePrice: state.lastAveragePrice,
    lastCheckedAt: state.lastCheckedAt,
    latestRun: state.history?.[0] ?? null,
    subscribers: subscriptions.length
  });
});

app.get('/api/data', async (req, res) => {
  try {
    const language = String(req.query.language || APG_LANGUAGE);
    const resolution = String(req.query.resolution || APG_RESOLUTION);
    const date = req.query.date ? String(req.query.date) : undefined;

    const result = await fetchApgDayAhead({ date, resolution, language });

    res.json({
      ok: true,
      apg: result
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/spec', (_req, res) => {
  res.json({
    openApiSpec: 'https://transparency.apg.at/api/swagger/v1/swagger.json',
    swaggerUi: 'https://transparency.apg.at/api/swagger/index.html',
    dayAheadEndpoint: '/v1/EXAAD1P/Data/{language}/{resolution}/{fromlocal}/{tolocal}',
    parameters: {
      language: ['English', 'German'],
      resolution: ['PT15M', 'PT60M'],
      fromlocal: 'yyyy-MM-ddTHHmmss',
      tolocal: 'yyyy-MM-ddTHHmmss (max 1 day after fromlocal)'
    },
    valueColumns: ['MCAuctionPrice', 'MCReferencePrice', 'MCPrice_Chart']
  });
});

app.post('/api/subscribe', async (req, res) => {
  const subscription = req.body?.subscription;
  const deviceName = req.body?.deviceName || 'Unnamed device';

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid push subscription payload' });
  }

  const subscriptions = await readJson(subscriptionsFile, []);
  const id = subscriptionId(subscription);
  const existingIndex = subscriptions.findIndex((entry) => entry.id === id);

  const entry = {
    id,
    deviceName,
    subscription,
    createdAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    subscriptions[existingIndex] = { ...subscriptions[existingIndex], ...entry };
  } else {
    subscriptions.push(entry);
  }

  await writeJson(subscriptionsFile, subscriptions);

  return res.json({ ok: true, id });
});

app.post('/api/unsubscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  const subscriptions = await readJson(subscriptionsFile, []);
  const filtered = subscriptions.filter((entry) => entry.subscription.endpoint !== endpoint);

  await writeJson(subscriptionsFile, filtered);
  return res.json({ ok: true, removed: subscriptions.length - filtered.length });
});

app.post('/api/check', assertSecret, async (req, res) => {
  try {
    const state = await readJson(stateFile, {
      lastCheckedAt: null,
      lastTargetDate: null,
      lastSignature: null,
      lastAveragePrice: null,
      history: []
    });

    const language = String(req.query.language || APG_LANGUAGE);
    const resolution = String(req.query.resolution || APG_RESOLUTION);
    const date = req.query.date ? String(req.query.date) : undefined;

    const apg = await fetchApgDayAhead({ date, resolution, language });

    const sameScope =
      state.lastTargetDate === apg.targetDate &&
      state.lastResolution === resolution &&
      state.lastLanguage === language;

    const hasChanged = sameScope && state.lastSignature != null ? state.lastSignature !== apg.signature : false;

    const previousAveragePrice = typeof state.lastAveragePrice === 'number' ? state.lastAveragePrice : null;
    const averagePriceDelta =
      previousAveragePrice == null || apg.stats.average == null
        ? null
        : apg.stats.average - previousAveragePrice;

    const runRecord = {
      at: new Date().toISOString(),
      targetDate: apg.targetDate,
      language,
      resolution,
      averagePrice: apg.stats.average,
      minPrice: apg.stats.min,
      maxPrice: apg.stats.max,
      spread: apg.stats.spread,
      negativeHours: apg.stats.negativeHours,
      priceCount: apg.stats.count,
      hasChanged,
      averagePriceDelta,
      signature: apg.signature,
      sourceVersion: apg.versionInformation
    };

    const nextState = {
      lastCheckedAt: runRecord.at,
      lastTargetDate: apg.targetDate,
      lastResolution: resolution,
      lastLanguage: language,
      lastSignature: apg.signature,
      lastAveragePrice: apg.stats.average,
      history: [runRecord, ...(state.history || [])].slice(0, 50)
    };

    await writeJson(stateFile, nextState);

    let pushResult = { sent: 0, removed: 0, total: 0 };

    if (hasChanged) {
      const avg = apg.stats.average == null ? 'n/a' : `${apg.stats.average.toFixed(2)} EUR/MWh`;
      const body = `Date ${apg.targetDate}: avg ${avg}, min ${apg.stats.min?.toFixed(2)}, max ${apg.stats.max?.toFixed(2)}`;

      pushResult = await sendPushToAll({
        title: 'APG day-ahead prices changed',
        body,
        url: '/',
        data: {
          targetDate: apg.targetDate,
          averagePrice: apg.stats.average,
          minPrice: apg.stats.min,
          maxPrice: apg.stats.max,
          spread: apg.stats.spread,
          negativeHours: apg.stats.negativeHours,
          checkedAt: runRecord.at
        }
      });
    }

    res.json({
      ok: true,
      hasChanged,
      averagePriceDelta,
      apg,
      pushResult
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(rootDir, 'public', 'index.html'));
});

await ensureDataFiles();

app.listen(Number(PORT), () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
