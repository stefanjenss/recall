/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` keeps asset URLs relative so the build works from any static
// host path (GitHub Pages subfolder, a local file server, etc.). Routing is
// hash-based for the same reason: no server rewrites are needed.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
});
