import { Router } from 'express';
import { deleteSkill, installSkillBundle, listSkills, readSkill } from '../../skills/store.js';

export const skillsRouter = Router();

skillsRouter.get('/', async (_req, res) => {
  try {
    res.json(await listSkills());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not list skills' });
  }
});

skillsRouter.post('/import', async (req, res) => {
  try {
    res.json(await installSkillBundle(req.body));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not import skill' });
  }
});

skillsRouter.get('/:name', async (req, res) => {
  try {
    res.json(await readSkill(req.params.name));
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Skill not found' });
  }
});

skillsRouter.get('/:name/download', async (req, res) => {
  try {
    const bundle = await readSkill(req.params.name);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.manifest.name}.dvalin-skill.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Skill not found' });
  }
});

skillsRouter.delete('/:name', async (req, res) => {
  try {
    await deleteSkill(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not delete skill' });
  }
});
