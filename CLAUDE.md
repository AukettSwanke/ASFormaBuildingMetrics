# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an **Autodesk Forma embedded panel** — a Preact + Vite + TypeScript app that runs inside the Forma urban design tool as a side panel. It reads building geometry from the active Forma scene, computes metrics, applies per-building colour overlays, and has its own three.js renderer (the Render tab) that follows the Forma camera and exports presentation images and shadow studies.

Use British English in code comments, UI text and documentation.

## Commands

All commands run from the repository root:

```bash
npm run dev             # Dev server at http://localhost:5173/
npm run typecheck       # tsc --noEmit (app)
npm run build           # Type-check, then production build → dist/
npm run preview         # Preview production build at http://localhost:4173/
npm test                # Test harness: pure, engine, component and panel suites (needs Playwright, see below)
npm run typecheck:tests # Type-check the harness together with the app
node dev-tools/run.mjs shots   # Full-panel screenshots (light and dark) into dev-tools/.out/shots/
```

There is no linter. `npm run build` fails on TypeScript errors. Run `npm run typecheck`, `npm run build` and `npm test` before every commit.

**Deployment**: `.github/workflows/deploy.yml` builds every PR and deploys `main` to GitHub Pages. It does not run the test harness. `vite.config.ts` uses `base: './'` so the build works from the Pages sub-path.

## Test harness (`dev-tools/`)

See `dev-tools/README.md`. In short: `run.mjs` bundles test entries with esbuild, aliasing `forma-embedded-view-sdk/auto` to `dev-tools/stubs/forma.ts`, and runs them in node or headless Chromium with SwiftShader WebGL. Playwright is **not** a project dependency (`npm install --no-save playwright && npx playwright install chromium`; it is preinstalled in Claude Code cloud sessions).

- `pure` (node): sun position, time zones, silhouettes, presets, table parsing.
- `engine` (browser): `PanelRenderer` measured in pixels (shadow lengths, penumbrae, bands, transparency, export size, layered masks).
- `component` (browser): `<RenderEngine>` driven by Playwright locators.
- `panel` (browser): the whole panel — tabs, metrics workflow, render surviving tab switches, CSV export.
- `shots`: screenshots of every tab at 380 px wide, light and dark. Look at them after any UI change.

Rules: measure against expected values rather than eyeballing; prove a new check can fail by reintroducing the bug and restoring the file byte for byte; when UI wording or element ids change, update `dev-tools/tests/component.spec.mjs` and `panel.spec.mjs` in the same commit. The harness does not replace testing in Forma (synthetic boxes, software GPU, stub storage).

## Architecture

Three tabs (Metrics, Render, Data), no routing, no state library. The Render tab's UI lives in `src/render/`; everything else is directly under `src/`:

