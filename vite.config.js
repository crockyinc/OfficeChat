import { defineConfig } from 'vite';
export default defineConfig({ root: 'frontend', build: { outDir: '../dist', emptyOutDir: true }, server: { host: '0.0.0.0', allowedHosts: true, proxy: { '/signal': { target: 'ws://127.0.0.1:8787', ws: true, xfwd: true }, '/config': 'http://127.0.0.1:8787' } } });
