- The whole interface takes its colour from one pair of lines. No stylesheet
  carries a literal cyan any more: all 116 hardcoded `rgba(0, 212, 255, …)`
  values across 21 files now resolve from `--accent-rgb` in
  `src/ui/styles/foundation.css`, so retuning the app is editing two
  declarations. Track colours are untouched — each moving layer keeps its
  pinned hue in its own `policy.js` so two contacts never share a colour.
- The default accent is a softer instrument blue (`#64d2ff`) instead of fully
  saturated cyan, and the chrome surfaces are neutral graphite rather than
  blue-black, so the accent is the only colour in the panels. The theme colour,
  web manifest and generated icons follow.
- Plainer names for things that were named after the metaphor: the key panel is
  **API KEYS** with an **ADD KEYS** chip (was GROUND STATION · PROVIDER
  SETTINGS and POWER UP), the dock tray is **STYLES** holding a **CAMERA
  FILTER** row (was VISUAL PRESETS and VISUAL FILTER), the green-phosphor
  filter is **RETRO** (was CRT, which named the hardware rather than the look),
  and the label overlay is **DETECTION** (was DETECT). Spanish and Russian
  follow.
