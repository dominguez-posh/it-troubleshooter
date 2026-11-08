import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/overlay', { recursive: true });
await mkdir('dist/chat', { recursive: true });
await mkdir('dist/ui', { recursive: true });

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
    'preload/chat-preload': 'src/preload/chat-preload.ts',
  },
  outdir: 'dist',
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: { 'renderer/renderer': 'src/renderer/renderer.ts', 'overlay/overlay': 'src/overlay/overlay.ts', 'chat/chat': 'src/chat/chat.ts' },
  outdir: 'dist',
  platform: 'browser',
  format: 'iife',
  target: 'chrome140',
});
await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');
await cp('src/overlay/overlay.html', 'dist/overlay/overlay.html');
await cp('src/chat/chat.html', 'dist/chat/chat.html');
await cp('src/chat/chat.css', 'dist/chat/chat.css');
await cp('src/ui/tokens.css', 'dist/ui/tokens.css');
await cp('src/ui/base.css', 'dist/ui/base.css');
console.log('Build fertig: dist/');
