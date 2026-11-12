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
import { AiProvider } from './ai';
import { FlashProvider, useFlash } from './flash';
import { href, useRoute, type Route } from './router';
import { needsReconnect, SyncProvider, useSync } from './sync';
import { useWorkspace, WorkspaceProvider } from './workspace';

type Destination = 'today' | 'collection' | 'add' | 'progress' | 'method' | 'settings' | 'practice';

type NavKey = Exclude<Destination, 'practice'>;

/** `tab` is the short label on the phone tab bar; destinations without one sit under More. */
const NAV: Array<{ key: NavKey; label: string; path: string; tab?: string }> = [
  { key: 'today', label: 'Today', path: '', tab: 'Today' },
  { key: 'collection', label: 'Collection', path: 'collection', tab: 'Cards' },
  { key: 'add', label: 'Add knowledge', path: 'add', tab: 'Add' },
  { key: 'progress', label: 'Progress', path: 'progress', tab: 'Progress' },
  { key: 'method', label: 'The method', path: 'method' },
  { key: 'settings', label: 'Settings', path: 'settings' },
];
const TABS = NAV.filter((item) => item.tab);
const MORE = NAV.filter((item) => !item.tab);

const ICON_PATHS: Record<NavKey | 'more', string> = {
  today: 'M3.5 11 12 4l8.5 7v7.5a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5a1.5 1.5 0 0 1-1.5-1.5Z',
  collection: 'M7 4.5h10M5.5 8h13M5 11.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1Z',
  add: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 8v8M8 12h8',
  progress: 'M5 20v-8M12 20V4M19 20v-5',
  method: 'M9.5 18h5M10.5 21h3M12 3a6 6 0 0 0-4 10.5c.8.8 1.2 1.5 1.3 2.5h5.4c.1-1 .5-1.7 1.3-2.5A6 6 0 0 0 12 3Z',
  settings:
    'M4 7h9M19 7h1M4 17h1M11 17h9M16 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

function NavIcon({ name }: { name: NavKey | 'more' }) {
  return (
    <svg
      className="nav__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

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
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

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

  const navList = (items: typeof NAV) => (
    <ul className="nav__list">
      {items.map((item) => (
        <li key={item.key}>
          <a className="nav__link" href={href(item.path)} aria-current={current === item.key ? 'page' : undefined}>
            <NavIcon name={item.key} />
            <span className="nav__label">{item.label}</span>
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

  // Practice is one question at a time: the tab bar steps aside, and the top bar still leads home.
  const showTabs = current !== 'practice';
  const moreIsCurrent = MORE.some((item) => item.key === current);

  return (
    <div className={`app${showTabs ? ' app--tabbed' : ''}`}>
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
            {navList(NAV)}
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
        </div>
      </header>

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

      {showTabs ? (
        <>
          <nav id="more-nav" className="more-sheet" aria-label="More" hidden={!menuOpen}>
            {navList(MORE)}
          </nav>
          <nav className="tabbar" aria-label="Main">
            <ul className="tabbar__list">
              {TABS.map((item) => (
                <li key={item.key}>
                  <a
                    className={`tabbar__item${current === item.key && !menuOpen ? ' is-current' : ''}`}
                    href={href(item.path)}
                    aria-current={current === item.key ? 'page' : undefined}
                  >
                    <NavIcon name={item.key} />
                    <span className="tabbar__label">{item.tab}</span>
                    {item.key === 'today' && summary.dueCount > 0 ? (
                      <span className="tabbar__badge" aria-label={`${summary.dueCount} due`}>
                        {summary.dueCount > 99 ? '99+' : summary.dueCount}
                      </span>
                    ) : null}
                  </a>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className={`tabbar__item${moreIsCurrent || menuOpen ? ' is-current' : ''}`}
                  aria-expanded={menuOpen}
                  aria-controls="more-nav"
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  <NavIcon name="more" />
                  <span className="tabbar__label">More</span>
                </button>
              </li>
            </ul>
          </nav>
        </>
      ) : null}
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
        <AiProvider>
          <FlashProvider>
            <Shell />
          </FlashProvider>
        </AiProvider>
      </SyncProvider>
    </WorkspaceProvider>
  );
}
