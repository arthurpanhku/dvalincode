import { Router, type Request, type Response } from 'express';
import { executeSecurityScan, type ExecutedSecurityScan } from '../../commands/security.js';
import { UsageError } from '../../core/exitCodes.js';
import { listRemediationCases, updateRemediationCase, upsertRemediationCases } from '../../remediation/cases.js';
import { runLocalSecurityScan } from '../../remediation/localScan.js';
import { parseSarifForRemediation } from '../../remediation/sarif.js';
import { createRemediationWorktree } from '../../remediation/worktree.js';
import {
  dvalinScannerInstallPlan,
  installDvalinScanner,
  listDvalinScanners,
  type DvalinScannerId,
} from '../../remediation/scannerSuite.js';
import { verifyFixRecord } from '../../security/fixRecord.js';
import { allowWorkspaceRoot, resolveAllowedCwd } from '../security.js';
import { consumeScannerWorkspaceGrant, issueScannerWorkspaceGrant } from '../scannerWorkspaceGrants.js';

export const remediationRouter = Router();

export type SuiteRouteDeps = {
  executeScan: typeof executeSecurityScan;
  consumeGrant: typeof consumeScannerWorkspaceGrant;
  upsertCases: typeof upsertRemediationCases;
};

const suiteRouteDeps: SuiteRouteDeps = {
  executeScan: executeSecurityScan,
  consumeGrant: consumeScannerWorkspaceGrant,
  upsertCases: upsertRemediationCases,
};

type SuiteRequestBody = {
  grant?: string;
  scanners?: DvalinScannerId[];
};

type SuiteResponse = ExecutedSecurityScan['scan'] & {
  scan: ExecutedSecurityScan['scan'];
  coverage: ExecutedSecurityScan['coverage'];
  delta: ExecutedSecurityScan['delta'] | null;
  gate: ExecutedSecurityScan['gate'];
  workflowId: string | null;
  schemaVersion: ExecutedSecurityScan['schemaVersion'];
  cases: Awaited<ReturnType<typeof upsertRemediationCases>>;
};

/**
 * Server adapter for the versioned security scan contract.
 *
 * The scan is intentionally still spread at the top level: the current web
 * client consumes that legacy shape. The versioned envelope is added beside
 * it so newer clients can reason about coverage and the gate without breaking
 * existing ones.
 */
export async function handleSuiteRequest(
  req: Request,
  res: Response,
  deps: SuiteRouteDeps = suiteRouteDeps,
): Promise<void> {
  const body = req.body as SuiteRequestBody;
  try {
    const allowedScanners = new Set<DvalinScannerId>(['builtin', 'semgrep', 'trivy', 'osv-scanner']);
    if (body.scanners && (!Array.isArray(body.scanners) || body.scanners.some(scanner => !allowedScanners.has(scanner)))) {
      res.status(400).json({ error: 'scanners must contain only builtin, semgrep, trivy, or osv-scanner' });
      return;
    }

    // The capability is consumed before any scan input is used. Its canonical
    // server-side cwd remains the only workspace root passed to the scanner.
    const cwd = deps.consumeGrant(body.grant);
    const execution = await deps.executeScan({
      root: cwd,
      scanners: body.scanners,
      saveWorkflow: false,
    });
    const cases = execution.scan.findings.length
      ? await deps.upsertCases({ cwd, findings: execution.scan.findings })
      : [];
    const response: SuiteResponse = {
      ...execution.scan,
      scan: execution.scan,
      coverage: execution.coverage,
      delta: execution.delta ?? null,
      gate: execution.gate,
      workflowId: execution.workflow?.id ?? null,
      schemaVersion: execution.schemaVersion,
      cases,
    };
    res.json(response);
  } catch (err) {
    // A new-findings gate without a baseline is a bad request, not a scanner
    // crash. Preserve UsageError text so the caller sees the baseline remedy.
    if (err instanceof UsageError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not run Dvalin security suite' });
  }
}

export function handleVerifyFixRequest(req: Request, res: Response): void {
  const verification = verifyFixRecord(req.body);
  res.json({
    ok: verification.ok,
    reasons: verification.reasons,
    record: verification.record ?? null,
  });
}

remediationRouter.get('/scanners', async (_req, res) => {
  res.json(await listDvalinScanners());
});

remediationRouter.post('/scanners/install', async (req, res) => {
  const body = req.body as { cwd?: string; scanner?: DvalinScannerId; command?: string; confirmed?: boolean };
  const allowed = new Set<DvalinScannerId>(['semgrep', 'trivy', 'osv-scanner']);
  if (!body.scanner || !allowed.has(body.scanner)) {
    res.status(400).json({ error: 'scanner must be semgrep, trivy, or osv-scanner' });
    return;
  }
  const plan = dvalinScannerInstallPlan(body.scanner);
  if (!plan.command || body.confirmed !== true || body.command !== plan.command) {
    res.status(400).json({ error: 'The fixed scanner install command must be explicitly confirmed.' });
    return;
  }
  try {
    const cwd = await resolveAllowedCwd(body.cwd);
    await installDvalinScanner(cwd, body.scanner);
    const scanner = (await listDvalinScanners()).find(candidate => candidate.id === body.scanner);
    if (!scanner?.available) throw new Error(`${body.scanner} completed installation but is not available on PATH.`);
    res.json(scanner);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not install scanner' });
  }
});

remediationRouter.post('/suite/authorize', async (req, res) => {
  const body = req.body as { cwd?: string };
  try {
    const cwd = await resolveAllowedCwd(body.cwd);
    res.json({ grant: issueScannerWorkspaceGrant(cwd) });
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Workspace is not allowed' });
  }
});

remediationRouter.post('/suite', (req, res) => void handleSuiteRequest(req, res));

remediationRouter.post('/verify-fix', handleVerifyFixRequest);

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
