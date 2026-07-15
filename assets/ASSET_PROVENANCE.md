# Asset Provenance

This directory contains DvalinCode-owned visual assets used in the README,
website, and release materials.

| Path | Provenance | Notes |
|---|---|---|
| `logo.png` | Created for DvalinCode | Project logo used in README and release branding. |
| `docs/public/logo-light.png`, `docs/public/logo-dark.png` | Derived from `logo.png` | Theme-aware website variants, generated programmatically (per-pixel: white background → transparent; dark variant additionally inverts the neutral wordmark and lifts brand colors for dark UI). No third-party artwork. |
| `dvalin-014-scan-before.png`, `dvalin-014-scan-after.png` | Recorded from DvalinCode v0.14.0 | Real local application captures from the Dvalin scanner workspace. The demo source is adapted from OWASP NodeGoat commit `c5cb68a7084e4ae7dcc60e6a98768720a81841e8`, Apache-2.0 licensed. It contains no NodeGoat brand assets or private data. |
| `dvalin-014-remediation.gif` | Derived from the real v0.14.0 captures above | Before/after animation of the same scan: 6 findings and 49/F before remediation; 0 findings and 100/A after three source fixes, one regression test, and a clean re-scan. |
| `dvalin-014-workspaces.gif` | Recorded from DvalinCode v0.14.0 | Current Home → Code → Dvalin workspace walkthrough. The versioned filename prevents stale README/CDN caches from showing pre-0.14 media. |

Tracked screenshots under `docs/screenshots/` and `poc/screenshots/` are product
captures created while testing DvalinCode workflows. They should not include
third-party logos, proprietary source code, private repositories, API keys, or
confidential customer data.

Do not add third-party brand assets, stock imagery, or externally generated
artwork unless the source, license, and permission terms are documented here.
