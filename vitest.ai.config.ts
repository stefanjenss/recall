import { defineConfig } from 'vitest/config';

// `npm run test:ai-real`: the curated fixtures against the real, configured
// model provider. Kept out of `npm test` because it spends provider requests.
export default defineConfig({
  test: { environment: 'node', include: ['tests/ai/real-provider.test.ts'], fileParallelism: false },
});
