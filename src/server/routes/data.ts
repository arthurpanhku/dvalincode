import { Router } from 'express';
import { exportData, importData, isDataBundle } from '../../data/archive.js';

export const dataRouter = Router();

// Download a portable bundle of all local data. `?audit=0` excludes audit logs.
dataRouter.get('/export', async (req, res) => {
  const includeAudit = req.query.audit !== '0' && req.query.audit !== 'false';
  const bundle = await exportData({ includeAudit });
  const filename = `dvalincode-export-${bundle.exportedAt.replace(/[:.]/g, '-')}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(bundle));
});

// Restore from a bundle posted as JSON. `?overwrite=0` keeps existing files.
dataRouter.post('/import', async (req, res) => {
  const bundle = req.body;
  if (!isDataBundle(bundle)) {
    res.status(400).json({ error: 'Request body is not a DvalinCode export bundle.' });
    return;
  }
  const overwrite = req.query.overwrite !== '0' && req.query.overwrite !== 'false';
  try {
    const result = await importData(bundle, { overwrite });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
