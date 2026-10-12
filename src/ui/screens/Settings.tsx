import { useMemo, useState } from 'react';
import { useFlash } from '../../app/flash';
import { navigate } from '../../app/router';
import { useSync } from '../../app/sync';
import { useWorkspace } from '../../app/workspace';
import { checkBackupSize, countWorkspace, parseBackupText, type WorkspaceCounts, type WorkspaceData } from '../../content/backup';
import { browserTimeZone, formatDateTime, supportedTimeZones } from '../../domain/time';
import { SESSION_SIZES, type ReadingSize, type SessionSize } from '../../domain/types';
import { useOffline } from '../../offline/register';
import { downloadContentExport, downloadFullBackup } from '../backupActions';
import { ConfirmDialog, Notice, PageHeader, Segmented } from '../components/common';
import { SyncSettings } from './SyncSettings';

const READING_SIZES: Array<{ value: ReadingSize; label: string; hint: string }> = [
  { value: 'standard', label: 'Standard', hint: '18 px study text' },
  { value: 'large', label: 'Large', hint: '20 px' },
  { value: 'larger', label: 'Larger', hint: '22.5 px' },
];

function CountsTable({ counts, caption }: { counts: WorkspaceCounts; caption: string }) {
  const rows: Array<[string, number]> = [
    ['Cards', counts.cards],
    ['Deleted cards kept for history', counts.deletedCards],
    ['Reviews', counts.reviews],
    ['Sessions', counts.sessions],
    ['Reflections', counts.reflections],
  ];
  return (
    <table className="table counts">
      <caption>{caption}</caption>
      <tbody>
        {rows.map(([label, n]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="num">{n.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Settings() {
  const ws = useWorkspace();
  const sync = useSync();
  const syncHost = sync.status ? new URL(sync.status.url).host : null;
  const { show } = useFlash();
  const tz = ws.preferences.timezone;
  const zones = useMemo(() => supportedTimeZones(), []);
  const browserZone = browserTimeZone();

  const [restore, setRestore] = useState<{
    data: WorkspaceData;
    counts: WorkspaceCounts;
    exportedAt: string | null;
    name: string;
  } | null>(null);
  const [restoreErrors, setRestoreErrors] = useState<string[] | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [busy, setBusy] = useState(false);

  const current = useMemo(
    () =>
      countWorkspace({
        cards: ws.cards,
        schedules: [...ws.schedules.values()],
        reviews: ws.reviews,
        sessions: [],
        reflections: ws.reflections,
        rubrics: [],
        assessments: [],
        preferences: ws.preferences,
      }),
    [ws.cards, ws.schedules, ws.reviews, ws.reflections, ws.preferences],
  );

  async function chooseBackup(file: File | undefined) {
    setRestoreErrors(null);
    setRestore(null);
    if (!file) return;
    const sizeError = checkBackupSize(file.size);
    if (sizeError) {
      setRestoreErrors([sizeError]);
      return;
    }
    const result = parseBackupText(await file.text());
    if (!result.ok) {
      setRestoreErrors(result.errors);
      return;
    }
    setRestore({ data: result.data, counts: result.counts, exportedAt: result.exportedAt, name: file.name });
  }

  async function confirmRestore() {
    if (!restore) return;
    setRestoring(true);
    try {
      await ws.repo.replaceWorkspace(restore.data);
      await ws.refresh();
      setRestore(null);
      navigate(syncHost ? 'settings' : '');
      show(
        `Restored ${restore.counts.cards} cards and ${restore.counts.reviews} reviews from ${restore.name}.` +
          (syncHost ? ' Sync is now off for this device; reconnect it under Sync between devices.' : ''),
      );
    } catch (err) {
      setRestoreErrors([`Restore failed and nothing was changed: ${err instanceof Error ? err.message : String(err)}`]);
      setRestore(null);
    } finally {
      setRestoring(false);
    }
  }

  async function deleteEverything() {
    setBusy(true);
    try {
      await ws.repo.deleteAllData();
      await ws.refresh();
      setDeleteOpen(false);
      setDeleteText('');
      navigate('');
      show('All Recall data in this browser was deleted.', 'info');
    } finally {
      setBusy(false);
    }
  }

  const offline = useOffline();
  const offlineText = {
    ready: 'Ready. Recall opens and works on this device without a connection.',
    pending: 'Getting ready…',
    unsupported: 'Not available in this browser.',
    disabled: 'Off in development builds; the published site supports it.',
    error: 'Couldn’t be set up. Offline use needs the site to be served over HTTPS.',
  }[offline.status];

  const storageText = {
    persisted: 'Persistent: the browser has agreed not to clear Recall’s data automatically.',
    'best-effort': 'Best effort: the browser may clear Recall’s data under storage pressure, or if you clear site data.',
    unsupported: 'This browser doesn’t report whether storage is persistent.',
    unknown: 'Storage status is unknown.',
  }[ws.storage];

  return (
    <div className="screen settings">
      <PageHeader title="Settings" />

      <section className="section settings__group" aria-labelledby="reading-title">
        <h2 id="reading-title" className="section__title">
          Reading
        </h2>
        <Segmented
          legend="Text size"
          options={READING_SIZES}
          value={ws.preferences.readingSize}
          onChange={(v) => v && void ws.updatePreferences({ readingSize: v })}
        />
        <p className="reading-sample">The quick check: can you explain it without looking?</p>
      </section>

      <section className="section settings__group" aria-labelledby="study-title">
        <h2 id="study-title" className="section__title">
          Study
        </h2>
        <Segmented
          legend="Default session size"
          options={SESSION_SIZES.map((s) => ({ value: s, label: `${s} cards` }))}
          value={ws.preferences.sessionSize}
          onChange={(v) => v && void ws.updatePreferences({ sessionSize: v as SessionSize })}
        />
        <div className="field">
          <label htmlFor="timezone" className="field__label">
            Timezone
          </label>
          <p id="timezone-hint" className="field__hint">
            Used for “today”, streaks, and daily activity. Due times are stored in UTC and don’t move when you change this.
          </p>
          <select
            id="timezone"
            aria-describedby="timezone-hint"
            value={tz}
            onChange={(e) => void ws.updatePreferences({ timezone: e.target.value })}
          >
            {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          {tz !== browserZone ? (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void ws.updatePreferences({ timezone: browserZone })}
            >
              Use this device’s timezone ({browserZone})
            </button>
          ) : null}
        </div>
      </section>

      <section className="section settings__group" id="backups" aria-labelledby="data-title">
        <h2 id="data-title" className="section__title">
          Your data and backups
        </h2>
        <div className="prose">
          {syncHost ? (
            <p>
              Recall keeps everything in this browser’s local storage on this device, and syncs it with your server at{' '}
              <strong>{syncHost}</strong>. Nothing is sent anywhere else.
            </p>
          ) : (
            <p>
              Recall keeps everything in this browser’s local storage on this device. Nothing is sent to a server unless you turn
              on sync below. Without sync, another browser or device has its own separate collection; move data between them with
              a full backup.
            </p>
          )}
          <p>
            Clearing this site’s data, or private-browsing modes, will erase it. On iPhone and iPad, Safari can clear data for
            sites you haven’t used in a while; adding Recall to your Home Screen (Share → Add to Home Screen) avoids that and
            gives it its own app icon.
          </p>
        </div>
        <p className="muted">
          <strong>Storage:</strong> {storageText}{' '}
          {ws.storage === 'best-effort' ? (
            <button
              type="button"
              className="button button--quiet"
              onClick={async () => {
                const status = await ws.requestPersistentStorage();
                show(
                  status === 'persisted'
                    ? 'The browser granted persistent storage.'
                    : 'The browser declined for now. Regular backups keep you safe either way.',
                  status === 'persisted' ? 'success' : 'info',
                );
              }}
            >
              Ask for persistent storage
            </button>
          ) : null}
        </p>
        <p className="muted">
          <strong>Offline use:</strong> {offlineText}
        </p>
        <p>
          <strong>Last full backup:</strong>{' '}
          {ws.lastBackupAt ? formatDateTime(ws.lastBackupAt, tz, { year: 'numeric' }) : 'never'}
        </p>

        <div className="export-options">
          <div className="export-option">
            <h3>Full backup</h3>
            <p>
              Everything: cards, schedules, review history, sessions, reflections, and preferences. Use it to restore or move
              devices.
            </p>
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={async () => {
                await downloadFullBackup(ws);
                show('Backup downloaded. Keep the file somewhere safe.');
              }}
            >
              Download full backup
            </button>
          </div>
          <div className="export-option">
            <h3>Cards only (recall-v1)</h3>
            <p>Topic, question, answer, kind, and source. No schedules or history: cards imported from it start as new.</p>
            <button
              type="button"
              className="button button--secondary"
              disabled={ws.activeCards.length === 0}
              onClick={() => downloadContentExport(ws)}
            >
              Export cards
            </button>
          </div>
        </div>

        <h3 id="restore-title">Restore from a full backup</h3>
        <p>
          Restoring replaces everything in this browser with the backup’s contents. You’ll see what the file contains before
          anything changes. Files up to 50 MB are supported.
        </p>
        <div className="field">
          <label htmlFor="restore-file" className="field__label">
            Choose a backup file (.json)
          </label>
          <input
            id="restore-file"
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              void chooseBackup(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        {restoreErrors ? (
          <Notice tone="error" title="This backup can’t be restored" onDismiss={() => setRestoreErrors(null)}>
            <p>Your current data is unchanged.</p>
            <ul>
              {restoreErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
      </section>

      <SyncSettings />

      <section className="section settings__group" aria-labelledby="ai-title">
        <h2 id="ai-title" className="section__title">
          AI feedback
        </h2>
        <p>
          <strong>Not configured.</strong> This version doesn’t grade answers or generate cards with AI, and it never sends your
          data anywhere. Practice is complete without it: compare your answer with the reference and rate it yourself. To create
          cards with an assistant, use the copy-and-paste workflow in Add knowledge → Import.
        </p>
      </section>

      <section className="section settings__group settings__danger" aria-labelledby="delete-title">
        <h2 id="delete-title" className="section__title">
          Delete all data
        </h2>
        <p>
          Permanently remove every card, review, session, reflection, and preference stored in this browser.
          {syncHost ? ' This device also stops syncing. The copy on your sync server isn’t deleted.' : ''}
        </p>
        <button type="button" className="button button--danger" onClick={() => setDeleteOpen(true)}>
          Delete all data…
        </button>
      </section>

      <ConfirmDialog
        open={!!restore}
        title="Replace this workspace?"
        confirmLabel="Replace with backup"
        tone="danger"
        busy={restoring}
        onCancel={() => setRestore(null)}
        onConfirm={() => void confirmRestore()}
      >
        {restore ? (
          <>
            <p>
              <strong>{restore.name}</strong>
              {restore.exportedAt
                ? ` · created ${formatDateTime(Date.parse(restore.exportedAt), tz, { year: 'numeric' })}`
                : ''}{' '}
              is valid. Restoring replaces everything currently in this browser.
            </p>
            {syncHost ? (
              <p>
                This device syncs with <strong>{syncHost}</strong>. Restoring turns sync off here. To put the restored data on
                your server as well, reconnect afterward and choose <em>Replace the server’s copy with this device’s</em>.
              </p>
            ) : null}
            <div className="counts-compare">
              <CountsTable counts={current} caption="Now in this browser" />
              <CountsTable counts={restore.counts} caption="In the backup" />
            </div>
            {restore.counts.reviews + restore.counts.cards > 5000 ? (
              <p className="muted">Large backups can take up to a minute to restore. Keep this tab open until it finishes.</p>
            ) : null}
            <p>
              <button type="button" className="button button--secondary" onClick={() => void downloadFullBackup(ws)}>
                Download a backup of current data first
              </button>
            </p>
          </>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete all Recall data?"
        confirmLabel="Delete everything"
        tone="danger"
        busy={busy}
        confirmDisabled={deleteText.trim().toLowerCase() !== 'delete'}
        onCancel={() => {
          setDeleteOpen(false);
          setDeleteText('');
        }}
        onConfirm={() => void deleteEverything()}
      >
        <p>
          This removes {current.cards} cards, {current.reviews} reviews, and {current.reflections} reflections from this browser.
          It can’t be undone. Consider downloading a full backup first.
          {syncHost ? ` This device will stop syncing; the copy on ${syncHost} stays.` : ''}
        </p>
        <div className="field">
          <label htmlFor="delete-confirm" className="field__label">
            Type <strong>delete</strong> to confirm
          </label>
          <input
            id="delete-confirm"
            type="text"
            value={deleteText}
            onChange={(e) => setDeleteText(e.target.value)}
            autoComplete="off"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