| File | Role |
|---|---|
| `index.tsx` (~1,330 lines) | The metrics panel and the app root: summary strip, tabs, Metrics and Data tabs. Mounts `<RenderEngine>` in the Render tab |
| `ui.tsx` | Shared presentational components: `Tabs`/`TabPanel`, `Segmented`, `Field`, `Legend`, `Spinner`, and `preference` (per-viewer `localStorage`, wrapped in try/catch because Forma's iframe may block it) |
| `categories.ts` | User-defined category model and project storage. Also exports `readJson` / `writeJson` (writes queued per key), reused by presets |
| `table.ts` | Export table and CSV import (pure) |
| `envelope.ts` | Context-envelope geometry and GLB encoder (pure) |
| `render/` | The Render tab's UI, split by section (see *Render tab* below). Imports three.js lazily on first *Load scene* |
| `panelRender.ts` (~800 lines) | `PanelRenderer` class, built-in `PRESETS`, the `RenderStyle` type, all rendering and export logic |
| `silhouette.ts` | Pure. Hard edges (always drawn) and smooth edges (drawn only as silhouettes for the current view) |
| `sunPosition.ts` | Pure NOAA solar position; `sunVector` gives a Forma-space direction (X east, Y north, Z up) |
| `timeZone.ts` | Pure Intl-based clock time ↔ UTC (DST safe), plus a solar-time fallback zone |
| `presets.ts` / `presetStorage.ts` | Saved render presets: pure model, validation and JSON file format / project storage (`render-presets.json`) |
| `studySheet.ts` | Canvas only. Grid sheet of several times (shadow study) |
| `layeredShadows.ts` | Canvas only. One image with the shadows from several times layered on the ground |
| `style.css` | Design tokens as CSS custom properties, light and dark, no framework |

`archive/render-spike/` holds the retired two-pass capture experiment with a README and restore steps. It is not built (tsconfig only includes `src/`).

**Forma SDK integration** (`forma-embedded-view-sdk/auto`):
- `Forma.geometry.getPathsByCategory({ category: "building" })` — enumerate building paths in the scene
- `Forma.geometry.getTriangles({ path })` — raw vertex positions as a flat `Float32Array` (every 9 floats = one triangle, XYZ per vertex). `getTriangles({ excludedPaths: buildingPaths })` gives the render's context (terrain, trees, other elements) as one mesh
- `Forma.geometry.getFootprint({ path })` — 2D polygon coordinates for footprint area
- `Forma.selection.getSelection()` — scene selection (read-only; the SDK has no `setSelection`)
- `Forma.camera.move({ position, target })` — row click frames the building
- `Forma.camera.getCurrent()` / `subscribe()` — the render follows the Forma camera; `camera.capture({ width, height })` — *Compare with Forma* overlay
- `Forma.sun.getDate()` / `setDate({ date })`, `Forma.project.getGeoLocation()` (`[lat, lon]`) and `getTimezone()` — sun direction and the project time zone
- `Forma.render.elementColors.set({ pathsToColor })` / `.clearAll()` — one hex colour per building (all modes except Façade (Mixed))
- `Forma.render.updateMesh({ id, geometryData: { position, color } })` — per-face overlay mesh, used only for Façade (Mixed) (RGBA `Uint8Array`, 4 bytes × 3 vertices per triangle)
- `Forma.render.cleanup()` — remove custom colour overlays
- `Forma.extensions.storage.getTextObject` / `setObject` — project-scoped storage: `categories.json` (definitions, project-wide), `assignments-<proposalId>.json` (categoryId → building path → valueId) and `render-presets.json` (saved render presets, project-wide). Writes to one key are queued so they land in order
- `Forma.udm.getRootUrn()` — proposal identity; its last segment is a revision that changes on every edit, so `getProposalId` keeps only the `<id>` segment
- `Forma.integrateElements.uploadFile` / `createElementV2` + `Forma.elements.add` — Context Envelope: a stack of height bands is built from the selected buildings' mesh (each band is the convex hull, offset by a margin, of the geometry reaching above its base, so setbacks and lower blocks are followed; roofs under 4 m² or within 1.5 m of each other do not create steps), then encoded as a GLB, uploaded, created as a `virtual: true` element (analyses ignore it) with a `volumeMesh` representation, and added to the proposal (persists; needs edit access). *Remove all* finds them by `category: context-envelope` via `geometry.getPathsByCategory` and calls `elements.remove` on each. Red is set in the GLB material and also via `elementColors.set` because Forma may drop GLB materials. `GLB_Y_UP` in `envelope.ts` switches the axis conversion
- `Forma.getCanEdit()` — category editing, import and saved-preset editing are hidden for view-only users (they can still apply presets and export)

**Key derived metrics** (computed client-side, no backend):
- Height = maxZ − minZ from triangle vertices
- Footprint area = Shoelace formula on `getFootprint` coordinates
- Volume = height × footprint area
- Floor count = `round(height / 3.5)`
- GFA, site area, coverage and FAR are deliberately not calculated: Forma's Area Metrics panel already provides them
- Facade orientation = surface normal of each triangle projected onto the XY plane

**State flow**: One `useEffect` fetches building geometry on mount; a second loads categories and assignments from project storage. Category edits update state and save immediately. *Apply colours* colours every building, with no Forma selection needed; when the category being shown is edited after colours were applied, they re-apply automatically. Only category assignment reads the Forma selection (a selected child element counts as its building). `panelColours` (memoised Map of building path → hex for the current colour mode) is passed to `<RenderEngine>` for the *Panel colours* preset.

**UI structure** (`index.tsx`):
- `SummaryStrip` — always-visible aggregate stats (building count, avg height, max height, total façade area), then a sticky `Tabs` bar. The active tab is remembered per viewer (`preference`)
- **All three tab panels stay mounted** and inactive ones are `hidden`, so the render keeps its loaded scene; never render a tab's children conditionally (the `panel` suite checks this)
- Metrics tab: `BuildingList` with a column header and `SortControls` (each building has a stable `number` in load order, shown as "#3" / "Building 3"; rows are keyboard focusable), `BuildingDetail` for the selected building; *Colour buildings* with a *Colour by* select (measured modes, then one option per category, ColorMode `category:<id>`), a `Legend` built from the same colour functions the buildings use, *Apply colours* / *Clear colours*, and *Add a category* in a disclosure; `CategoryPanel` for the active category; Context envelope (editors only)
- Render tab: `<RenderEngine>` — empty state with *Load scene*, then preview with a toolbar (frame, *Compare with Forma*, *Reload*), Look (presets, saved presets, Lines, Colours, Light and shadow), Sun, Export (Image or Shadow study, each with one primary button) and Scene details
- Data tab: Export, then Import categories (editors only)
- UI copy: British English, sentence case for headings and buttons, one primary (filled) button per section, short help text under the control it explains
- Export: `buildExportRows` → `toCsv` (download via Blob, with a UTF-8 BOM for Excel) or `toTsv` (clipboard, with an `execCommand` fallback because the Clipboard API is often blocked in iframes). The last column, `Forma ID`, is the building path
- Import (`table.ts`): `decodeText` (UTF-8, falling back to Windows-1252 for Excel's plain CSV) → `parseTable` (comma, semicolon or tab, detected from the header) → `planImport`, which matches rows by `Forma ID`, ignores the measured columns, matches categories and values by name case-insensitively, creates unknown ones, and treats a blank cell as unassigned. `ImportPreview` shows the plan; nothing changes until Apply. The plan is recomputed against current state, and import is hidden for view-only users

## Render tab (panel engine)

`PanelRenderer` (`panelRender.ts`) owns the three.js scene; the UI in `src/render/` drives it. Flow: *Load scene* → lazy `import('../panelRender')` → fetch building triangles per path and (optionally) the context mesh → subscribe to the Forma camera → every camera event calls `setView` + `render`. Style edits go through `applyStyle(style, panelColours)`.

Files in `src/render/`:

| File | Role |
|---|---|
| `RenderEngine.tsx` | Orchestrator. Holds the shared state (style, chosen preset, frame, busy and status, overlay) and `runTask`, which marks the panel busy, shows progress and reports failures. Wires the hooks to the sections |
| `useSceneEngine.ts` | The engine's life: lazy import and creation, `loadGeometry`, `followCamera`, `redraw`, the resize observer, style pushes and the soft-shadow preview. The only place that imports `../panelRender` as a value |
| `useSun.ts` | Forma's sun, project location and time zone; follow-Forma or custom date and time; lights the scene; *Set Forma's sun*; `restore()` after a study moves the sun |
| `useSavedPresets.ts` | Saved presets: load from project storage, save, update, two-click delete, file export and import |
| `shadowStudy.ts` | `renderShadowStudy`: draws a study sheet or a layered image with the engine (no UI) |
| `Preview.tsx` | Canvas, soft-preview and overlay layers, toolbar. Always mounted, hidden until loaded, because the engine draws into its canvas |
| `LookSection.tsx` / `SavedPresets.tsx` | Look: presets, saved presets, lines, colours, light and shadow |
| `SunSection.tsx` | Sun section, and `QuickDates` (equinox and solstice buttons) |
| `ExportSection.tsx` | Image or shadow study: export settings, the study's own settings and its last result |
| `SceneDetails.tsx` | `LoadPrompt` (before loading) and Scene details (after) |
| `shared.ts` | Constants (`FOV`, `ASPECTS`, `STUDY_DATES`, export widths), types and small helpers. Type-only imports from the engine |

Keep value imports of `panelRender` inside `useSceneEngine.ts`; anywhere else, use `import type`, or three.js is pulled into the main bundle (check that the build still emits a separate `panelRender-*.js` chunk).

Features: presets (Line drawing, Clay, Panel colours, Night, plus saved presets with JSON file export/import); edge line weight 0.05–8 px (number box 0.01–20); silhouettes with their own weight; depth-weighted line width (`DepthLineMaterial`, a patched `LineMaterial` that warns and falls back if the three.js shader text changes); sun and ambient strength; shadows and shadow softness; transparent background with context shown, shadows-only or hidden; Sun section (follow Forma, or a date and time in the project time zone, and *Set Forma's sun to this*); Shadow study (separate images on a labelled sheet, or one layered image coloured by time or accumulated as hours in shadow); *Compare with Forma*; PNG export 1280–5120 px wide.

### Decisions and gotchas

- **Space and camera**: Forma space is metres, Z up, X east, Y north. The field of view is fixed at 45°. Both were confirmed against Forma by the user (overlay lines up; sun and shadow direction match). Orthographic view size is approximated from the field of view and camera distance (not verified against Forma).
- **three.js r187**: `PCFSoftShadowMap` no longer exists, and the built-in PCF blur takes only 5 samples, which is visibly grainy at useful widths. Softness is therefore the sun's apparent diameter (0–10°, the real sun is ~0.5°), made by averaging renders with the sun jittered over its disk (`renderAveraged`, sunflower pattern). The average is kept in **floating point**: an 8-bit running mean measurably lost later samples. On screen, the plain render shows while the camera moves and the averaged image (16 samples) is laid over it after 350 ms still; exports and studies use 32 samples.
- **Bands**: large averaged frames are drawn in horizontal bands using the camera view offset, so memory stays bounded (`PanelRenderer.softBandPixels`, static so tests can shrink it). Bands only apply at a pixel ratio of 1 (exports).
- **Shadow camera fit**: fitted to the buildings **plus the ground their shadows reach**, capped at `min(max(12 × building radius, 300), 1500)` m (`shadowCap`). Fitting to the buildings alone clipped low-sun shadows (55% of true length at 20°, 16% at 6°). The ground catcher used by the layered image when there is no context is sized from the same cap. The shadow map is 2048² across the fitted area, so very large sites get coarser shadows (untested at city scale).
- **Export size**: `resize()` keeps the requested, unrounded aspect ratio (`frameAspect`), and exports, studies and layered images are drawn at `width / frameAspect` through `useExportSize`, which restores the screen size afterwards. Using the rounded on-screen pixel size gave 2560 × 1441 for 16:9.
- **Presets store the look only** (`LookStyle`). Transparent background, context mode and shadow strength (`shadowOpacity`) belong to the export and survive a preset change (`withLook`). Stored and imported data is validated and clamped in `presets.ts`; older saved presets have no `shadowSoftness`, which means hard. Imports never replace existing presets (clashes become "Name (2)").
- **Silhouettes**: edges between faces within 20° of each other are smooth and drawn only where one face points at the camera and the other away. The result does not depend on which way the triangles are wound, only on the winding being *consistent* (tested). Mixed winding turns the affected smooth edges into hard edges, i.e. extra lines. Not yet checked on real Forma meshes (including buildings made of child elements).
- **Sun**: `sunAngles` uses NOAA's low-precision algorithm (no refraction). The sun fades out between 0° and 6° elevation, so there is no sun light or shadow at night. Project time zone comes from `getTimezone()`, falling back to an `Etc/GMT±n` zone from longitude. `zonedToUtc` resolves a skipped clock time to just after the change and a repeated one to its first occurrence.
- **Layered image**: one base render with no shadows (lit as the middle time), then one shadow-only mask per time in which buildings are invisible depth blockers (`enterMaskPass`). Shadows land on the context when shown, otherwise on a flat catcher. Ground only: shadows on other buildings' walls and roofs are not drawn. Times with the sun down are left out and reported.
- **Not yet verified in real Forma** (as of `5839951`): saved presets persisting and shared with colleagues; thin line weights; silhouettes on real meshes; transparent export; time-of-day sun and project time zone; shadow study and layered image on real terrain; soft-shadow and export timings on a real GPU (all timings so far are from software rendering); heavy context meshes; shadow sharpness on very large sites; orthographic view size.

## Constraints and working practice

- The app cannot be meaningfully tested in a standalone browser: `Forma.*` calls fail without the Forma host. Use the harness for checks you can automate, then load the dev server URL (or the Pages URL) in Forma's embedded view for the real test.
- Treat outputs as draft assistance for review by a suitably qualified professional; never describe anything as verified, approved or compliant unless it has been tested, and say how.
- Never open or merge a pull request without the user's explicit yes. Branches are squash-merged, so merge `origin/main` into the working branch (a plain merge, not a rebase) before opening a PR. Force-pushes are blocked; do not work around that.
- After any edit made in a shell command that might fail, grep to confirm it landed.
