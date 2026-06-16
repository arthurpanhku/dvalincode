import { Router } from 'express';
import { listSessions, loadSession, deleteSession } from '../../sessions/store.js';
import { renderSessionMarkdown } from '../../sessions/markdown.js';

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

sessionsRouter.get('/:id', async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
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
