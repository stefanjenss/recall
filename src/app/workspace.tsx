import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Card, Preferences, Reflection, Review, Schedule, Session } from '../domain/types';
import { createRepository, defaultPreferences, type Repository } from '../storage/repository';

export type StorageStatus = 'persisted' | 'best-effort' | 'unsupported' | 'unknown';

export interface Workspace {
  repo: Repository;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** Includes soft-deleted cards; use `activeCards` for anything learner-facing. */
  cards: Card[];
  activeCards: Card[];
  cardsById: Map<string, Card>;
  schedules: Map<string, Schedule>;
  reviews: Review[];
  reflections: Reflection[];
  activeSession: Session | null;
  preferences: Preferences;
  lastBackupAt: number | null;
  /** Wall-clock time, refreshed every 30 seconds and when the tab regains focus. */
  now: number;
  /** When this snapshot was read from storage. */
  loadedAt: number;
  storage: StorageStatus;
  versionChanged: boolean;
  /** Counts writes made in this tab; sync watches it to upload soon after a change. */
  localWrites: number;
  /**
   * Reload from storage and tell other tabs. Call after every write. Sync
   * passes 'sync' so applying the server's changes doesn't trigger an upload.
   */
  refresh: (source?: 'local' | 'sync') => Promise<void>;
  updatePreferences: (patch: Partial<Preferences>) => Promise<void>;
  requestPersistentStorage: () => Promise<StorageStatus>;
}

const WorkspaceContext = createContext<Workspace | null>(null);

const CHANNEL = 'recall-workspace';

async function storageStatus(): Promise<StorageStatus> {
  if (!navigator.storage?.persisted) return 'unsupported';
  try {
    return (await navigator.storage.persisted()) ? 'persisted' : 'best-effort';
  } catch {
    return 'unknown';
  }
}

export function WorkspaceProvider({ children, dbName }: { children: ReactNode; dbName?: string }) {
  const [versionChanged, setVersionChanged] = useState(false);
  const repo = useMemo(() => createRepository(dbName, { onVersionChange: () => setVersionChanged(true) }), [dbName]);
  const [status, setStatus] = useState<Workspace['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [schedules, setSchedules] = useState<Map<string, Schedule>>(new Map());
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reflections, setReflections] = useState<Reflection[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loadedAt, setLoadedAt] = useState(0);
  const [storage, setStorage] = useState<StorageStatus>('unknown');
  const [localWrites, setLocalWrites] = useState(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const persistAsked = useRef(false);

  const load = useCallback(async () => {
    try {
      const started = Date.now();
      const ws = await repo.loadWorkspace();
      setCards(ws.cards);
      setSchedules(new Map(ws.schedules.map((s) => [s.cardId, s])));
      setReviews(ws.reviews);
      setReflections(ws.reflections);
      setActiveSession(ws.activeSession);
      setPreferences(ws.preferences);
      setLastBackupAt(ws.lastBackupAt);
      setNow(Date.now());
      setLoadedAt(started);
      setStatus('ready');
      setError(null);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [repo]);

  const refresh = useCallback(
    async (source: 'local' | 'sync' = 'local') => {
      await load();
      channel.current?.postMessage('changed');
      if (source === 'local') setLocalWrites((n) => n + 1);
    },
    [load],
  );

  useEffect(() => {
    void load();
    void storageStatus().then(setStorage);
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = () => void load();
      channel.current = ch;
      return () => ch.close();
    }
    return undefined;
  }, [load]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    document.documentElement.dataset.readingSize = preferences.readingSize;
  }, [preferences.readingSize]);

  const requestPersistentStorage = useCallback(async (): Promise<StorageStatus> => {
    if (!navigator.storage?.persist) {
      setStorage('unsupported');
      return 'unsupported';
    }
    try {
      const granted = await navigator.storage.persist();
      const next = granted ? 'persisted' : 'best-effort';
      setStorage(next);
      return next;
    } catch {
      setStorage('unknown');
      return 'unknown';
    }
  }, []);

  // Once the learner has something worth keeping, ask the browser not to evict it.
  // Browsers may decline silently; Settings explains the outcome.
  useEffect(() => {
    if (status !== 'ready' || persistAsked.current || storage !== 'best-effort') return;
    if (!cards.some((c) => c.deletedAt === null)) return;
    persistAsked.current = true;
    void requestPersistentStorage();
  }, [status, storage, cards, requestPersistentStorage]);

  const updatePreferences = useCallback(
    async (patch: Partial<Preferences>) => {
      const next = { ...preferences, ...patch };
      setPreferences(next);
      await repo.savePreferences(next, Date.now());
      await refresh();
    },
    [preferences, repo, refresh],
  );

  const value = useMemo<Workspace>(() => {
    const activeCards = cards.filter((c) => c.deletedAt === null);
    return {
      repo,
      status,
      error,
      cards,
      activeCards,
      cardsById: new Map(cards.map((c) => [c.id, c])),
      schedules,
      reviews,
      reflections,
      activeSession,
      preferences,
      lastBackupAt,
      now,
      loadedAt,
      storage,
      versionChanged,
      localWrites,
      refresh,
      updatePreferences,
      requestPersistentStorage,
    };
  }, [
    repo,
    status,
    error,
    cards,
    schedules,
    reviews,
    reflections,
    activeSession,
    preferences,
    lastBackupAt,
    now,
    loadedAt,
    storage,
    versionChanged,
    localWrites,
    refresh,
    updatePreferences,
    requestPersistentStorage,
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return ws;
}
