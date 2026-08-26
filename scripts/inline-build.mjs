import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(root, 'dist', 'index.html');
let html = readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script type="module"[^>]*src="\.\/(assets\/[^"]+)"[^>]*><\/script>/);
const styleMatch = html.match(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+)"[^>]*>/);
if (!scriptMatch || !styleMatch) throw new Error('Vite output assets were not found');
const script = readFileSync(resolve(root, 'dist', scriptMatch[1]), 'utf8').replaceAll('</script>', '<\\/script>');
const style = readFileSync(resolve(root, 'dist', styleMatch[1]), 'utf8').replaceAll('</style>', '<\\/style>');
html = html.replace(styleMatch[0], () => `<style>${style}</style>`);
html = html.replace(scriptMatch[0], '');
html = html.replace(
  '</body>',
  () => `<script id="weatherdeck-bundle">${script}</script></body>`,
);
writeFileSync(htmlPath, html);
