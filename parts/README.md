# parts/ — settled implementation (integrate, do not re-derive)

These files are the production build of the working implementation of
the original app 「我が家のディズニー計画」, generated on 2026-11-21 from
the original's current source (its development build) by applying the
production-variant definition of distribution record BV: the
development-only parts (the debug tab and its actions and tables, the
task-manager tab screen, and the debug-run door inside the chat action)
are removed, the debug-only migrations are emptied in place so the chain
keeps its numbering, and migration 0018 registers no wait-time sources.
Everything else is the original's code byte for byte — including the
task-management class (inside actions.ts, wired), the acquisition plan
layer, and the run logging. They are the settled parts of the product:
the parts whose behaviour was designed, built and verified once, and
which a rebuilt copy should INTEGRATE as-is instead of re-implementing
from the prose of SPEC.md. Where the spec's prose and this code disagree
about a settled part's behaviour, the code is what the original actually
does — flag the disagreement rather than silently rewriting the part.

Layout mirrors the original project:

- `client/src/map_helpers.mjs` — **the map layer.** The virtual map library:
  one facade (`mountPlaceListMap`) over the platform map implementation and
  the Leaflet implementation, with environment probing, fatal-error cascade
  to Leaflet, the static-image fallback, tile sources (GSI standard /
  Esri World Imagery), pin-tap hit-testing by coordinates, and selection
  highlight. This layer was the #1 defect source when recipients
  re-implemented it from prose — integrate it whole.
- `client/src/App.tsx` — the whole client: tab shell, TAB2 conditions form,
  plan display (summary header, schedule rows, pin numbering), dialogs
  (day-before, lottery/DPA reschedule), progress/stall UI, PDF preview.
- `client/src/pdf.ts` — PDF generation for a plan (stat grid, static map,
  footer). `client/src/plan_metrics.ts` — plan summary computations.
  `client/src/api.ts`, `client/src/main.tsx`, `client/src/theme.css`,
  `client/src/globals.d.ts` — client plumbing and styling.
- `client/index.html`, `client/build.mjs` — the client entry and build.
- `server/src/actions.ts` — all server actions in one file, including the
  deterministic logic: save-time gates, travel-time computation, the §10
  coordinate ladder and save-time re-resolution, the parkwide
  representative-point replacement, the normalized-fact layer, the
  task-management class, the acquisition plan layer and the run logging.
  Copy whole; do not split.
- `server/src/schema.ts` — the data model. `drizzle/` — its SQL migrations
  (the schema as actually evolved, 0001–0052; 0018 and 0039–0044 are
  emptied no-ops in this production build, see above).
- `package.json` — the dependency manifest (`@hatch/space-sdk` is supplied
  by the platform; the rest are ordinary packages).

Deliberately NOT included: the third-party / platform library bundles the
client loads — `hatch-maps.js` + `hatch-maps.css` (the platform's MapLibre
runtime), `leaflet.js` + `leaflet.css` and `client/src/images/` (Leaflet
1.9.4 and its default marker images). They are commodity bundles,
re-obtained from the platform / the Leaflet distribution at build time,
not this app's own settled code.

Settled DATA lives alongside in `../data/` (facility coordinates and area
points as JSON). What is NOT here, by design: everything the spec keeps as
text — the acquisition and generation method, the estimation premises,
the conversation conduct, and the test spec (§28). Those are the AI layer
the receiving Muse supplies; these parts are the blueprint it builds on.
