import { Router } from 'express';
import { runLocalSecurityScan } from '../../remediation/localScan.js';
import { parseSarifForRemediation } from '../../remediation/sarif.js';
import { createRemediationWorktree } from '../../remediation/worktree.js';
import { allowWorkspaceRoot, resolveAllowedCwd } from '../security.js';

export const remediationRouter = Router();

remediationRouter.post('/sarif', async (req, res) => {
  const body = req.body as { report?: unknown; cwd?: string };
  if (!body.report) {
    res.status(400).json({ error: 'report is required' });
    return;
  }

  let cwd: string | undefined;
  if (body.cwd) {
    try {
      cwd = await resolveAllowedCwd(body.cwd);
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : 'Workspace is not allowed' });
      return;
    }
  }

  try {
    const result = await parseSarifForRemediation(body.report, { cwd });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not parse SARIF report' });
  }
});

remediationRouter.post('/scan', async (req, res) => {
  const body = req.body as { cwd?: string };

  try {
    const cwd = await resolveAllowedCwd(body.cwd);
    res.json(await runLocalSecurityScan(cwd));
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Could not run local security scan' });
  }
});

remediationRouter.post('/worktree', async (req, res) => {
  const body = req.body as { cwd?: string; finding?: Parameters<typeof createRemediationWorktree>[1] };
  if (!body.finding || !body.cwd) {
    res.status(400).json({ error: 'cwd and finding are required' });
    return;
  }

  try {
    const cwd = await resolveAllowedCwd(body.cwd);
    const result = await createRemediationWorktree(cwd, body.finding);
    await allowWorkspaceRoot(result.cwd);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create remediation worktree' });
  }
});
