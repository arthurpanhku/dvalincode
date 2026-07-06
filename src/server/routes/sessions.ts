import { Router } from 'express';
import { listSessions, loadSession, deleteSession, deleteAllSessions } from '../../sessions/store.js';
import { renderSessionMarkdown } from '../../sessions/markdown.js';
import { allowWorkspaceRoot } from '../security.js';

export const sessionsRouter = Router();

sessionsRouter.get('/', async (_req, res) => {
  const sessions = await listSessions();
  res.json(
    sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      cwd: s.cwd,
      goal: s.goal,
      summary: s.summary,
      messageCount: s.messages.length,
    })),
  );
});

sessionsRouter.delete('/', async (_req, res) => {
  const deleted = await deleteAllSessions();
  res.json({ ok: true, deleted });
});

sessionsRouter.get('/:id', async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await allowWorkspaceRoot(session.cwd).catch(() => {});
  res.json(session);
});

// Download the conversation as a Markdown transcript.
sessionsRouter.get('/:id/markdown', async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${session.id}.md"`);
  res.send(renderSessionMarkdown(session));
});

sessionsRouter.delete('/:id', async (req, res) => {
  await deleteSession(req.params.id);
  res.json({ ok: true });
});
