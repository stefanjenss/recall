import { useEffect, useMemo, useRef, useState } from 'react';
import { summarizeToday } from '../domain/stats';
import { applyUpdate, useOffline } from '../offline/register';
import { Notice, Wordmark } from '../ui/components/common';
import { AddKnowledge } from '../ui/screens/AddKnowledge';
import { CardEditor } from '../ui/screens/CardEditor';
import { Collection } from '../ui/screens/Collection';
import { Method } from '../ui/screens/Method';
import { Practice } from '../ui/screens/Practice';
import { Progress } from '../ui/screens/Progress';
import { SessionSummary } from '../ui/screens/SessionSummary';
import { Settings } from '../ui/screens/Settings';
import { Today } from '../ui/screens/Today';
import { FlashProvider, useFlash } from './flash';
import { href, useRoute, type Route } from './router';
import { needsReconnect, SyncProvider, useSync } from './sync';
import { useWorkspace, WorkspaceProvider } from './workspace';

type Destination = 'today' | 'collection' | 'add' | 'progress' | 'method' | 'settings' | 'practice';

const NAV: Array<{ key: Destination; label: string; path: string }> = [
  { key: 'today', label: 'Today', path: '' },
  { key: 'collection', label: 'Collection', path: 'collection' },
  { key: 'add', label: 'Add knowledge', path: 'add' },
  { key: 'progress', label: 'Progress', path: 'progress' },
  { key: 'method', label: 'The method', path: 'method' },
  { key: 'settings', label: 'Settings', path: 'settings' },
];

function destinationOf(route: Route): Destination {
  const [first] = route.segments;
  switch (first) {
    case 'collection':
    case 'add':
    case 'progress':
    case 'method':
    case 'settings':
    case 'practice':
      return first;
    case 'session':
      return 'practice';
    default:
      return 'today';
  }
}

function Screen({ route }: { route: Route }) {
  const [first, second] = route.segments;
  switch (first) {
    case 'collection':
      return second ? <CardEditor key={second} cardId={second} /> : <Collection params={route.params} />;
    case 'add':
      return <AddKnowledge mode={second === 'import' || second === 'options' ? second : 'write'} />;
    case 'practice':
      return <Practice />;
    case 'session':
      return second ? <SessionSummary key={second} sessionId={second} /> : <Today />;
    case 'progress':
      return <Progress />;
    case 'method':
      return <Method />;
    case 'settings':
      return <Settings />;
    default:
      return <Today />;
  }
}

