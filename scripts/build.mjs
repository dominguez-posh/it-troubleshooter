import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/overlay', { recursive: true });

const common = { bundle: true, sourcemap: false, logLevel: 'warning' };

await build({
  ...common,
  entryPoints: { 'main/main': 'src/main/main.ts' },
  outdir: 'dist',
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  packages: 'external',
});
// Sandbox-Preloads müssen einzelne Dateien sein (nur 'electron' ist require-bar).
await build({
  ...common,
  entryPoints: {
    'preload/preload': 'src/preload/preload.ts',
    'preload/overlay-preload': 'src/preload/overlay-preload.ts',
  },
  outdir: 'dist',
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: { 'renderer/renderer': 'src/renderer/renderer.ts', 'overlay/overlay': 'src/overlay/overlay.ts' },
  outdir: 'dist',
  platform: 'browser',
  format: 'iife',
  target: 'chrome140',
});
await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');
await cp('src/overlay/overlay.html', 'dist/overlay/overlay.html');
console.log('Build fertig: dist/');
