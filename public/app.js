const subscribeBtn = document.getElementById('subscribeBtn');
const unsubscribeBtn = document.getElementById('unsubscribeBtn');
const refreshBtn = document.getElementById('refreshBtn');
const checkBtn = document.getElementById('checkBtn');
const statusEl = document.getElementById('status');
const permissionStateEl = document.getElementById('permissionState');
const deviceNameInput = document.getElementById('deviceName');

let swRegistration;
const apiBase = new URL('./api/', window.location.href);

function apiUrl(path) {
  const normalized = path.replace(/^\/+/, '');
  return new URL(normalized, apiBase).toString();
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function getVapidPublicKey() {
  const response = await fetch(apiUrl('/vapid-public-key'));
  if (!response.ok) {
    throw new Error(`Could not load VAPID key (${response.status})`);
  }
  const data = await response.json();
  return data.publicKey;
}

async function updateStatus() {
  try {
    const url = apiUrl('/status');
    const response = await fetch(url);
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
    statusEl.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    statusEl.textContent = `Could not reach API.\n\n${error.message}`;
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

  await fetch(apiUrl('/subscribe'), {
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

  await fetch(apiUrl('/unsubscribe'), {
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

  const response = await fetch(apiUrl('/check'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`
    }
  });

  const data = await response.json();
  statusEl.textContent = JSON.stringify(data, null, 2);
}

async function init() {
  swRegistration = await navigator.serviceWorker.register('./sw.js');
  updatePermissionText();
  await updateStatus();

  subscribeBtn.addEventListener('click', subscribe);
  unsubscribeBtn.addEventListener('click', unsubscribe);
  refreshBtn.addEventListener('click', updateStatus);
  checkBtn.addEventListener('click', runCheckNow);
}

init().catch((error) => {
  statusEl.textContent = `Initialization failed: ${error.message}`;
});
