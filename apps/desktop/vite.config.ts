import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  // Tauri expects a fixed port.
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022' },
  test: { include: ['test/**/*.test.ts'] },
});
