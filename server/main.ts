// Recall sync server. Serves the built app and the sync API from one origin.
//
//   node dist-server/recall-server.mjs            start the server
//   node dist-server/recall-server.mjs key        print the sync key (creating it if needed)
//   node dist-server/recall-server.mjs backup [file]
//                                                 write the server's data as a recall-backup file
//
// Settings come from environment variables; see docs/SYNC.md.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackup } from '../src/content/backup';
import { MAX_BODY_BYTES } from '../src/sync/protocol';
import { createHandler } from './handler';
import { openServerStore } from './store';

const MIN_KEY_LENGTH = 16;

interface Config {
  host: string;
  port: number;
  dataDir: string;
  staticDir: string | null;
  allowedOrigins: string[];
  keyFromEnv: string | null;
}

function readConfig(env: NodeJS.ProcessEnv): Config {
  const here = dirname(fileURLToPath(import.meta.url));
  const port = Number(env.RECALL_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`RECALL_PORT must be a port number, not ${env.RECALL_PORT}.`);
  const staticSetting = env.RECALL_STATIC_DIR;
  let staticDir: string | null =
    staticSetting === undefined ? resolve(here, '../dist') : staticSetting ? resolve(staticSetting) : null;
  if (staticDir && !existsSync(join(staticDir, 'index.html'))) {
    console.warn(`No built app at ${staticDir} (run npm run build). Serving the sync API only.`);
    staticDir = null;
  }
  return {
    host: env.RECALL_HOST ?? '127.0.0.1',
    port,
    dataDir: resolve(env.RECALL_DATA_DIR ?? 'data'),
    staticDir,
    allowedOrigins: (env.RECALL_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    keyFromEnv: env.RECALL_SYNC_KEY?.trim() || null,
  };
}

/** The sync key: from RECALL_SYNC_KEY, or a random one kept in the data folder. */
function loadSyncKey(config: Config): { key: string; source: string } {
  if (config.keyFromEnv) {
    if (config.keyFromEnv.length < MIN_KEY_LENGTH)
      throw new Error(`RECALL_SYNC_KEY must be at least ${MIN_KEY_LENGTH} characters.`);
    return { key: config.keyFromEnv, source: 'RECALL_SYNC_KEY' };
  }
  const file = join(config.dataDir, 'sync-key');
  if (existsSync(file)) {
    const key = readFileSync(file, 'utf8').trim();
    if (key.length < MIN_KEY_LENGTH) throw new Error(`${file} must hold a key of at least ${MIN_KEY_LENGTH} characters.`);
    return { key, source: file };
  }
  const key = randomBytes(32).toString('base64url');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return { key, source: `${file} (new)` };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function serve(config: Config) {
  const { key, source } = loadSyncKey(config);
  const store = openServerStore(join(config.dataDir, 'recall-sync.sqlite'));
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const handle = createHandler({
    store,
    syncKey: key,
    staticDir: config.staticDir,
    allowedOrigins: config.allowedOrigins,
    backupDir: join(config.dataDir, 'backups'),
    log,
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    try {
      const method = req.method ?? 'GET';
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const body = method === 'GET' || method === 'HEAD' ? undefined : (await readBody(req)).toString('utf8');
      const request = new Request(new URL(req.url ?? '/', 'http://localhost'), { method, headers, body });
      const response = await handle(request);
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => (out[name] = value));
      res.writeHead(response.status, out);
      res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
      if (req.url?.startsWith('/api/sync/'))
        log(`${method} ${req.url.split('?')[0]} ${response.status} ${Date.now() - started}ms`);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status === 500) log(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end(status === 413 ? 'Request body too large' : 'Server error');
    }
  });

  server.listen(config.port, config.host, () => {
    log(`Recall sync server listening on http://${config.host}:${config.port}`);
    log(config.staticDir ? `Serving the app from ${config.staticDir}` : 'Not serving the app (API only)');
    log(`Data: ${config.dataDir}`);
    log(`Sync key: ${source}`);
    if (config.allowedOrigins.length > 0) log(`Allowed browser origins: ${config.allowedOrigins.join(', ')}`);
  });

  const stop = () => {
    log('Shutting down');
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function main(argv: string[]) {
  // Everything the server writes (database, key, backups) is readable by its own user only.
  process.umask(0o077);
  const config = readConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const [command = 'serve', arg] = argv;
  switch (command) {
    case 'serve':
      serve(config);
      return;
    case 'key':
      console.log(loadSyncKey(config).key);
      return;
    case 'backup': {
      const store = openServerStore(join(config.dataDir, 'recall-sync.sqlite'));
      const json = JSON.stringify(buildBackup(store.exportData(), Date.now()), null, 2);
      store.close();
      if (arg) {
        writeFileSync(arg, json, { mode: 0o600 });
        console.error(`Wrote ${arg}`);
      } else {
        process.stdout.write(`${json}\n`);
      }
      return;
    }
    default:
      console.error(`Unknown command "${command}". Use: serve, key, or backup [file].`);
      process.exit(2);
  }
}

main(process.argv.slice(2));
