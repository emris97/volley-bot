import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@volley/application': packageSource('application'),
      '@volley/config': packageSource('config'),
      '@volley/contracts': packageSource('contracts'),
      '@volley/domain': packageSource('domain'),
      '@volley/persistence': packageSource('persistence'),
      '@volley/telegram': packageSource('telegram'),
    },
  },
  test: {
    environment: 'node',
    exclude: ['**/dist/**', '**/node_modules/**', '**/.worktrees/**'],
    include: ['**/*.spec.ts'],
  },
});
