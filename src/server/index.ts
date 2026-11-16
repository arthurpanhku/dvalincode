import { executeRollback } from '../commands/checkpoint.js';
import { loadCheckpoint } from '../core/checkpoint.js';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { rateLimit } from 'express-rate-limit';
import { sessionsRouter } from './routes/sessions.js';
import { toolsRouter } from './routes/tools.js';
import { configRouter } from './routes/config.js';
import { filesRouter } from './routes/files.js';
import { gitRouter } from './routes/git.js';
import { projectsRouter } from './routes/projects.js';
import { dataRouter } from './routes/data.js';
import { remediationRouter } from './routes/remediation.js';
import { skillsRouter } from './routes/skills.js';
import { getPlaybook, savePlaybook } from './playbookHandler.js';
import { handleWebSocket } from './wsHandler.js';
import { isAllowedRequestOrigin, resolveAllowedCwd } from './security.js';
import { accessCookie, accessCookieName, isAuthorized, resolveAccessToken, tokenMatches, type AccessToken } from './auth.js';

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
const localAppLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const localMutationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
// Set by startServer once the port is known; until then every request is refused.
let access: AccessToken | undefined;

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 12 * 1024 * 1024,
  verifyClient: ({ origin, req }, done) => {
    if (!isAllowedRequestOrigin(origin, req.headers.host)) {
      done(false, 403, 'Forbidden');
      return;
    }
    if (!isAuthorized(req, access)) {
      done(false, 401, 'Unauthorized');
      return;
    }
    done(true);
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
app.use(localAppLimiter);

// The only /api route open without the token: the page asks whether it holds
// the cookie, and trades the token from its launch URL (or a pasted one) for it.
app.get('/api/auth/session', (req, res) => {
  res.status(isAuthorized(req, access) ? 204 : 401).end();
});
app.post('/api/auth/session', localMutationLimiter, express.json({ limit: '4kb' }), (req, res) => {
  if (!access || !tokenMatches(access.token, req.body?.token)) {
    res.status(401).json({ error: 'Invalid access token' });
    return;
  }
  res.setHeader('Set-Cookie', accessCookie(access));
  res.status(204).end();
});
// Checked before the body parser, so a caller without the token cannot make the
// server parse a 64 MB request.
app.use('/api', (req, res, next) => {
  if (!isAuthorized(req, access)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// Larger limit: data import accepts a full local-data bundle (sessions + audit).
app.use(express.json({ limit: '64mb' }));

app.use('/api/sessions', sessionsRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/config', configRouter);
app.use('/api/files', filesRouter);
app.use('/api/git', gitRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/data', dataRouter);
app.post('/api/checkpoint/rollback', localMutationLimiter, async (req, res) => {
  const runId = req.body?.runId;
  if (typeof runId !== 'string') {
    res.status(400).json({ error: 'A checkpoint run ID is required' });
    return;
  }
  try {
    const { root } = await loadCheckpoint(runId);
    const cwd = await resolveAllowedCwd(root);
    const output = await executeRollback(runId, cwd);
    res.json({ output });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.use('/api/remediation', localMutationLimiter, remediationRouter);
app.use('/api/skills', localMutationLimiter, skillsRouter);
app.get('/api/playbook', localMutationLimiter, (req, res) => void getPlaybook(req, res));
app.post('/api/playbook', localMutationLimiter, (req, res) => void savePlaybook(req, res));

// Serve built frontend
app.use(express.static(webDist));
app.get(/.*/, (_req, res) => {
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
 *
 * `token` is the access token (see ./auth.ts); without one, `DVALINCODE_SERVER_TOKEN`
 * or a fresh random token is used. The returned `url` carries it.
 */
export function startServer(
  opts: { port?: number; host?: string; open?: boolean; token?: string } = {},
): Promise<{ url: string; port: number; host: string; close: () => Promise<void> }> {
  const port = opts.port ?? parseInt(process.env.PORT ?? '3000', 10);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const token = resolveAccessToken(opts.token ?? process.env.DVALINCODE_SERVER_TOKEN);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // Resolve the actual bound port — supports an ephemeral port (0), which
      // the desktop GUI uses to avoid colliding with a running `serve`.
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      access = { token, cookieName: accessCookieName(actualPort) };
      const url = `http://localhost:${actualPort}/?token=${token}`;
      console.log('');
      console.log('DvalinCode is running.');
      console.log(`Open the Web GUI to use the coding assistant: ${url}`);
      console.log('The link carries this server\'s access token — anyone holding it can drive the agent, so keep it private.');
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
      resolve({
        url,
        port: actualPort,
        host,
        close: () => new Promise<void>((done) => {
          for (const client of wss.clients) client.terminate();
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
