# Asset Provenance

This directory contains DvalinCode-owned visual assets used in the README,
website, and release materials.

| Path | Provenance | Notes |
|---|---|---|
| `logo.png` | Created for DvalinCode | Project logo used in README and release branding. |
| `docs/public/logo-light.png`, `docs/public/logo-dark.png` | Derived from `logo.png` | Theme-aware website variants, generated programmatically (per-pixel: white background → transparent; dark variant additionally inverts the neutral wordmark and lifts brand colors for dark UI). No third-party artwork. |
| `hero.png`, `dvalin-scan-before.jpg`, `dvalin-scan-after.jpg` | Recorded from DvalinCode v0.14.1 | Unedited captures of the Dvalin workspace during one real run. The demo source is adapted from OWASP NodeGoat commit `c5cb68a7084e4ae7dcc60e6a98768720a81841e8`, Apache-2.0 licensed, with local stubs written for this project so the route loads and its tests execute. Contains no NodeGoat brand assets and no private data. The run: `builtin + semgrep + trivy + osv-scanner` reported **10 findings, 22/100 · F**; the model replaced the three `eval(req.body.*)` call sites with a constrained numeric parser and added one injection regression test; `npm test` went 2 → 3 passing; the re-scan reported **0 findings, 100/100 · A**. Every number was re-verified independently of the model's own report. |
| `dvalin-verify-local.jpg` | Recorded from the local DvalinCode app on 2026-08-26 | Unedited capture of a real `deepseek-v4-flash` Verify turn against the same local NodeGoat-derived demo. The model inspected all five files and ran the focused tests plus `run_security_suite`; the UI then consumed the deterministic server contract and displayed **complete** four-engine coverage, a passing gate, **0 findings, 100/100 · A**. Contains no API keys or private source. |
| `dvalin-remediation.gif` | Derived from the two captures above | Before/after animation of that same run, generated with ffmpeg from the unmodified PNGs. No frames are synthesized. |
| `modes.gif` | Recorded from DvalinCode v0.14.0 | Current Home → Code → Dvalin workspace walkthrough. |
| `docs/screenshots/10-claude-code-session.png` | Rendered from a real terminal capture, 2026-09-04 | **Not a raw screen capture.** The session was recorded with `script(1)` on Linux — Claude Code CLI 2.1.260 driving dvalincode 0.18.0 from source, with only `mcp__dvalin__dvalin_scan` allow-listed — and the recorded text was typeset to PNG in a headless browser because the capture host has no graphical terminal. ANSI codes were stripped; the command line and every line of output are otherwise verbatim, and the footer on the image says so. The lower pane restates the same command's `--output-format stream-json` fields (`mcp_servers`, `tool_use`, turn count), so the MCP call itself is visible rather than inferred from the model's prose. |

Tracked screenshots under `docs/screenshots/` and `poc/screenshots/` are product
captures created while testing DvalinCode workflows. They should not include
third-party logos, proprietary source code, private repositories, API keys, or
confidential customer data.

Do not add third-party brand assets, stock imagery, or externally generated
artwork unless the source, license, and permission terms are documented here.
