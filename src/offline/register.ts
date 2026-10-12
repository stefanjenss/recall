// Registers the service worker (production builds only) and exposes its state
// to the UI: whether offline use is ready, and whether a new version is
// waiting. Updates are applied only when the learner chooses to reload.

import { useSyncExternalStore } from 'react';

export type OfflineStatus = 'pending' | 'ready' | 'unsupported' | 'disabled' | 'error';

export interface OfflineState {
  status: OfflineStatus;
  updateReady: boolean;
}

const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;

let state: OfflineState = { status: 'pending', updateReady: false };
const listeners = new Set<() => void>();
let waitingWorker: ServiceWorker | null = null;
let reloadRequested = false;

function update(patch: Partial<OfflineState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOffline(): OfflineState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Activate the waiting version; the page reloads once it takes control. */
export function applyUpdate(): void {
  if (!waitingWorker) return;
  reloadRequested = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) {
    update({ status: 'disabled' });
    return;
  }
  if (!('serviceWorker' in navigator)) {
    update({ status: 'unsupported' });
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install also changes the controller (clients.claim); only an
    // update the learner asked for triggers a reload.
    if (reloadRequested) {
      reloadRequested = false;
      window.location.reload();
    }
  });

  const markWaiting = (worker: ServiceWorker) => {
    waitingWorker = worker;
    update({ updateReady: true });
  };
  const watch = (worker: ServiceWorker) => {
    worker.addEventListener('statechange', () => {
      // With an existing controller, an installed worker is an update waiting its turn.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) markWaiting(worker);
    });
  };

  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) markWaiting(registration.waiting);
      if (registration.installing) watch(registration.installing);
      registration.addEventListener('updatefound', () => {
        if (registration.installing) watch(registration.installing);
      });

      // Phones keep the app open for days; look for a new version when it comes back to the foreground.
      let lastCheck = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
        lastCheck = Date.now();
        registration.update().catch(() => undefined);
      });

      return navigator.serviceWorker.ready;
    })
    .then(() => update({ status: 'ready' }))
    .catch(() => update({ status: 'error' }));
}
