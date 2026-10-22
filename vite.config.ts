/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Writes dist/sw.js from src/offline/sw.js after each production build, with
 * the list of files to precache and a version derived from their contents.
 * Legacy .woff fonts are skipped: every browser that supports service workers
 * uses the .woff2 files.
 */
function recallServiceWorker(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  return {
    name: 'recall-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else files.push(relative(outDir, path).split('\\').join('/'));
        }
      };
      await walk(outDir);
      const precache = files.filter((f) => f !== 'sw.js' && !f.endsWith('.woff') && !f.endsWith('.map')).sort();

      const hash = createHash('sha256');
      for (const file of precache) {
        hash.update(file);
        hash.update(await readFile(join(outDir, file)));
      }
      const version = hash.digest('hex').slice(0, 12);

      const template = await readFile(resolve(root, 'src/offline/sw.js'), 'utf8');
      const versionLine = "const VERSION = '__RECALL_VERSION__';";
      const precacheLine = 'const PRECACHE = __RECALL_PRECACHE__;';
      if (!template.includes(versionLine) || !template.includes(precacheLine)) {
        throw new Error('src/offline/sw.js is missing its VERSION or PRECACHE placeholder line.');
      }
      const worker = template
        .replace(versionLine, `const VERSION = ${JSON.stringify(version)};`)
        .replace(precacheLine, `const PRECACHE = ${JSON.stringify(precache)};`);
      await writeFile(join(outDir, 'sw.js'), worker);
    },
  };
}

// `base: './'` keeps asset URLs relative so the build works from any static
// host path (GitHub Pages subfolder, a local file server, etc.). Routing is
// hash-based for the same reason: no server rewrites are needed.
export default defineConfig({
  base: './',
  plugins: [react(), recallServiceWorker()],
  server: { port: 5173 },
  preview: { port: 4173 },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/server/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
});
