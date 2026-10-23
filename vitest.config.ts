import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: { '#lib': fileURLToPath(new URL('./src/lib', import.meta.url)) } }, test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 20000 } });
