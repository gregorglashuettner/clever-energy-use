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
const apgCacheFile = path.join(dataDir, 'apg-cache.json');

const {
  PORT = 3000,
  APG_BASE_URL = 'https://transparency.apg.at/api',
  APG_LANGUAGE = 'English',
  APG_DAY_OFFSET = '0',
  WEBSITE_CHECK_SECRET,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:admin@example.com'
} = process.env;
const APG_RESOLUTION = 'PT15M';
const APG_CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

if (!WEBSITE_CHECK_SECRET) {
  throw new Error('Missing WEBSITE_CHECK_SECRET in environment');
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
        todayTypeDate: null,
        todayType: null,
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

  try {
    await fs.access(apgCacheFile);
  } catch {
    await fs.writeFile(apgCacheFile, JSON.stringify({ entries: {} }, null, 2), 'utf8');
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

function defaultNotificationSettings() {
  return {
    cheapAlertEnabled: false,
    weekdayStart: '08:00',
    weekdayEnd: '20:00',
    holidayStart: '10:00',
    holidayEnd: '18:00',
    dailyDigestEnabled: false
  };
}

function isValidHalfHourSlot(value) {
  if (typeof value !== 'string' || !/^\d{2}:(00|30)$/.test(value)) {
    return false;
  }
  const [h, m] = value.split(':').map(Number);
  const total = h * 60 + m;
  return total >= 240 && total <= 1320;
}

function normalizeNotificationSettings(input) {
  const defaults = defaultNotificationSettings();
  const raw = input && typeof input === 'object' ? input : {};
  const settings = { ...defaults };

  if (typeof raw.cheapAlertEnabled === 'boolean') {
    settings.cheapAlertEnabled = raw.cheapAlertEnabled;
  }

  for (const key of ['weekdayStart', 'weekdayEnd', 'holidayStart', 'holidayEnd']) {
    if (isValidHalfHourSlot(raw[key])) {
      settings[key] = raw[key];
    }
  }

  if (typeof raw.dailyDigestEnabled === 'boolean') {
    settings.dailyDigestEnabled = raw.dailyDigestEnabled;
  }

  return settings;
}

function getViennaNowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vienna',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute')
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateObjToKey(dateObj) {
  return `${String(dateObj.year)}-${pad2(dateObj.month)}-${pad2(dateObj.day)}`;
}

function timeToMinutes(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function addDaysObj(dateObj, days) {
  const dt = new Date(Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate()
  };
}

function buildAustriaHolidaySet(year) {
  const set = new Set([
    `${year}-01-01`,
    `${year}-01-06`,
    `${year}-05-01`,
    `${year}-08-15`,
    `${year}-10-26`,
    `${year}-11-01`,
    `${year}-12-08`,
    `${year}-12-25`,
    `${year}-12-26`
  ]);

  const easter = easterSunday(year);
  for (const offset of [1, 39, 50, 60]) {
    set.add(dateObjToKey(addDaysObj(easter, offset)));
  }
  return set;
}

function isAustriaHoliday(dateObj) {
  return buildAustriaHolidaySet(dateObj.year).has(dateObjToKey(dateObj));
}

function isWeekend(dateObj) {
  const dt = new Date(Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day));
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}

function pickWindowForDate(settings, dateObj) {
  const type = dayTypeForDate(dateObj);
  if (type === 'Feiertag/Wochenende') {
    return {
      start: settings.holidayStart,
      end: settings.holidayEnd,
      dayType: type
    };
  }
  return {
    start: settings.weekdayStart,
    end: settings.weekdayEnd,
    dayType: type
  };
}

function pickWindowForDayType(settings, dayType) {
  if (dayType === 'Feiertag/Wochenende') {
    return {
      start: settings.holidayStart,
      end: settings.holidayEnd,
      dayType
    };
  }
  return {
    start: settings.weekdayStart,
    end: settings.weekdayEnd,
    dayType: 'Werktag'
  };
}

function filterSeriesByWindow(series, windowStart, windowEnd) {
  const startMin = timeToMinutes(windowStart);
  const endMin = timeToMinutes(windowEnd);
  if (startMin == null || endMin == null || startMin >= endMin) {
    return [];
  }
  return (series || []).filter((row) => {
    const rowStart = timeToMinutes(row.timeFrom);
    return rowStart != null && rowStart >= startMin && rowStart < endMin;
  });
}

function findCheapestRange(series, slotCount = 3) {
  if (!Array.isArray(series) || series.length < slotCount) return null;
  const values = series.map((row) => Number(row.price));
  if (values.some((v) => !Number.isFinite(v))) return null;

  let sum = 0;
  for (let i = 0; i < slotCount; i += 1) sum += values[i];
  let bestStart = 0;
  let bestAvg = sum / slotCount;
  for (let i = 1; i <= values.length - slotCount; i += 1) {
    sum += values[i + slotCount - 1] - values[i - 1];
    const avg = sum / slotCount;
    if (avg < bestAvg) {
      bestAvg = avg;
      bestStart = i;
    }
  }
  return {
    start: series[bestStart],
    end: series[bestStart + slotCount - 1],
    average: bestAvg
  };
}

async function sendPushToEntry(entry, payload) {
  try {
    await webpush.sendNotification(entry.subscription, JSON.stringify(payload));
    return { ok: true, invalid: false };
  } catch (error) {
    const statusCode = error?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      return { ok: false, invalid: true };
    }
    return { ok: false, invalid: false };
  }
}

