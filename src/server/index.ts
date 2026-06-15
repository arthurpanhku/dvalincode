import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { sessionsRouter } from './routes/sessions.js';
import { toolsRouter } from './routes/tools.js';
import { configRouter } from './routes/config.js';
import { filesRouter } from './routes/files.js';
import { gitRouter } from './routes/git.js';
import { projectsRouter } from './routes/projects.js';
import { getPlaybook, savePlaybook } from './playbookHandler.js';
import { handleWebSocket } from './wsHandler.js';
import { isAllowedRequestOrigin } from './security.js';

const __serverPath = fileURLToPath(import.meta.url);
const __serverDir = path.dirname(__serverPath);

// Bun compiled binaries embed source files in virtual paths:
// macOS/Linux use $bunfs, while Windows uses a ~BUN root.
const isBunBinary = import.meta.url.includes('$bunfs') || __serverPath.split(/[\\/]/).includes('~BUN');

// Dev mode: __serverDir is src/server/ → tsconfig.json is 2 levels up
const isDev = !isBunBinary && existsSync(path.join(__serverDir, '../../tsconfig.json'));

const webDist = isBunBinary
  ? path.join(path.dirname(process.execPath), 'web', 'dist')
  : isDev
    ? path.join(__serverDir, '../../web/dist')
    : path.join(__serverDir, 'web', 'dist');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin, req }, done) => {
    done(isAllowedRequestOrigin(origin, req.headers.host), 403, 'Forbidden');
  },
});

app.use((req, res, next) => {
  if (!isAllowedRequestOrigin(req.headers.origin, req.headers.host)) {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }
  next();
});
app.use(cors());
app.use(express.json());

app.use('/api/sessions', sessionsRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/config', configRouter);
app.use('/api/files', filesRouter);
app.use('/api/git', gitRouter);
app.use('/api/projects', projectsRouter);
app.get('/api/playbook', (req, res) => void getPlaybook(req, res));
app.post('/api/playbook', (req, res) => void savePlaybook(req, res));

// Serve built frontend
app.use(express.static(webDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'));
});

wss.on('connection', (ws) => {
  handleWebSocket(ws);
});

/**
 * Start the HTTP + WebSocket server. Exported so the `serve` command (and the
 * unified binary) can launch it; importing this module no longer binds a port.
 *
 * `open` controls the browser auto-open. When left undefined it falls back to
 * the legacy behavior: open only when running as a compiled binary (not dev)
 * and `DVALINCODE_NO_OPEN` is unset.
 */
export function startServer(
  opts: { port?: number; host?: string; open?: boolean } = {},
): Promise<{ url: string; port: number; host: string }> {
  const port = opts.port ?? parseInt(process.env.PORT ?? '3000', 10);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const url = `http://localhost:${port}`;
      console.log('');
      console.log('DvalinCode is running.');
      console.log(`Open the Web GUI to use the coding assistant: ${url}`);
      console.log('Keep this terminal window open while you work.');
      console.log(`Workspace roots: ${process.env.DVALINCODE_WORKSPACE_ROOTS ?? `${process.cwd()} plus ~/.dvalincode/projects`}`);
      console.log('');

      const shouldOpen = opts.open ?? (!isDev && process.env.DVALINCODE_NO_OPEN !== '1');
      if (shouldOpen) {
        const cmd =
          process.platform === 'darwin' ? `open "${url}"` :
          process.platform === 'win32'  ? `start "" "${url}"` :
                                           `xdg-open "${url}"`;
        exec(cmd, () => { /* ignore errors */ });
      }
      resolve({ url, port, host });
    });
  });
}
