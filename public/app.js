const subscribeBtn = document.getElementById('subscribeBtn');
const unsubscribeBtn = document.getElementById('unsubscribeBtn');
const refreshBtn = document.getElementById('refreshBtn');
const checkBtn = document.getElementById('checkBtn');
const saveApiBaseBtn = document.getElementById('saveApiBaseBtn');
const statusEl = document.getElementById('status');
const permissionStateEl = document.getElementById('permissionState');
const deviceNameInput = document.getElementById('deviceName');
const apiBaseUrlInput = document.getElementById('apiBaseUrl');

let swRegistration;
let apiBaseUrl = localStorage.getItem('energyWatchApiBaseUrl') || '';

function apiUrl(path) {
  if (!apiBaseUrl) return path;
  const normalizedBase = apiBaseUrl.replace(/\/+$/, '');
  return `${normalizedBase}${path}`;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function getVapidPublicKey() {
  const response = await fetch(apiUrl('/api/vapid-public-key'));
  if (!response.ok) {
    throw new Error(`Could not load VAPID key (${response.status})`);
  }
  const data = await response.json();
  return data.publicKey;
}

async function updateStatus() {
  try {
    const response = await fetch(apiUrl('/api/status'));
    const data = await response.json();
    statusEl.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    statusEl.textContent = `Could not reach API. Set API base URL above.\n\n${error.message}`;
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

  await fetch(apiUrl('/api/subscribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceName: deviceNameInput.value.trim() || 'Unnamed device',
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

  await fetch(apiUrl('/api/unsubscribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });

  await subscription.unsubscribe();
  await updateStatus();
  alert('Push notifications disabled.');
}

async function runCheckNow() {
  const secret = prompt('Enter CHECK_SECRET to run a secure check:');
  if (!secret) return;

  const response = await fetch(apiUrl('/api/check'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`
    }
  });

  const data = await response.json();
  statusEl.textContent = JSON.stringify(data, null, 2);
}

async function init() {
  apiBaseUrlInput.value = apiBaseUrl;

  swRegistration = await navigator.serviceWorker.register('./sw.js');
  updatePermissionText();
  await updateStatus();

  saveApiBaseBtn.addEventListener('click', async () => {
    apiBaseUrl = apiBaseUrlInput.value.trim().replace(/\/+$/, '');
    localStorage.setItem('energyWatchApiBaseUrl', apiBaseUrl);
    await updateStatus();
  });
  subscribeBtn.addEventListener('click', subscribe);
  unsubscribeBtn.addEventListener('click', unsubscribe);
  refreshBtn.addEventListener('click', updateStatus);
  checkBtn.addEventListener('click', runCheckNow);
}

init().catch((error) => {
  statusEl.textContent = `Initialization failed: ${error.message}`;
});
