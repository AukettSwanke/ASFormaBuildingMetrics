# Test harness

Runs the panel outside Forma against a stub of the Forma SDK, so changes can be checked before they
are loaded into Forma. It is **not a substitute for testing in Forma**: the stub returns simple boxes
and a flat ground, and the renderer runs on software WebGL (SwiftShader), so real meshes, a real GPU,
real project storage and Forma's own behaviour are not covered.

## Running it

Needs Node.js 20+, `npm install`, and Playwright with Chromium (not a project dependency, so CI and
production installs stay lean):

```bash
npm install --no-save playwright && npx playwright install chromium
```

Then, from the repository root:

```bash
npm test                              # all suites: pure, engine, component, panel
node dev-tools/run.mjs pure           # one or more named suites
node dev-tools/run.mjs shots          # screenshots of the whole panel, light and dark
npm run typecheck:tests               # type-check the harness and the app together
```

The runner prints every check with its measured values and exits non-zero if any fail. Bundles,
screenshots and a run stamp go to `dev-tools/.out/` (git-ignored).

## Suites

| Suite | Runs in | What it covers |
|---|---|---|
| `pure` | node | `sunPosition`, `timeZone` (incl. clock changes in both hemispheres), `silhouette`, `presets`, `studySheet.studyTimes`, `table` parsing, `transfer` (matching and site offset, categories, function mapping, floor functions copied between storeys, floor-stack winding) |
| `engine` | headless Chromium, SwiftShader WebGL | `PanelRenderer` measured in pixels: shadow length against `height / tan(elevation)` at 45°, 20° and 10°; soft-shadow penumbra and length; banded versus single-band averaging; transparent export alpha; export size and aspect; layered shadow masks with and without context |
| `component` | headless Chromium | `<RenderEngine>` driven like a user: load, presets keeping export settings, saved presets (storage, reload, duplicate names, view-only users), soft preview, sun modes and *Set Forma's sun*, shadow study and layered image downloads, PNG export size, project with no location |
| `panel` | headless Chromium | The whole panel (`src/index.tsx`): tabs and keyboard navigation, building list and camera move, colour by / apply / clear, the render keeping its loaded scene across tab switches, CSV download, project transfer (export from one stub project, import into another offset by 7 m × 3 m with a building missing; also saves `shots/panel-transfer-preview.png`) |
| `shots` | headless Chromium | Not a test. Full-page PNGs of the whole panel at 380 px wide, light and dark: Metrics (also with a building selected and a category open), Render (loaded, and with the shadow-study export and custom sun open) and Data |

## Files

- `run.mjs`: bundles each entry with esbuild (the SDK import is aliased to the stub), launches
  Chromium with `--use-gl=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, and reports.
- `stubs/forma.ts`: the Forma stand-in. Scene and project settings live on `globalThis.__formaScene`,
  storage on `globalThis.__storage` (survives unmount and remount), calls that change Forma are logged on
  `globalThis.__formaCalls`, and `globalThis.__moveCamera(state)` plays a camera move to subscribers.
  Default scene: three boxes in London (`Europe/London`), sun at 12:00 UTC on 21 June 2026, built-in building
  functions only and no floor data. `scene.floors[path]` gives a building a `graphBuilding` made of rectangles
  (`graphOf` in `lib/scene.ts`). A page can start with its own scene and storage: the panel suite's
  `openPage({ scene, storage })` sets them before the stub loads (missing scene fields take the defaults).
- `lib/scene.ts`: outward-wound boxes, prisms and ground quads. `lib/check.ts`: `check`, `near`, `test`.
- `tests/*.test.ts` run in node; `tests/*.page.ts(x)` are browser entries; `tests/*.spec.mjs` drive
  pages from node with Playwright.

## Writing checks

- Measure, don't eyeball: compare pixels or numbers against an expected value worked out from
  geometry, and put the measured value in `detail` so the log shows it.
- Prove a new check can fail: reintroduce the bug (or break the code), confirm the check fails, then
  restore the file byte for byte (`cp` a backup and `cmp` it).
- Locators: prefer labels, roles and visible text (`exact: true` for short button names, since
  Playwright matches substrings); use element ids (`#re-soft`, `#re-context`, `#colour-mode`) where that
  is clearer. Choices made with the `Segmented` control are buttons with `aria-pressed`. The soft preview
  canvas has `data-role="soft-shadow-preview"`. If you change UI wording or ids, update the specs in the
  same commit.
- Pages run with locale `en-GB` and time zone `Europe/London`. Native date and time inputs still follow
  the browser's own language, so screenshots may show US formats; in Forma they follow each user's browser.
- Range inputs: set them with the `setInput` helper, which fires the `input` event Preact listens for.
- Read UI text with `waitFor`, not `isVisible`: effects update text after the click resolves.
