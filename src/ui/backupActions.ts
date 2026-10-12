import { buildBackup } from '../content/backup';
import { buildContentExport, downloadJson, fileStamp } from '../content/exportContent';
import type { Workspace } from '../app/workspace';

export const BACKUP_REMINDER_DAYS = 14;

export async function downloadFullBackup(ws: Workspace): Promise<void> {
  const now = Date.now();
  const data = await ws.repo.exportWorkspace();
  downloadJson(`recall-backup-${fileStamp(now)}.json`, buildBackup(data, now));
  await ws.repo.setLastBackupAt(now);
  await ws.refresh();
}

export function downloadContentExport(ws: Workspace): void {
  const now = Date.now();
  downloadJson(`recall-cards-${fileStamp(now)}.json`, buildContentExport(ws.activeCards, now));
}

export function backupIsStale(ws: Workspace): boolean {
  if (ws.activeCards.length === 0) return false;
  if (ws.lastBackupAt === null) return true;
  return ws.now - ws.lastBackupAt > BACKUP_REMINDER_DAYS * 86_400_000;
}
