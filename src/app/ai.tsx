// AI feedback availability for this device: the chosen mode, and, in server
// mode, what the sync server's model is and whether it can be reached. Nothing
// is sent to a model from here; this only asks the server what it offers.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AiClientError, createAiClient, type AiClient } from '../ai/client';
import { createServerEvaluator, type Evaluator } from '../ai/evaluator';
import type { AiInfo } from '../ai/protocol';
import type { AiFeedbackMode } from '../domain/types';
import { useSync } from './sync';
import { useWorkspace } from './workspace';

export type AiAvailability =
  /** Mode is off or external: no server involved. */
  | { state: 'idle' }
  /** Server mode, but this device isn't connected to a sync server. */
  | { state: 'no-sync' }
  | { state: 'checking' }
  /** The server answered, and no model provider is configured on it. */
  | { state: 'not-configured' }
  | { state: 'unreachable'; message: string }
  | { state: 'ready'; info: AiInfo };

export interface AiContextValue {
  mode: AiFeedbackMode;
  setMode: (mode: AiFeedbackMode) => Promise<void>;
  availability: AiAvailability;
  /** Present only when the server's model is ready. */
  evaluator: Evaluator | null;
  client: AiClient | null;
  /** Ask the server again. */
  recheck: () => void;
}

const AiContext = createContext<AiContextValue | null>(null);

export function AiProvider({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const sync = useSync();
  const { repo } = ws;
  const mode = ws.aiMode;
  const connectedTo = sync.status ? `${sync.status.url}#${sync.status.serverId}` : null;
  const [client, setClient] = useState<AiClient | null>(null);
  const [availability, setAvailability] = useState<AiAvailability>({ state: 'idle' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (mode !== 'server') {
      setClient(null);
      setAvailability({ state: 'idle' });
      return;
    }
    if (!connectedTo) {
      setClient(null);
      setAvailability({ state: 'no-sync' });
      return;
    }
    setAvailability((a) => (a.state === 'ready' ? a : { state: 'checking' }));
    void (async () => {
      try {
        const config = await repo.getSyncConfig();
        if (cancelled) return;
        if (!config) {
          setClient(null);
          setAvailability({ state: 'no-sync' });
          return;
        }
        const next = createAiClient({ url: config.url, key: config.key });
        const info = await next.info();
        if (cancelled) return;
        setClient(next);
        setAvailability(info.enabled ? { state: 'ready', info } : { state: 'not-configured' });
      } catch (err) {
        if (cancelled) return;
        setClient(null);
        setAvailability({
          state: 'unreachable',
          message: err instanceof AiClientError ? err.message : 'AI feedback could not be checked.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, connectedTo, repo, nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<AiContextValue>(
    () => ({
      mode,
      setMode: ws.setAiMode,
      availability,
      client,
      evaluator: client && availability.state === 'ready' ? createServerEvaluator(client, availability.info) : null,
      recheck,
    }),
    [mode, ws.setAiMode, availability, client, recheck],
  );

  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

export function useAi(): AiContextValue {
  const ai = useContext(AiContext);
  if (!ai) throw new Error('useAi must be used inside AiProvider');
  return ai;
}
