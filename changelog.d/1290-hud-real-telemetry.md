- The Intel HUD no longer prints invented sensor metadata. The session-random
  `KH11-…` mission, `OPS-…` sensor, orbit and pass identifiers and the fixed
  `BAND`/`BITS`/`LVL` strip are replaced by values the application can observe:
  the active map stack and whether terrain relief is applied (`SRC:`,
  `PROJ: WGS84`, `TERR:`), the optics the GSD/NIIRS/ONA figures are derived
  from, and a live feed-freshness readout (`FEEDS: 1/2 LIVE · OLDEST 45s`)
  built from the same feed states the control chips use — only a nominal feed
  counts as live, so a stale, simulated or fallback feed is visibly not. The
  banner reads `OPEN SOURCE // PUBLIC DATA // UNCLASSIFIED`. `ALT` switches to
  kilometres above 10 km instead of printing an eight-digit metre count, and
  `NIIRS` reads `--` where the GIQE scale does not apply rather than clamping
  to a printed `0.0`.
- `npm run doctor` now names the cost tier and the issuing page for every
  provider it reports as unconfigured, and a not-ready checkout gets a numbered
  list of what to fix instead of a bare verdict. No credential is ever listed
  as blocking startup, because none is.
