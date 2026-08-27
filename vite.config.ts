import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/**
 * Which build you are looking at, shown in Preferences.
 *
 * A screenshot of a bug is only useful if the version in it is known. Without
 * this, "it still happens" and "you are still on the old APK" look identical
 * from the outside, and the wrong one gets debugged.
 */
function buildStamp() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
import react from '@vitejs/plugin-react';

// Absolute base: the Android wrapper serves dist/ over its own https origin
// (see MainActivity), so root-relative URLs resolve there exactly as on the web
// and the service worker gets a real scope.
export default defineConfig({
  base: '/',
  plugins: [react()],
  define: {
    __BUILD__: JSON.stringify(`${buildStamp()} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`),
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