async function evaluateUserNotifications(apg, todayType) {
  const subscriptions = await readJson(subscriptionsFile, []);
  if (!subscriptions.length) {
    return { digestSent: 0, cheapSent: 0, removed: 0, total: 0, skipped: 'no_subscriptions' };
  }

  const now = getViennaNowParts();
  const todayKey = dateObjToKey(now);
  if (apg.targetDate !== todayKey) {
    return { digestSent: 0, cheapSent: 0, removed: 0, total: subscriptions.length, skipped: 'not_today_target' };
  }

  const nowMinutes = now.hour * 60 + now.minute;
  let digestSent = 0;
  let cheapSent = 0;
  let removed = 0;
  let changed = false;
  const keep = [];

  for (const entry of subscriptions) {
    const settings = normalizeNotificationSettings(entry.settings);
    const history = entry.notificationHistory && typeof entry.notificationHistory === 'object'
      ? entry.notificationHistory
      : {};
    const window = pickWindowForDayType(settings, todayType || dayTypeForDate(now));
    const startMin = timeToMinutes(window.start);
    const endMin = timeToMinutes(window.end);
    const inWindow =
      startMin != null &&
      endMin != null &&
      endMin > startMin &&
      nowMinutes >= startMin &&
      nowMinutes < endMin;

    let invalid = false;

    if (settings.dailyDigestEnabled && inWindow && history.lastDigestDate !== todayKey) {
      const payload = {
        title: 'Deine Benachrichtigung über den heutigen Strompreis',
        body: `Heute (${window.dayType}) im Zeitfenster ${window.start}-${window.end}: Durchschnitt ${apg.stats.average?.toFixed(2) ?? 'n/a'} EUR/MWh.`,
        url: '/',
        data: { type: 'daily_digest', targetDate: apg.targetDate }
      };
      const result = await sendPushToEntry(entry, payload);
      if (result.invalid) {
        invalid = true;
      } else if (result.ok) {
        digestSent += 1;
        history.lastDigestDate = todayKey;
        changed = true;
      }
    }

    if (!invalid && settings.cheapAlertEnabled && inWindow && history.lastCheapAlertDate !== todayKey) {
      const inWindowSeries = filterSeriesByWindow(apg.series, window.start, window.end);
      const cheapest = findCheapestRange(inWindowSeries, 3);
      if (cheapest) {
        const cheapStart = timeToMinutes(cheapest.start.timeFrom);
        const cheapEnd = timeToMinutes(cheapest.end.timeTo);
        const inCheapRange =
          cheapStart != null &&
          cheapEnd != null &&
          cheapEnd > cheapStart &&
          nowMinutes >= cheapStart &&
          nowMinutes < cheapEnd;
        if (inCheapRange) {
          const payload = {
            title: 'Der Strom ist ab jetzt billig!',
            body: `${window.dayType} ${window.start}-${window.end}: günstigster Bereich gestartet (${cheapest.start.timeFrom}-${cheapest.end.timeTo}).`,
            url: '/',
            data: { type: 'cheap_alert', targetDate: apg.targetDate }
          };
          const result = await sendPushToEntry(entry, payload);
          if (result.invalid) {
            invalid = true;
          } else if (result.ok) {
            cheapSent += 1;
            history.lastCheapAlertDate = todayKey;
            changed = true;
          }
        }
      }
    }

    if (invalid) {
      removed += 1;
      changed = true;
      continue;
    }

    keep.push({
      ...entry,
      settings,
      notificationHistory: history
    });
  }

  if (changed) {
    await writeJson(subscriptionsFile, keep);
  }

  return {
    digestSent,
    cheapSent,
    removed,
    total: subscriptions.length,
    skipped: null
  };
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

function dayTypeForDate(dateObj) {
  return isAustriaHoliday(dateObj) || isWeekend(dateObj)
    ? 'Feiertag/Wochenende'
    : 'Werktag';
}

function resolveTodayType(state) {
  const now = getViennaNowParts();
  const todayKey = dateObjToKey(now);
  const persistedType = state?.todayType;
  if (
    state?.todayTypeDate === todayKey &&
    (persistedType === 'Werktag' || persistedType === 'Feiertag/Wochenende')
  ) {
    return { todayType: persistedType, todayTypeDate: todayKey };
  }

  return {
    todayType: dayTypeForDate(now),
    todayTypeDate: todayKey
  };
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

async function fetchApgDayAhead({ date, language }) {
  const targetDate = getTargetDate(date);
  const toDate = addDays(targetDate, 1);

  const fromlocal = toApgDateTimeStartOfDay(targetDate);
  const tolocal = toApgDateTimeStartOfDay(toDate);

  const url = `${APG_BASE_URL}/v1/EXAAD1P/Data/${encodeURIComponent(language)}/${APG_RESOLUTION}/${fromlocal}/${tolocal}`;

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
    endpoint: '/v1/EXAAD1P/Data/{language}/PT15M/{fromlocal}/{tolocal}',
    request: { language, resolution: APG_RESOLUTION },
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

function apgCacheKey(date, language) {
  return `${date}|${language}|${APG_RESOLUTION}`;
}

async function getCachedOrFetchApgDayAhead({ date, language }) {
  const targetDate = getTargetDate(date);
  const cache = await readJson(apgCacheFile, { entries: {} });
  const entries = cache?.entries && typeof cache.entries === 'object' ? cache.entries : {};
  const key = apgCacheKey(targetDate, language);
  const entry = entries[key];

  if (entry?.fetchedAt && entry?.apg) {
    const fetchedAtMs = Date.parse(entry.fetchedAt);
    if (Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs <= APG_CACHE_MAX_AGE_MS) {
      return { apg: entry.apg, fromCache: true };
    }
  }

  const apg = await fetchApgDayAhead({ date: targetDate, language });
  entries[key] = {
    fetchedAt: new Date().toISOString(),
    apg
  };
  await writeJson(apgCacheFile, { entries });
  return { apg, fromCache: false };
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

  if (headerSecret === WEBSITE_CHECK_SECRET || querySecret === WEBSITE_CHECK_SECRET) {
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
    todayTypeDate: null,
    todayType: null,
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
    todayTypeDate: state.todayTypeDate,
    todayType: state.todayType,
    latestRun: state.history?.[0] ?? null,
    subscribers: subscriptions.length
  });
});

app.get('/api/data', async (req, res) => {
  try {
    const state = await readJson(stateFile, {
      lastCheckedAt: null,
      lastTargetDate: null,
      lastSignature: null,
      lastAveragePrice: null,
      todayTypeDate: null,
      todayType: null,
      history: []
    });
    const todayTypeInfo = resolveTodayType(state);
    const language = String(req.query.language || APG_LANGUAGE);
    const date = req.query.date ? String(req.query.date) : undefined;

    const { apg, fromCache } = await getCachedOrFetchApgDayAhead({ date, language });

    const sameScope =
      state.lastTargetDate === apg.targetDate &&
      state.lastLanguage === language;

    const hasChanged = sameScope && state.lastSignature != null ? state.lastSignature !== apg.signature : false;

    const previousAveragePrice = typeof state.lastAveragePrice === 'number' ? state.lastAveragePrice : null;
    const averagePriceDelta =
      previousAveragePrice == null || apg.stats.average == null
        ? null
        : apg.stats.average - previousAveragePrice;

    const runRecord = {
      at: new Date().toISOString(),
      trigger: 'data',
      targetDate: apg.targetDate,
      language,
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
      lastLanguage: language,
      lastSignature: apg.signature,
      lastAveragePrice: apg.stats.average,
      todayTypeDate: todayTypeInfo.todayTypeDate,
      todayType: todayTypeInfo.todayType,
      history: [runRecord, ...(state.history || [])].slice(0, 50)
    };

    await writeJson(stateFile, nextState);
    const userNotificationResult = await evaluateUserNotifications(apg, todayTypeInfo.todayType);

    res.json({
      ok: true,
      apg,
      hasChanged,
      averagePriceDelta,
      fromCache,
      userNotificationResult
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/spec', (_req, res) => {
  res.json({
    openApiSpec: 'https://transparency.apg.at/api/swagger/v1/swagger.json',
    swaggerUi: 'https://transparency.apg.at/api/swagger/index.html',
    dayAheadEndpoint: '/v1/EXAAD1P/Data/{language}/PT15M/{fromlocal}/{tolocal}',
    parameters: {
      language: ['English', 'German'],
      resolution: ['PT15M'],
      fromlocal: 'yyyy-MM-ddTHHmmss',
      tolocal: 'yyyy-MM-ddTHHmmss (max 1 day after fromlocal)'
    },
    valueColumns: ['MCAuctionPrice', 'MCReferencePrice', 'MCPrice_Chart']
  });
});

app.post('/api/subscribe', async (req, res) => {
  const subscription = req.body?.subscription;
  const settings = normalizeNotificationSettings(req.body?.settings);

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid push subscription payload' });
  }

  const subscriptions = await readJson(subscriptionsFile, []);
  const id = subscriptionId(subscription);
  const existingIndex = subscriptions.findIndex((entry) => entry.id === id);

  const entry = {
    id,
    subscription,
    settings,
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

app.post('/api/settings', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  const settings = normalizeNotificationSettings(req.body?.settings);
  const subscriptions = await readJson(subscriptionsFile, []);
  const idx = subscriptions.findIndex((entry) => entry.subscription?.endpoint === endpoint);

  if (idx < 0) {
    return res.status(404).json({ error: 'Subscription not found' });
  }

  subscriptions[idx] = {
    ...subscriptions[idx],
    settings
  };

  await writeJson(subscriptionsFile, subscriptions);
  return res.json({ ok: true });
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
      todayTypeDate: null,
      todayType: null,
      history: []
    });
    const todayTypeInfo = resolveTodayType(state);

    const language = String(req.query.language || APG_LANGUAGE);
    const date = req.query.date ? String(req.query.date) : undefined;

    const { apg, fromCache } = await getCachedOrFetchApgDayAhead({ date, language });

    const sameScope =
      state.lastTargetDate === apg.targetDate &&
      state.lastLanguage === language;

    const hasChanged = sameScope && state.lastSignature != null ? state.lastSignature !== apg.signature : false;

    const previousAveragePrice = typeof state.lastAveragePrice === 'number' ? state.lastAveragePrice : null;
    const averagePriceDelta =
      previousAveragePrice == null || apg.stats.average == null
        ? null
        : apg.stats.average - previousAveragePrice;

    const runRecord = {
      at: new Date().toISOString(),
      trigger: 'check',
      targetDate: apg.targetDate,
      language,
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
      lastLanguage: language,
      lastSignature: apg.signature,
      lastAveragePrice: apg.stats.average,
      todayTypeDate: todayTypeInfo.todayTypeDate,
      todayType: todayTypeInfo.todayType,
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

    const userNotificationResult = await evaluateUserNotifications(apg, todayTypeInfo.todayType);

    res.json({
      ok: true,
      hasChanged,
      averagePriceDelta,
      apg,
      fromCache,
      pushResult,
      userNotificationResult
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