function Shell() {
  const route = useRoute();
  const ws = useWorkspace();
  const { flash, clear } = useFlash();
  const offline = useOffline();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = destinationOf(route);
  const routeKey = window.location.hash || '#/';
  const firstRender = useRef(true);
  const mainRef = useRef<HTMLElement>(null);

  const summary = useMemo(
    () => summarizeToday(ws.activeCards, ws.schedules, ws.reviews, ws.now, ws.preferences.timezone),
    [ws.activeCards, ws.schedules, ws.reviews, ws.now, ws.preferences.timezone],
  );

  // On navigation: close the menu, drop stale messages, move focus to the new page heading.
  useEffect(() => {
    setMenuOpen(false);
    if (flash && flash.hash !== routeKey) clear();
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo(0, 0);
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLElement>('h1')?.focus());
    // Only navigation should trigger this; `flash` is read, not watched.
  }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const titles: Record<Destination, string> = {
      today: 'Today',
      collection: 'Collection',
      add: 'Add knowledge',
      progress: 'Progress',
      method: 'The method',
      settings: 'Settings',
      practice: 'Practice',
    };
    document.title = `${titles[current]} · recall.`;
  }, [current]);

  const nav = (
    <ul className="nav__list">
      {NAV.map((item) => (
        <li key={item.key}>
          <a className="nav__link" href={href(item.path)} aria-current={current === item.key ? 'page' : undefined}>
            <span>{item.label}</span>
            {item.key === 'today' && summary.dueCount > 0 ? (
              <span className="nav__count" aria-label={`${summary.dueCount} due`}>
                {summary.dueCount}
              </span>
            ) : null}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebar__inner">
          <a className="sidebar__brand" href={href('')} aria-label="recall. — Today">
            <Wordmark />
          </a>
          <nav className="nav" aria-label="Main">
            {nav}
          </nav>
          {summary.topics.length > 0 ? (
            <nav className="sidebar__topics" aria-label="Topics">
              <h2 className="eyebrow">Topics</h2>
              <ul>
                {summary.topics.map((t) => (
                  <li key={t.topic}>
                    <a href={href('collection', { topic: t.topic })}>
                      <span className="sidebar__topic-name">{t.topic}</span>
                      <span className="sidebar__topic-count" aria-label={`${t.due} due of ${t.cards}`}>
                        {t.due > 0 ? `${t.due} due` : t.cards}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <SyncFoot />
        </div>
      </aside>

      <header className="topbar">
        <a className="topbar__brand" href={href('')} aria-label="recall. — Today">
          <Wordmark />
        </a>
        <div className="topbar__status">
          {ws.activeSession && current !== 'practice' ? (
            <a className="button button--primary button--small" href={href('practice')}>
              Resume session
            </a>
          ) : summary.dueCount > 0 && current !== 'practice' ? (
            <a className="topbar__due" href={href('')}>
              {summary.dueCount} due
            </a>
          ) : null}
          <button
            type="button"
            className="topbar__menu button button--secondary button--small"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            Menu
          </button>
        </div>
      </header>
      <nav id="mobile-nav" className="mobile-nav" aria-label="Main" hidden={!menuOpen}>
        {nav}
      </nav>

      <main id="main" ref={mainRef} tabIndex={-1} className="main">
        {ws.versionChanged ? (
          <Notice tone="warn" title="Recall was updated in another tab">
            <p>Reload this page to keep working with the latest version.</p>
            <button type="button" className="button button--secondary" onClick={() => location.reload()}>
              Reload
            </button>
          </Notice>
        ) : null}
        {offline.updateReady ? (
          <div className="flash">
            <Notice tone="info" title="A new version of Recall is ready">
              <p>Reload to start using it. Your cards and review history stay as they are.</p>
              <button type="button" className="button button--secondary" onClick={applyUpdate}>
                Reload now
              </button>
            </Notice>
          </div>
        ) : null}
        {flash && flash.hash === routeKey ? (
          <div className="flash">
            <Notice key={flash.id} tone={flash.tone} onDismiss={clear}>
              <p>{flash.message}</p>
            </Notice>
          </div>
        ) : null}
        <Screen route={route} />
      </main>
    </div>
  );
}

/** Where the data lives, and whether sync needs attention. */
function SyncFoot() {
  const { status, syncing } = useSync();
  if (!status) return <p className="sidebar__foot">Stored in this browser only.</p>;
  // "thinkcentre" from thinkcentre.tail1234.ts.net; IP addresses stay whole.
  const { hostname, host: hostWithPort } = new URL(status.url);
  const host = /^[\d.]+$|^\[/.test(hostname) ? hostWithPort : hostname.split('.')[0];
  const problem = status.lastError && status.lastError.kind !== 'offline';
  return (
    <p className="sidebar__foot">
      {syncing ? (
        `Syncing with ${host}…`
      ) : needsReconnect(status) || problem ? (
        <a href={href('settings')}>Sync stopped. See Settings.</a>
      ) : status.lastError ? (
        `Saved here. Will sync with ${host} when it’s reachable.`
      ) : (
        `Synced with ${host}.`
      )}
    </p>
  );
}

export function App() {
  return (
    <WorkspaceProvider>
      <SyncProvider>
        <FlashProvider>
          <Shell />
        </FlashProvider>
      </SyncProvider>
    </WorkspaceProvider>
  );
}
