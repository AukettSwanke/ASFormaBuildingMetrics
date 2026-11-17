# Archived: the "Render (spike)" capture experiment

This folder holds the first experiment for the render feature. It is **not part of the build**:
`tsconfig.json` only includes `src/`, and nothing in `src/` imports it.

## What it did

A button in the panel captured the Forma view twice with `Forma.camera.capture`:

1. a normal "beauty" pass, and
2. an "ID" pass, after recolouring every building to its own flat colour with
   `Forma.render.elementColors.set` (the user's colours were restored afterwards).

It found the edges in the ID pass and drew them over the beauty pass (or on white), with a line
weight slider, an edge threshold, a line colour and a PNG download. It also reported the capture
sizes, timings and whether the flat colours had appeared in the capture.

## Why it was archived

It answered its question: capture works at export sizes and includes element colours, so a
two-pass render is possible. It was then replaced by the panel render engine
(`src/panelRender.ts`, `src/RenderEngine.tsx`), which draws the scene itself with three.js and so can
do what a capture cannot: crease and silhouette lines, depth-weighted line weights, lighting and
shadows, presets, transparent backgrounds, shadow studies and layered shadow images.

The one thing the capture approach has that the engine does not is Forma's *own* rendering: terrain
textures, materials and anything the panel cannot load as geometry. If that matters again, this is the
starting point.

## Files

- `renderSpike.ts`: pure image helpers (edge detection, line dilation, compositing, the per-building
  ID colours). No Forma calls.
- `RenderSpike.tsx`: the panel section (the two captures and the controls).

## Restoring it

1. Move both files back into `src/`:

   ```bash
   git mv archive/render-spike/RenderSpike.tsx src/RenderSpike.tsx
   git mv archive/render-spike/renderSpike.ts src/renderSpike.ts
   ```

2. In `src/index.tsx`, import the component:

   ```tsx
   import { RenderSpike } from "./RenderSpike";
   ```

3. Add the helper that puts the user's colours back after the ID pass, next to `colorBuildings` and
   `reset`:

   ```tsx
   // Put the scene back after a temporary recolour (used by the render spike's ID pass).
   const restoreColours = async () => {
       if (appliedMode) await colorBuildings();
       else await Promise.all([Forma.render.elementColors.clearAll(), Forma.render.cleanup()]);
   };
   ```

4. Render the section where you want it, for example above `<RenderEngine>`:

   ```tsx
   <RenderSpike
       buildingPaths={buildingData.map((b) => b.path)}
       restoreColours={restoreColours}
       disabled={isLoading || isColoring}
   />
   ```

It also stays in git history. On `main` it is in `src/` up to commit `38ae6c6` (the shadow softness
release); `git log --follow archive/render-spike/RenderSpike.tsx` shows its full history.
