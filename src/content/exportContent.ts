import type { Card, CardContent } from '../domain/types';

export interface ContentExport {
  format: 'recall-v1';
  exportedAt: string;
  note: string;
  cards: CardContent[];
}

/**
 * Content-only export (recall-v1): topic, question, answer, kind, source.
 * It deliberately carries no schedules or review history.
 */
export function buildContentExport(cards: Card[], now: number): ContentExport {
  return {
    format: 'recall-v1',
    exportedAt: new Date(now).toISOString(),
    note: 'Content only. Schedules and review history are not included; imported cards start as new.',
    cards: cards
      .filter((c) => c.deletedAt === null)
      .map(({ topic, question, answer, kind, source }) => ({ topic, question, answer, kind, source })),
  };
}

export function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileStamp(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
