import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type FlashTone = 'success' | 'info' | 'warn' | 'error';

export interface Flash {
  id: number;
  message: string;
  tone: FlashTone;
  /** The page the message belongs to; it clears when the learner moves elsewhere. */
  hash: string;
}

interface FlashApi {
  flash: Flash | null;
  /** Call after navigating, so the message attaches to the destination page. */
  show: (message: string, tone?: FlashTone) => void;
  clear: () => void;
}

const FlashContext = createContext<FlashApi | null>(null);
let nextId = 1;

export function FlashProvider({ children }: { children: ReactNode }) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const show = useCallback((message: string, tone: FlashTone = 'success') => {
    setFlash({ id: nextId++, message, tone, hash: window.location.hash || '#/' });
  }, []);
  const clear = useCallback(() => setFlash(null), []);
  const value = useMemo(() => ({ flash, show, clear }), [flash, show, clear]);
  return <FlashContext.Provider value={value}>{children}</FlashContext.Provider>;
}

export function useFlash(): FlashApi {
  const api = useContext(FlashContext);
  if (!api) throw new Error('useFlash must be used inside FlashProvider');
  return api;
}
