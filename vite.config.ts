import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-only helper: POST /__debug/save?name=file.png stores a capture under .debug/
// (used to inspect full-resolution renders while developing).
function debugCaptures(): Plugin {
  return {
    name: 'debug-captures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__debug/save', (req, res) => {
        const url = new URL(req.url ?? '', 'http://x');
        const name = path.basename(url.searchParams.get('name') ?? 'capture.png');
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          fs.mkdirSync('.debug', { recursive: true });
          fs.writeFileSync(path.join('.debug', name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [debugCaptures()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  server: { watch: { ignored: ['**/.debug/**'] } },
});
