import { copyFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  clearScreen: false,
  plugins: [{
    name: 'copy-classic-scripts',
    closeBundle() {
      copyFileSync('app.js', 'dist/app.js');
      copyFileSync('core.js', 'dist/core.js');
      copyFileSync('collection.js', 'dist/collection.js');
    }
  }]
});
