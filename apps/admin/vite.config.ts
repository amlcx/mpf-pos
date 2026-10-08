import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  // The API serves the built panel under /panel/ (see apps/api/src/app.ts).
  base: '/panel/',
  server: { port: 5174, strictPort: true },
  build: { target: 'es2022' },
});
