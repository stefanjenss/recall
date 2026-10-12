import { defineConfig } from 'vite';

// Bundles the sync server (server/main.ts plus the shared src/ code it uses)
// into one file that runs on Node with no installed dependencies.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'server/main.ts',
    outDir: 'dist-server',
    target: 'node22',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'recall-server.mjs' } },
  },
});
