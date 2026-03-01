const notificationToggle = document.getElementById('notificationToggle');
const notificationToggleState = document.getElementById('notificationToggleState');
const weekdayStartSelect = document.getElementById('weekdayStart');
const weekdayEndSelect = document.getElementById('weekdayEnd');
const holidayStartSelect = document.getElementById('holidayStart');
const holidayEndSelect = document.getElementById('holidayEnd');
const dailyDigestToggle = document.getElementById('dailyDigestToggle');
const dailyDigestState = document.getElementById('dailyDigestState');
const priceChartEl = document.getElementById('priceChart');
const priceChartMetaEl = document.getElementById('priceChartMeta');
const statusCardEl = document.getElementById('statusCard');
const refreshBtn = document.getElementById('refreshBtn');
const statusEl = document.getElementById('status');
const cheapestRangeEl = document.getElementById('cheapestRange');
const showDetails = new URLSearchParams(window.location.search).get('details') === 'yes';

let swRegistration;
const apiBase = new URL('./api/', window.location.href);
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
const SETTINGS_STORAGE_KEY = 'energy_watch_notification_settings';

function apiUrl(path) {
  const normalized = path.replace(/^\/+/, '');
  return new URL(normalized, apiBase).toString();
}

async function fetchJson(path, options = {}) {
  const url = apiUrl(path);
  const response = await fetch(url, options);
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`API did not return JSON from ${url}`);
  }

  if (!response.ok) {
    const error = new Error(`API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function normalizeDate(date) {
  const value = String(date || '');
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

function normalizeTime(time) {
  const value = String(time || '');
  if (/^\d{6}$/.test(value)) {
    return `${value.slice(0, 2)}:${value.slice(2, 4)}`;
  }
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    return value.slice(0, 5);
  }
  return value;
}

function formatDateTime(date, time) {
  return `${normalizeDate(date)} ${normalizeTime(time)}`.trim();
}

function parseTimeToMinutes(timeValue) {
  const normalized = normalizeTime(timeValue);
  const [h, m] = normalized.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function dateKey(dateObj) {
  return `${String(dateObj.year).padStart(4, '0')}-${String(dateObj.month).padStart(2, '0')}-${String(dateObj.day).padStart(2, '0')}`;
}

function getTodayInVienna() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vienna',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function getTodayViennaDateString() {
  const d = getTodayInVienna();
  return dateKey(d);
}

function getNowMinutesInVienna() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Vienna',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
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

function addDaysToDate(dateObj, days) {
  const dt = new Date(Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate()
  };
}

function buildAustriaHolidaySet(year) {
  const holidays = new Set([
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
  const easterMonday = addDaysToDate(easter, 1);
  const ascensionDay = addDaysToDate(easter, 39);
  const whitMonday = addDaysToDate(easter, 50);
  const corpusChristi = addDaysToDate(easter, 60);

  for (const d of [easterMonday, ascensionDay, whitMonday, corpusChristi]) {
    holidays.add(dateKey(d));
  }

  return holidays;
}

function getAustriaDayType(dateObj) {
  const dt = new Date(Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day));
  const weekday = dt.getUTCDay(); // 0=Sun, 6=Sat
  const isWeekend = weekday === 0 || weekday === 6;
  const holidays = buildAustriaHolidaySet(dateObj.year);
  const isHoliday = holidays.has(dateKey(dateObj));
  const isWorkday = !isWeekend && !isHoliday;
  return { isWorkday, isHoliday, isWeekend };
}

function filterSeriesByConfiguredWindow(series, settings) {
  const today = getTodayInVienna();
  const todayType = getAustriaDayType(today);
  const useHolidayWindow = todayType.isHoliday || todayType.isWeekend;

  const windowStart = useHolidayWindow ? settings.holidayStart : settings.weekdayStart;
  const windowEnd = useHolidayWindow ? settings.holidayEnd : settings.weekdayEnd;

  const startMinutes = parseTimeToMinutes(windowStart);
  const endMinutes = parseTimeToMinutes(windowEnd);
  if (startMinutes == null || endMinutes == null || startMinutes >= endMinutes) {
    return {
      filteredSeries: [],
      windowStart,
      windowEnd,
      useHolidayWindow,
      todayType,
      reason: 'Invalid configured time window'
    };
  }

  const filteredSeries = (series || []).filter((row) => {
    const rowTime = parseTimeToMinutes(row.timeFrom);
    if (rowTime == null) return false;
    return rowTime >= startMinutes && rowTime < endMinutes;
  });

  return {
    filteredSeries,
    windowStart,
    windowEnd,
    useHolidayWindow,
    todayType,
    reason: null
  };
}

function findCheapestRange(series, minimumMinutes = 45) {
  const slotMinutes = 15;
  const windowSize = Math.max(1, Math.ceil(minimumMinutes / slotMinutes));

  if (!Array.isArray(series) || series.length < windowSize) {
    return null;
  }

  const prices = series.map((row) => Number(row.price));
  if (prices.some((price) => !Number.isFinite(price))) {
    return null;
  }

  let currentSum = 0;
  for (let i = 0; i < windowSize; i += 1) {
    currentSum += prices[i];
  }

  let bestStart = 0;
  let bestAverage = currentSum / windowSize;

  for (let i = 1; i <= prices.length - windowSize; i += 1) {
    currentSum += prices[i + windowSize - 1] - prices[i - 1];
    const avg = currentSum / windowSize;
    if (avg < bestAverage) {
      bestAverage = avg;
      bestStart = i;
    }
  }

  const start = series[bestStart];
  const end = series[bestStart + windowSize - 1];

  return {
    start,
    end,
    average: bestAverage,
    durationMinutes: windowSize * slotMinutes
  };
}

function renderPriceChart(series, windowData) {
  if (!priceChartEl || !priceChartMetaEl) return;

  if (!Array.isArray(series) || series.length < 2) {
    priceChartEl.innerHTML =
      '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#3b5b56" font-size="14">Keine Daten im Zeitfenster</text>';
    const dayLabel = windowData.useHolidayWindow ? 'Feiertag/Wochenende' : 'Werktag';
    priceChartMetaEl.textContent = `${dayLabel}, ${windowData.windowStart}-${windowData.windowEnd}`;
    return;
  }

  const values = series.map((row) => Number(row.price)).filter((v) => Number.isFinite(v));
  if (values.length < 2) {
    priceChartEl.innerHTML =
      '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#3b5b56" font-size="14">Keine gültigen Preisdaten</text>';
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 700;
  const height = 240;
  const left = 42;
  const right = 18;
  const top = 16;
  const bottom = 30;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const points = series.map((row, idx) => {
    const x = left + (idx / (series.length - 1)) * plotW;
    const y = top + ((max - Number(row.price)) / range) * plotH;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const tickLabels = [];
  const seen = new Set();
  for (let idx = 0; idx < series.length; idx += 1) {
    const t = normalizeTime(series[idx].timeFrom);
    const [h, m] = t.split(':').map(Number);
    if (Number.isFinite(h) && Number.isFinite(m) && m === 0 && h % 2 === 0) {
      if (!seen.has(t)) {
        seen.add(t);
        const x = left + (idx / (series.length - 1)) * plotW;
        tickLabels.push({ x, label: t });
      }
    }
  }

  const tickLines = tickLabels
    .map(
      (tick) =>
        `<line x1="${tick.x.toFixed(2)}" y1="${height - bottom}" x2="${tick.x.toFixed(2)}" y2="${height - bottom + 6}" stroke="#9ec7bf" stroke-width="1" />`
    )
    .join('');
  const tickTexts = tickLabels
    .map(
      (tick) =>
        `<text x="${tick.x.toFixed(2)}" y="${height - 8}" text-anchor="middle" fill="#3b5b56" font-size="12">${tick.label}</text>`
    )
    .join('');

  const startMinutes = parseTimeToMinutes(windowData.windowStart);
  const endMinutes = parseTimeToMinutes(windowData.windowEnd);
  const nowMinutes = getNowMinutesInVienna();
  let currentTimeLine = '';
  if (
    nowMinutes != null &&
    startMinutes != null &&
    endMinutes != null &&
    endMinutes > startMinutes &&
    nowMinutes >= startMinutes &&
    nowMinutes < endMinutes
  ) {
    const ratio = (nowMinutes - startMinutes) / (endMinutes - startMinutes);
    const xNow = left + ratio * plotW;
    currentTimeLine = `<line x1="${xNow.toFixed(2)}" y1="${top}" x2="${xNow.toFixed(2)}" y2="${height - bottom}" stroke="#dc2626" stroke-width="2" />`;
  }

  priceChartEl.innerHTML = `
    <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" stroke="#9ec7bf" stroke-width="1" />
    <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" stroke="#9ec7bf" stroke-width="1" />
    <polyline fill="none" stroke="#0a7b68" stroke-width="2.5" points="${points.join(' ')}" />
    ${currentTimeLine}
    ${tickLines}
    ${tickTexts}
  `;

  const dayLabel = windowData.useHolidayWindow ? 'Feiertag/Wochenende' : 'Werktag';
  priceChartMetaEl.textContent = `${dayLabel}, ${windowData.windowStart}-${windowData.windowEnd}`;
}

async function updateCheapestRange() {
  const today = getTodayViennaDateString();
  const data = await fetchJson(`/data?date=${today}`);
  const apg = data?.apg;
  const series = apg?.series || [];
  const settings = loadNotificationSettings();
  const windowData = filterSeriesByConfiguredWindow(series, settings);
  renderPriceChart(windowData.filteredSeries, windowData);
  const cheapest = findCheapestRange(windowData.filteredSeries, 45);
  const windowLabel = `${windowData.windowStart}-${windowData.windowEnd}`;
  const dayLabel = windowData.useHolidayWindow ? 'Feiertag/Wochenende' : 'Werktag';

  if (!cheapest) {
    const reason = windowData.reason ? ` (${windowData.reason})` : '';
    cheapestRangeEl.textContent =
      `Cheapest range (>=45 min, ${LOCAL_TIMEZONE}, ${dayLabel}, Fenster ${windowLabel}): unavailable${reason}`;
    return;
  }

  const startLabel = formatDateTime(cheapest.start.dateFrom, cheapest.start.timeFrom);
  const endLabel = formatDateTime(cheapest.end.dateTo, cheapest.end.timeTo);
  cheapestRangeEl.textContent =
    `Cheapest range (>=45 min, ${LOCAL_TIMEZONE}, ${dayLabel}, Fenster ${windowLabel}): ${startLabel} - ${endLabel} ` +
    `(avg ${cheapest.average.toFixed(2)} EUR/MWh, ${cheapest.durationMinutes} min)`;
}

async function getVapidPublicKey() {
  const data = await fetchJson('/vapid-public-key');
  return data.publicKey;
}

async function updateStatus() {
  let cheapestRangeError = null;
  try {
    await updateCheapestRange();
  } catch (error) {
    cheapestRangeError = error;
  }

  if (showDetails) {
    try {
      const data = await fetchJson('/status');
      statusEl.textContent = JSON.stringify(data, null, 2);
    } catch (error) {
      statusEl.textContent = `Could not reach API.\n\n${error.message}`;
    }
  }

  if (cheapestRangeError) {
    cheapestRangeEl.textContent = `Cheapest range (>=45 min, ${LOCAL_TIMEZONE}): unavailable (${cheapestRangeError.message})`;
  }
}

function buildHalfHourSlots() {
  const slots = [];
  for (let hour = 4; hour <= 22; hour += 1) {
    const hh = String(hour).padStart(2, '0');
    slots.push(`${hh}:00`);
    if (hour !== 22) {
      slots.push(`${hh}:30`);
    }
  }
  return slots;
}

function populateTimeSelect(selectEl, slots) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  for (const slot of slots) {
    const option = document.createElement('option');
    option.value = slot;
    option.textContent = slot;
    selectEl.append(option);
  }
}

function getSettingsDefaults() {
  return {
    cheapAlertEnabled: false,
    weekdayStart: '08:00',
    weekdayEnd: '20:00',
    holidayStart: '10:00',
    holidayEnd: '18:00',
    dailyDigestEnabled: false
  };
}

function loadNotificationSettings() {
  const defaults = getSettingsDefaults();
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function saveNotificationSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore local storage failures.
  }
}

function collectNotificationSettings() {
  return {
    cheapAlertEnabled: notificationToggle.checked,
    weekdayStart: weekdayStartSelect.value,
    weekdayEnd: weekdayEndSelect.value,
    holidayStart: holidayStartSelect.value,
    holidayEnd: holidayEndSelect.value,
    dailyDigestEnabled: dailyDigestToggle.checked
  };
}

async function getCurrentSubscription() {
  if (!swRegistration) return null;
  return swRegistration.pushManager.getSubscription();
}

async function persistSettingsToServer(settings) {
  const subscription = await getCurrentSubscription();
  if (!subscription) return false;

  await fetchJson('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      settings
    })
  });

  return true;
}

function setDailyDigestState(enabled) {
  dailyDigestToggle.checked = enabled;
  dailyDigestState.textContent = enabled
    ? 'Tägliche Zusammenfassung: an'
    : 'Tägliche Zusammenfassung: aus';
}

function applyNotificationSettings(settings) {
  setToggleState(Boolean(settings.cheapAlertEnabled));
  weekdayStartSelect.value = settings.weekdayStart;
  weekdayEndSelect.value = settings.weekdayEnd;
  holidayStartSelect.value = settings.holidayStart;
  holidayEndSelect.value = settings.holidayEnd;
  setDailyDigestState(Boolean(settings.dailyDigestEnabled));
}

async function onNotificationSettingsChange() {
  const settings = collectNotificationSettings();
  saveNotificationSettings(settings);

  try {
    await persistSettingsToServer(settings);
  } catch (error) {
    console.error('Failed to persist settings to server:', error);
  }
}

function setToggleState(enabled) {
  notificationToggle.checked = enabled;
  notificationToggleState.textContent = enabled
    ? 'Benachrichtigen wenn der Strom billig wird: an'
    : 'Benachrichtigen wenn der Strom billig wird: aus';
}

async function subscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Web Push is not supported on this device/browser.');
  }

  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  if (Notification.permission !== 'granted') {
    throw new Error('Notification permission denied.');
  }

  if (!swRegistration) {
    throw new Error('Service worker not ready.');
  }

  const publicKey = await getVapidPublicKey();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);

  const existing = await swRegistration.pushManager.getSubscription();
  const subscription =
    existing ||
    (await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    }));

  await fetchJson('/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription,
      settings: collectNotificationSettings()
    })
  });

  return true;
}

async function unsubscribe() {
  if (!swRegistration) return;

  const subscription = await swRegistration.pushManager.getSubscription();
  if (!subscription) {
    return;
  }

  await fetchJson('/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });

  await subscription.unsubscribe();
}

function hasAnyPushFeatureEnabled(settings) {
  return Boolean(settings.cheapAlertEnabled || settings.dailyDigestEnabled);
}

async function ensurePushChannelForSettings(settings) {
  if (hasAnyPushFeatureEnabled(settings)) {
    await subscribe();
  } else {
    await unsubscribe();
  }
}

async function handleFeatureToggleChange() {
  const previousSettings = loadNotificationSettings();
  const nextSettings = collectNotificationSettings();

  notificationToggle.disabled = true;
  dailyDigestToggle.disabled = true;
  setToggleState(nextSettings.cheapAlertEnabled);
  setDailyDigestState(nextSettings.dailyDigestEnabled);

  try {
    await ensurePushChannelForSettings(nextSettings);
    saveNotificationSettings(nextSettings);
    await onNotificationSettingsChange();
    await updateStatus();
  } catch (error) {
    applyNotificationSettings(previousSettings);
    saveNotificationSettings(previousSettings);
    try {
      await ensurePushChannelForSettings(previousSettings);
      await onNotificationSettingsChange();
    } catch {
      // best effort rollback
    }
    alert(`Notification update failed: ${error.message}`);
  } finally {
    notificationToggle.disabled = false;
    dailyDigestToggle.disabled = false;
  }
}

async function onNotificationToggleChange() {
  await handleFeatureToggleChange();
}

async function onDailyDigestToggleChange() {
  await handleFeatureToggleChange();
}

async function refreshData() {
  const originalLabel = refreshBtn.textContent;
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Refreshing...';

  try {
    await updateStatus();
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = originalLabel;
  }
}

async function init() {
  if (showDetails) {
    statusCardEl?.classList.remove('hidden');
  }

  const slots = buildHalfHourSlots();
  populateTimeSelect(weekdayStartSelect, slots);
  populateTimeSelect(weekdayEndSelect, slots);
  populateTimeSelect(holidayStartSelect, slots);
  populateTimeSelect(holidayEndSelect, slots);
  applyNotificationSettings(loadNotificationSettings());

  swRegistration = await navigator.serviceWorker.register('./sw.js');
  const subscription = await getCurrentSubscription();
  if (!subscription) {
    const settings = {
      ...loadNotificationSettings(),
      cheapAlertEnabled: false,
      dailyDigestEnabled: false
    };
    applyNotificationSettings(settings);
    saveNotificationSettings(settings);
  } else {
    await onNotificationSettingsChange();
  }
  await updateStatus();

  notificationToggle.addEventListener('change', onNotificationToggleChange);
  weekdayStartSelect.addEventListener('change', onNotificationSettingsChange);
  weekdayEndSelect.addEventListener('change', onNotificationSettingsChange);
  holidayStartSelect.addEventListener('change', onNotificationSettingsChange);
  holidayEndSelect.addEventListener('change', onNotificationSettingsChange);
  dailyDigestToggle.addEventListener('change', onDailyDigestToggleChange);
  refreshBtn.addEventListener('click', refreshData);
}

init().catch((error) => {
  statusEl.textContent = `Initialization failed: ${error.message}`;
});
