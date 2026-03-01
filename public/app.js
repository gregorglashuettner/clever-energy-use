const subscribeBtn = document.getElementById('subscribeBtn');
const unsubscribeBtn = document.getElementById('unsubscribeBtn');
const refreshBtn = document.getElementById('refreshBtn');
const checkBtn = document.getElementById('checkBtn');
const statusEl = document.getElementById('status');
const cheapestRangeEl = document.getElementById('cheapestRange');
const permissionStateEl = document.getElementById('permissionState');

let swRegistration;
const apiBase = new URL('./api/', window.location.href);
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
const WEBSITE_CHECK_SECRET_STORAGE_KEY = 'energy_watch_check_secret';

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
    throw new Error(`API request failed (${response.status})`);
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
  try {
    const data = await fetchJson('/status');
    statusEl.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    statusEl.textContent = `Could not reach API.\n\n${error.message}`;
  }

  try {
    await updateCheapestRange();
  } catch (error) {
    cheapestRangeEl.textContent = `Cheapest range (>=45 min, ${LOCAL_TIMEZONE}): unavailable (${error.message})`;
  }
}

function getStoredCheckSecret() {
  try {
    return localStorage.getItem(WEBSITE_CHECK_SECRET_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function setStoredCheckSecret(secret) {
  try {
    if (secret) {
      localStorage.setItem(WEBSITE_CHECK_SECRET_STORAGE_KEY, secret);
    }
  } catch {
    // Ignore storage failures.
  }
}

async function runSecureCheck({ promptIfMissing = true } = {}) {
  let secret = getStoredCheckSecret();

  if (!secret && promptIfMissing) {
    secret = prompt('Enter WEBSITE_CHECK_SECRET to run a secure check:') || '';
    if (!secret) return null;
    setStoredCheckSecret(secret);
  }

  if (!secret) return null;

  try {
    return await fetchJson('/check', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`
      }
    });
  } catch (error) {
    if (promptIfMissing) {
      try {
        localStorage.removeItem(WEBSITE_CHECK_SECRET_STORAGE_KEY);
      } catch {
        // Ignore storage failures.
      }
    }
    throw error;
  }
}

function updatePermissionText() {
  permissionStateEl.textContent = `Notification permission: ${Notification.permission}`;
}

async function subscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Web Push is not supported on this device/browser.');
    return;
  }

  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  if (Notification.permission !== 'granted') {
    alert('Notification permission denied.');
    updatePermissionText();
    return;
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
      subscription
    })
  });

  await updateStatus();
  updatePermissionText();
  alert('Push notifications enabled.');
}

async function unsubscribe() {
  if (!swRegistration) return;

  const subscription = await swRegistration.pushManager.getSubscription();
  if (!subscription) {
    alert('No active subscription found.');
    return;
  }

  await fetchJson('/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });

  await subscription.unsubscribe();
  await updateStatus();
  alert('Push notifications disabled.');
}

async function runCheckNow() {
  const data = await runSecureCheck({ promptIfMissing: true });
  if (data) {
    statusEl.textContent = JSON.stringify(data, null, 2);
  }
}

async function refreshWithCheck() {
  try {
    await runSecureCheck({ promptIfMissing: true });
  } catch (error) {
    alert(`Check failed: ${error.message}`);
  }

  await updateStatus();
}

async function init() {
  swRegistration = await navigator.serviceWorker.register('./sw.js');
  updatePermissionText();
  await updateStatus();

  subscribeBtn.addEventListener('click', subscribe);
  unsubscribeBtn.addEventListener('click', unsubscribe);
  refreshBtn.addEventListener('click', refreshWithCheck);
  checkBtn.addEventListener('click', runCheckNow);
}

init().catch((error) => {
  statusEl.textContent = `Initialization failed: ${error.message}`;
});
