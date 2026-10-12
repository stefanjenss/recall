import { useEffect, useState } from 'react';

// Hash routing keeps the app deployable to any static host without rewrites.

export interface Route {
  /** Path segments after "#/", e.g. ["collection", "abc"]. */
  segments: string[];
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  return {
    segments: path.split('/').filter(Boolean).map(decodeURIComponent),
    params: new URLSearchParams(query),
  };
}

export function href(path: string, params?: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) qs.set(k, v);
  const q = qs.toString();
  return `#/${path.replace(/^\//, '')}${q ? `?${q}` : ''}`;
}

export function navigate(path: string, params?: Record<string, string | null | undefined>, opts: { replace?: boolean } = {}) {
  const target = href(path, params);
  if (opts.replace) {
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
