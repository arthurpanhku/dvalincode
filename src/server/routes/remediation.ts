import { Router } from 'express';
import { listRemediationCases, updateRemediationCase, upsertRemediationCases } from '../../remediation/cases.js';
import { runLocalSecurityScan } from '../../remediation/localScan.js';
import { parseSarifForRemediation } from '../../remediation/sarif.js';
import { createRemediationWorktree } from '../../remediation/worktree.js';
import { allowWorkspaceRoot, resolveAllowedCwd } from '../security.js';

export const remediationRouter = Router();

remediationRouter.get('/cases', async (req, res) => {
  try {
    const cwd = typeof req.query.cwd === 'string' && req.query.cwd
      ? await resolveAllowedCwd(req.query.cwd)
      : undefined;
    res.json(await listRemediationCases({ cwd }));
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Could not list remediation cases' });
  }
});

remediationRouter.post('/cases', async (req, res) => {
  const body = req.body as { cwd?: string; findings?: unknown };
  if (!Array.isArray(body.findings)) {
    res.status(400).json({ error: 'findings are required' });
    return;
  }

  try {
    const cwd = body.cwd ? await resolveAllowedCwd(body.cwd) : undefined;
    res.json(await upsertRemediationCases({ cwd, findings: body.findings as Parameters<typeof upsertRemediationCases>[0]['findings'] }));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not save remediation cases' });
  }
});

remediationRouter.patch('/cases/:id', async (req, res) => {
  try {
    res.json(await updateRemediationCase(req.params.id, req.body as Parameters<typeof updateRemediationCase>[1]));
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Could not update remediation case' });
  }
});

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
  const body = req.body as { cwd?: string; finding?: Parameters<typeof createRemediationWorktree>[1]; caseId?: string };
  if (!body.finding || !body.cwd) {
    res.status(400).json({ error: 'cwd and finding are required' });
    return;
  }

  try {
    const cwd = await resolveAllowedCwd(body.cwd);
    const result = await createRemediationWorktree(cwd, body.finding);
    await allowWorkspaceRoot(result.cwd);
    if (body.caseId) {
      await updateRemediationCase(body.caseId, {
        status: 'worktree_ready',
        worktreeCwd: result.cwd,
        branch: result.branch,
        prompt: result.prompt,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create remediation worktree' });
  }
});
