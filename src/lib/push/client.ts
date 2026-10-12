// Browser side of Web Push: register the service worker, subscribe this
// device and hand the subscription to /api/push/subscribe.

/** localStorage flag: this device gets server push, so the in-tab
 *  notifier (use-browser-notifications) stays quiet to avoid doubles. */
export const PUSH_ENABLED_STORAGE_KEY = 'wacrm:push-enabled';

export function readPushEnabledFlag(): boolean {
  try {
    return window.localStorage.getItem(PUSH_ENABLED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writePushEnabledFlag(on: boolean) {
  try {
    if (on) window.localStorage.setItem(PUSH_ENABLED_STORAGE_KEY, '1');
    else window.localStorage.removeItem(PUSH_ENABLED_STORAGE_KEY);
  } catch {
    // ignore — the flag only prevents duplicate alerts
  }
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** iPhone/iPad Safari tab (not installed): push needs "Add to Home Screen". */
export function needsIosInstall(): boolean {
  if (typeof window === 'undefined') return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<'ok' | 'denied' | 'unconfigured'> {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return 'unconfigured';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const reg = await registration();
  await saveSubscription(await subscribeWithKey(reg, key));
  writePushEnabledFlag(true);
  return 'ok';
}

function sameKey(sub: PushSubscription, key: string): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current);
  const b = urlBase64ToUint8Array(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Reuse this device's subscription, or replace it if it was made with
 *  an old server key (after a VAPID key rotation). */
async function subscribeWithKey(
  reg: ServiceWorkerRegistration,
  key: string,
): Promise<PushSubscription> {
  const existing = await reg.pushManager.getSubscription();
  if (existing && sameKey(existing, key)) return existing;
  if (existing) {
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: existing.endpoint }),
    }).catch(() => {});
    await existing.unsubscribe().catch(() => false);
  }
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
}

async function saveSubscription(sub: PushSubscription): Promise<void> {
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Could not save this device');
  }
}

/**
 * Run on dashboard load: if this device has push on but its subscription
 * uses an old server key, silently re-subscribe (permission is already
 * granted, so no prompt). Keeps phones working after a key rotation.
 */
export async function refreshPushSubscription(): Promise<void> {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key || !pushSupported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const existing = await reg?.pushManager.getSubscription();
  if (!reg || !existing || sameKey(existing, key)) return;
  await saveSubscription(await subscribeWithKey(reg, key));
  writePushEnabledFlag(true);
}

export async function disablePush(): Promise<void> {
  const sub = await getPushSubscription();
  writePushEnabledFlag(false);
  if (!sub) return;
  await fetch('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => false);
}
