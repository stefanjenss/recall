import { useEffect, useId, useState, type FormEvent } from 'react';
import { useFlash } from '../../app/flash';
import { needsReconnect, useSync } from '../../app/sync';
import { useWorkspace } from '../../app/workspace';
import { formatAgo, formatDateTime } from '../../domain/time';
import { isBlockedMixedContent, normalizeServerUrl, SyncError } from '../../sync/client';
import type { JoinMode } from '../../sync/engine';
import type { ServerInfo } from '../../sync/protocol';
import { downloadFullBackup } from '../backupActions';
import { ConfirmDialog, Notice, StatList } from '../components/common';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function describeError(err: unknown): string {
  if (err instanceof SyncError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The page's own base URL, when this copy of Recall is served by a sync server. */
function useSameOriginServer(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const base = new URL('./', window.location.href);
    base.hash = '';
    base.search = '';
    let cancelled = false;
    fetch(new URL('api/health', base), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (!cancelled && (body as { app?: unknown } | null)?.app === 'recall-sync') setUrl(base.toString());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return url;
}

export function SyncSettings() {
  const ws = useWorkspace();
  const sync = useSync();
  return (
    <section className="section settings__group" id="sync" aria-labelledby="sync-title">
      <h2 id="sync-title" className="section__title">
        Sync between devices
      </h2>
      {sync.status ? <Connected /> : <Connect localCounts={localCounts(ws)} />}
    </section>
  );
}

function localCounts(ws: ReturnType<typeof useWorkspace>) {
  return {
    cards: ws.activeCards.length,
    reviews: ws.reviews.length,
    reflections: ws.reflections.length,
    hasData: ws.cards.length + ws.reviews.length + ws.reflections.length > 0,
  };
}

function Connected() {
  const ws = useWorkspace();
  const sync = useSync();
  const { show } = useFlash();
  const status = sync.status!;
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const host = new URL(status.url).host;
  const tz = ws.preferences.timezone;
  const error = status.lastError;
  const reconnect = needsReconnect(status);

  const state = sync.syncing
    ? 'Syncing…'
    : error
      ? reconnect
        ? 'Stopped: needs reconnecting'
        : error.kind === 'offline'
          ? 'Waiting for the server'
          : 'Problem syncing'
      : status.lastSyncAt
        ? 'Up to date'
        : 'Not synced yet';

  async function disconnect() {
    setBusy(true);
    try {
      await sync.disconnect();
      setConfirmDisconnect(false);
      show('This device is no longer syncing. Its data stays here, and the server keeps its copy.', 'info');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="prose">
        <p>
          This device syncs with your server at <strong>{host}</strong>. It keeps its own full copy and works offline; changes go
          both ways whenever the server can be reached.
        </p>
      </div>
      <StatList
        className="sync-status"
        items={[
          { label: 'Status', value: state },
          {
            label: 'Last synced',
            value: status.lastSyncAt ? formatAgo(status.lastSyncAt, ws.now) : 'Never',
            note: status.lastSyncAt ? formatDateTime(status.lastSyncAt, tz) : undefined,
          },
          { label: 'Waiting to upload', value: plural(status.pending, 'change') },
        ]}
      />
      {error ? (
        <Notice
          tone={error.kind === 'offline' ? 'warn' : 'error'}
          title={reconnect ? 'Sync stopped' : error.kind === 'offline' ? 'Can’t reach the server' : 'Sync problem'}
          live={false}
        >
          <p>{error.message}</p>
          {reconnect ? (
            <p>
              Disconnect this device, then connect again
              {error.kind === 'unauthorized' ? ' with the current sync key' : ' and choose what to do with the data here'}.
              {status.pending > 0
                ? ` ${plural(status.pending, 'change')} made here haven’t reached the server; download a full backup first if you want to keep them.`
                : ''}
            </p>
          ) : (
            <p>Your changes are saved on this device and will sync once this is resolved.</p>
          )}
        </Notice>
      ) : null}
      {status.rejected.count > 0 ? (
        <Notice tone="warn" title="Some changes didn’t sync" live={false}>
          <p>
            The server refused {plural(status.rejected.count, 'change')} as invalid. They’re still on this device but won’t be
            sent again.
            {status.rejected.lastReason ? ` Last reason: ${status.rejected.lastReason}` : ''}
          </p>
        </Notice>
      ) : null}
      <div className="button-row">
        <button
          type="button"
          className="button button--primary"
          disabled={sync.syncing || reconnect}
          onClick={async () => {
            await sync.syncNow();
          }}
        >
          {sync.syncing ? 'Syncing…' : 'Sync now'}
        </button>
        <button type="button" className="button button--secondary" onClick={() => setConfirmDisconnect(true)}>
          Disconnect this device…
        </button>
      </div>
      <p className="muted">
        Sessions in progress stay on the device where you started them until you finish or end them. Preferences, including
        reading size and timezone, sync too.
      </p>
      <ConfirmDialog
        open={confirmDisconnect}
        title="Stop syncing this device?"
        confirmLabel="Disconnect"
        busy={busy}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
      >
        <p>
          Everything on this device stays here, and the server keeps its copy. This device stops sending and receiving changes,
          and forgets the sync key.
        </p>
        {status.pending > 0 ? (
          <p>
            <strong>{plural(status.pending, 'change')}</strong> made here haven’t reached the server yet and won’t be sent.
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

type Probe = { url: string; key: string; info: ServerInfo };

function Connect({ localCounts: local }: { localCounts: ReturnType<typeof localCounts> }) {
  const ws = useWorkspace();
  const sync = useSync();
  const { show } = useFlash();
  const sameOrigin = useSameOriginServer();
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [mode, setMode] = useState<JoinMode | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const urlHint = useId();
  const keyHint = useId();

  useEffect(() => {
    if (sameOrigin) setUrl((u) => u || sameOrigin);
  }, [sameOrigin]);

  async function check(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    setProbe(null);
    setMode(null);
    const normalized = normalizeServerUrl(url);
    if (!normalized.ok) return setProblem(normalized.message);
    if (!key.trim()) return setProblem('Enter the sync key from your server.');
    if (isBlockedMixedContent(normalized.url, window.location.protocol)) {
      return setProblem(
        'This page was loaded over https://, so the browser won’t let it reach an http:// server. Use an https:// address for the server, for example through Tailscale Serve.',
      );
    }
    setChecking(true);
    try {
      const info = await sync.probe(normalized.url, key.trim());
      setUrl(normalized.url);
      setProbe({ url: normalized.url, key: key.trim(), info });
      const serverHasData = info.records > 0;
      setMode(!serverHasData ? 'upload' : !local.hasData ? 'download' : null);
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setChecking(false);
    }
  }

  async function connect() {
    if (!probe || !mode) return;
    setBusy(true);
    setProblem(null);
    try {
      await sync.connect({ ...probe, mode });
      setConfirming(false);
      show(
        mode === 'download'
          ? 'Connected. This device now has the server’s copy and will stay in sync.'
          : 'Connected and synced. This device will stay in step with the server.',
      );
    } catch (err) {
      setConfirming(false);
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const serverHasData = !!probe && probe.info.records > 0;
  const bothHaveData = serverHasData && local.hasData;
  const destructive = mode === 'download' ? local.hasData : mode === 'replace-server';

  return (
    <>
      <div className="prose">
        <p>
          Keep your phone and laptop in step through a Recall sync server that you run yourself, for example on a home server.
          Each device keeps a full copy and works offline; changes sync whenever the server can be reached. Your data goes only to
          the address you enter. The setup guide is <code>docs/SYNC.md</code> in the Recall repository.
        </p>
      </div>
      <form className="sync-form" onSubmit={(e) => void check(e)} noValidate>
        <div className="field">
          <label htmlFor="sync-url" className="field__label">
            Server address
          </label>
          <p id={urlHint} className="field__hint">
            For example, https://thinkcentre.your-tailnet.ts.net
            {sameOrigin ? '. Filled in because this page comes from a sync server.' : ''}
          </p>
          <input
            id="sync-url"
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={urlHint}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setProbe(null);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="sync-key" className="field__label">
            Sync key
          </label>
          <p id={keyHint} className="field__hint">
            Shown by <code>recall-server key</code> on the server. It’s kept in this browser and never included in backups.
          </p>
          <input
            id="sync-key"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={keyHint}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setProbe(null);
            }}
          />
        </div>
        <div className="button-row">
          <button type="submit" className="button button--secondary" disabled={checking}>
            {checking ? 'Checking…' : 'Check connection'}
          </button>
        </div>
      </form>

      {problem ? (
        <Notice tone="error" title="Can’t connect" onDismiss={() => setProblem(null)}>
          <p>{problem}</p>
        </Notice>
      ) : null}

      {probe ? (
        <div className="sync-join" aria-live="polite">
          <Notice tone="success" title="The server answered" live={false}>
            <p>
              {serverHasData
                ? `It holds ${plural(probe.info.counts.cards, 'card')}, ${plural(probe.info.counts.reviews, 'review')}, and ${plural(probe.info.counts.reflections, 'reflection')}.`
                : 'It doesn’t hold any data yet.'}{' '}
              This device has{' '}
              {local.hasData
                ? `${plural(local.cards, 'card')}, ${plural(local.reviews, 'review')}, and ${plural(local.reflections, 'reflection')}.`
                : 'no data yet.'}
            </p>
          </Notice>
          {bothHaveData ? <JoinChoice value={mode} onChange={setMode} /> : null}
          <div className="button-row">
            <button
              type="button"
              className="button button--primary"
              disabled={!mode || busy}
              onClick={() => (destructive ? setConfirming(true) : void connect())}
            >
              {busy
                ? 'Connecting…'
                : !serverHasData
                  ? local.hasData
                    ? 'Connect and upload this device’s data'
                    : 'Connect'
                  : !local.hasData
                    ? 'Connect and download'
                    : 'Connect'}
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={mode === 'replace-server' ? 'Replace the server’s copy?' : 'Replace this device’s data?'}
        confirmLabel={mode === 'replace-server' ? 'Replace the server’s copy' : 'Replace this device’s data'}
        tone="danger"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void connect()}
      >
        {mode === 'replace-server' ? (
          <p>
            The server’s {plural(probe?.info.counts.cards ?? 0, 'card')} and {plural(probe?.info.counts.reviews ?? 0, 'review')}{' '}
            will be replaced with this device’s {plural(local.cards, 'card')} and {plural(local.reviews, 'review')}. The server
            saves a backup file of its current data first. Your other devices will stop syncing until you reconnect them.
          </p>
        ) : (
          <p>
            This device’s {plural(local.cards, 'card')}, {plural(local.reviews, 'review')}, and{' '}
            {plural(local.reflections, 'reflection')} will be replaced with the server’s copy, and any session in progress here
            will be dropped. Anything that only exists on this device will be lost.
          </p>
        )}
        <p>
          <button type="button" className="button button--secondary" onClick={() => void downloadFullBackup(ws)}>
            Download a backup of this device first
          </button>
        </p>
      </ConfirmDialog>
    </>
  );
}

const JOIN_OPTIONS: Array<{ value: JoinMode; label: string; hint: string }> = [
  {
    value: 'download',
    label: 'Use the server’s copy on this device',
    hint: 'Best when adding a device. Replaces what’s on this device with the server’s data.',
  },
  {
    value: 'upload',
    label: 'Combine both',
    hint: 'Keeps everything from both. Where both have the same record, the copy changed most recently wins. Cards added separately on each device both appear, even if they match.',
  },
  {
    value: 'replace-server',
    label: 'Replace the server’s copy with this device’s',
    hint: 'For starting over from this device, for example after restoring a backup. The server saves a backup of its data first, and your other devices will need to reconnect.',
  },
];

function JoinChoice({ value, onChange }: { value: JoinMode | null; onChange: (mode: JoinMode) => void }) {
  const name = useId();
  return (
    <fieldset className="choice-list">
      <legend>Both have data. What should happen?</legend>
      {JOIN_OPTIONS.map((opt) => (
        <label key={opt.value} className="choice">
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            aria-describedby={`${name}-${opt.value}`}
          />
          <span>
            <span className="choice__label">{opt.label}</span>
            <span id={`${name}-${opt.value}`} className="choice__hint">
              {opt.hint}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
