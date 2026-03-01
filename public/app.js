const notificationToggle = document.getElementById('notificationToggle');
const notificationToggleState = document.getElementById('notificationToggleState');
const weekdayStartSelect = document.getElementById('weekdayStart');
const weekdayEndSelect = document.getElementById('weekdayEnd');
const holidayStartSelect = document.getElementById('holidayStart');
const holidayEndSelect = document.getElementById('holidayEnd');
const dailyDigestToggle = document.getElementById('dailyDigestToggle');
const dailyDigestState = document.getElementById('dailyDigestState');
const refreshBtn = document.getElementById('refreshBtn');
const statusEl = document.getElementById('status');
const cheapestRangeEl = document.getElementById('cheapestRange');

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

async function updateCheapestRange() {
  const data = await fetchJson('/data');
  const apg = data?.apg;
  const series = apg?.series || [];
  const cheapest = findCheapestRange(series, 45);

  if (!cheapest) {
    cheapestRangeEl.textContent = `Cheapest range (>=45 min, ${LOCAL_TIMEZONE}): unavailable`;
    return;
  }

  const startLabel = formatDateTime(cheapest.start.dateFrom, cheapest.start.timeFrom);
  const endLabel = formatDateTime(cheapest.end.dateTo, cheapest.end.timeTo);
  cheapestRangeEl.textContent =
    `Cheapest range (>=45 min, ${LOCAL_TIMEZONE}): ${startLabel} - ${endLabel} ` +
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

  try {
    const data = await fetchJson('/status');
    statusEl.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    statusEl.textContent = `Could not reach API.\n\n${error.message}`;
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
    updatePermissionText();
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
