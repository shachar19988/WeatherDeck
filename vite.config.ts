import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Absolute base: the Android wrapper serves dist/ over its own https origin
// (see MainActivity), so root-relative URLs resolve there exactly as on the web
// and the service worker gets a real scope.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
