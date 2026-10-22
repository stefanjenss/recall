// Runs sync in the background while a device is connected: on load, shortly
// after each local change, when the tab comes back into view, when the
// browser comes back online, and every few minutes. Only one tab syncs at a
// time; the others reload when it brings in changes.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SyncStatus } from '../storage/repository';
import { SyncError } from '../sync/client';
import { connectDevice, probeServer, runSync, type JoinMode, type SyncOutcome } from '../sync/engine';
import type { ServerInfo } from '../sync/protocol';
import { useWorkspace } from './workspace';

const AFTER_CHANGE_MS = 1500;
const INTERVAL_MS = 5 * 60_000;
/** Don't re-sync on every tab switch. */
const MIN_GAP_MS = 15_000;

export interface SyncContextValue {
  /** null while this device isn't connected. */
  status: SyncStatus | null;
  syncing: boolean;
  /** Sync now. Resolves when done; failures are recorded in `status.lastError`. */
  syncNow: () => Promise<void>;
  probe: (url: string, key: string) => Promise<ServerInfo>;
  connect: (opts: { url: string; key: string; info: ServerInfo; mode: JoinMode }) => Promise<SyncOutcome | null>;
  disconnect: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/** Errors that won't clear up by retrying; the learner has to reconnect. */
export function needsReconnect(status: SyncStatus | null): boolean {
  const kind = status?.lastError?.kind;
  return kind === 'server-changed' || kind === 'unauthorized';
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const { repo, refresh } = ws;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const running = useRef<Promise<void> | null>(null);
  /** A pass was requested while one was running; run once more afterward. */
  const again = useRef(false);
  const lastAttempt = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  const reloadStatus = useCallback(async () => {
    try {
      setStatus(await repo.getSyncStatus());
    } catch {
      // Storage problems surface through the workspace.
    }
  }, [repo]);

  // Re-read whenever the workspace reloads: another tab may have connected,
  // disconnected, or synced.
  useEffect(() => {
    if (ws.status === 'ready') void reloadStatus();
  }, [ws.status, ws.loadedAt, reloadStatus]);

  const pass = useCallback(async () => {
    lastAttempt.current = Date.now();
    setSyncing(true);
    try {
      const outcome = await runSync(repo, { now: Date.now });
      if (outcome && outcome.applied > 0) await refresh('sync');
    } catch (err) {
      if (!(err instanceof SyncError)) console.error(err);
    } finally {
      setSyncing(false);
      await reloadStatus();
    }
  }, [repo, refresh, reloadStatus]);

  const run = useCallback(
    async (manual: boolean) => {
      const current = statusRef.current;
      if (!current || (!manual && needsReconnect(current))) return;
      if (running.current) {
        again.current = true;
        return running.current;
      }
      const exclusive = async () => {
        // Let one tab sync at a time. Where Web Locks aren't available
        // (an http:// address), tabs may overlap; sync is idempotent.
        if (typeof navigator !== 'undefined' && navigator.locks) {
          await navigator.locks.request('recall-sync', { ifAvailable: true }, async (lock) => {
            if (lock) await pass();
          });
        } else {
          await pass();
        }
      };
      running.current = exclusive().finally(() => {
        running.current = null;
        if (again.current) {
          again.current = false;
          void runRef.current(false);
        }
      });
      return running.current;
    },
    [pass],
  );
  const runRef = useRef(run);
  runRef.current = run;

  const connected = status !== null;

  // On load, and every few minutes while the tab is visible.
  useEffect(() => {
    if (!connected) return;
    void run(false);
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void run(false);
    }, INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (Date.now() - lastAttempt.current > MIN_GAP_MS) void run(false);
      } else if ((statusRef.current?.pending ?? 0) > 0) {
        // Phones often leave the app right after a session; send what's queued before they suspend it.
        void run(false);
      }
    };
    const onOnline = () => void run(false);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [connected, run]);

  // Shortly after a change made in this tab.
  useEffect(() => {
    if (!connected || ws.localWrites === 0) return;
    const id = window.setTimeout(() => void run(false), AFTER_CHANGE_MS);
    return () => window.clearTimeout(id);
  }, [connected, ws.localWrites, run]);

  const value = useMemo<SyncContextValue>(
    () => ({
      status,
      syncing,
      syncNow: () => run(true) ?? Promise.resolve(),
      probe: (url, key) => probeServer(url, key),
      connect: async ({ url, key, info, mode }) => {
        setSyncing(true);
        try {
          return await connectDevice(repo, { url, key, info, mode, now: Date.now });
        } finally {
          setSyncing(false);
          lastAttempt.current = Date.now();
          await refresh('sync');
          await reloadStatus();
        }
      },
      disconnect: async () => {
        await repo.disconnectSync();
        await refresh('sync');
        await reloadStatus();
      },
    }),
    [status, syncing, run, repo, refresh, reloadStatus],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used inside SyncProvider');
  return ctx;
}
