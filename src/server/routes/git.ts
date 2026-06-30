import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rateLimit } from 'express-rate-limit';
import { resolveAllowedCwd } from '../security.js';

const execAsync = promisify(execFile);
export const gitRouter = Router();
gitRouter.use(rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}));

gitRouter.get('/', async (req, res) => {
  try {
    const cwd = await resolveAllowedCwd(typeof req.query.cwd === 'string' ? req.query.cwd : undefined);
    const { stdout: branch } = await execAsync('git', ['branch', '--show-current'], { cwd });
    const { stdout: log } = await execAsync('git', ['log', '--oneline', '-1'], { cwd });
    res.json({ branch: branch.trim() || null, lastCommit: log.trim() || null });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Workspace is not allowed')) {
      res.status(403).json({ error: err.message });
      return;
    }
    res.json({ branch: null, lastCommit: null });
  }
});
