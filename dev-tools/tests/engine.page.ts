// PanelRenderer in a real (software) WebGL context. Bundled as an IIFE and run in headless Chromium;
// exposes `runEngineTests()`. Every check measures pixels of the rendered image.

import { check, results, test } from '../lib/check';
import { box, ground } from '../lib/scene';
import { PRESETS, PanelRenderer, RenderStyle } from '../../src/panelRender';

const SIZE = 600;
/** Orthographic half-height the engine derives from the camera distance and the 45° field of view. */
const HALF = 120;
const DISTANCE = HALF / Math.tan((45 * Math.PI) / 360);
/** Top-down view centred on (0, CY). Screen up is +Y (north). */
const CY = 90;
const TOP_DOWN = {
    type: 'orthographic' as const,
    position: { x: 0, y: CY - 0.01, z: DISTANCE },
    target: { x: 0, y: CY, z: 0 },
};
const PERSPECTIVE = {
    type: 'perspective' as const,
    position: { x: 60, y: -90, z: 60 },
    target: { x: 0, y: 0, z: 12 },
};
const rowOfY = (y: number) => Math.floor(((CY + HALF - y) / (2 * HALF)) * SIZE);
const yOfRow = (row: number) => CY + HALF - ((row + 0.5) / SIZE) * 2 * HALF;
const COL_X0 = SIZE / 2;

const deg = (d: number) => (d * Math.PI) / 180;
/** Sun due south at `elevation` degrees (direction from the scene towards the sun). */
const southSun = (elevation: number): [number, number, number] => [0, -Math.cos(deg(elevation)), Math.sin(deg(elevation))];

const FLAT: RenderStyle = {
    ...PRESETS['Clay'],
    background: '#ffffff', buildingColour: '#ffffff', contextColour: '#ffffff', lineColour: '#ffffff',
    lineWeight: 0.01, silhouettes: false, depthWeight: 0, ambient: 0.3, sunIntensity: 1.5,
    shadows: true, shadowSoftness: 0, transparent: false, contextMode: 'shown',
};

const pixels = async (source: Blob | HTMLCanvasElement): Promise<ImageData> => {
    const image = source instanceof Blob ? await createImageBitmap(source) : source;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
};
const at = (img: ImageData, x: number, y: number) => {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
};
const lum = (img: ImageData, x: number, y: number) => {
    const p = at(img, x, y);
    return (p.r + p.g + p.b) / 3;
};

/** Length of the shadow north of the box along the centre column, plus the 10–90% transition width in rows. */
const measureShadow = (img: ImageData) => {
    const shadowValue = lum(img, COL_X0, rowOfY(8));
    const litValue = lum(img, COL_X0, rowOfY(-20));
    const mid = (shadowValue + litValue) / 2;
    let endRow = -1;
    for (let row = rowOfY(6); row >= 0; row--) {
        if (lum(img, COL_X0, row) > mid) { endRow = row; break; }
    }
    const lo = shadowValue + 0.1 * (litValue - shadowValue), hi = shadowValue + 0.9 * (litValue - shadowValue);
    let first = -1, last = -1;
    for (let row = rowOfY(6); row >= 0; row--) {
        const v = lum(img, COL_X0, row);
        if (first < 0 && v > lo) first = row;
        if (v > hi) { last = row; break; }
    }
    return { length: endRow < 0 ? NaN : yOfRow(endRow) - 5, shadowValue, litValue, penumbraRows: first - last };
};

const makeEngine = (buildings = [{ path: 'b', position: box(-5, -5, 0, 5, 5, 30) }], context: Float32Array | null = ground(0, 60, 400)) => {
    const canvas = document.createElement('canvas');
    canvas.style.width = `${SIZE}px`;
    document.body.appendChild(canvas);
    const engine = new PanelRenderer(canvas);
    engine.resize(SIZE, SIZE, 1);
    engine.setBuildings(buildings);
    engine.setContext(context);
    return engine;
};

const differ = (a: ImageData, b: ImageData) => {
    let max = 0, sum = 0, over2 = 0;
    for (let i = 0; i < a.data.length; i++) {
        const d = Math.abs(a.data[i] - b.data[i]);
        if (d > max) max = d;
        if (d > 2) over2++;
        sum += d;
    }
    return { max, mean: +(sum / a.data.length).toFixed(5), over2 };
};

export const runEngineTests = async () => {
    const engine = makeEngine();
    check('engine: WebGL context', true, engine.gpuInfo());

    await test('shadow length', async () => {
        engine.applyStyle(FLAT, new Map());
        engine.setView(TOP_DOWN, 45);
        for (const elevation of [45, 20, 10]) {
            engine.setSunDirection(southSun(elevation));
            engine.render();
            const m = measureShadow(await pixels(engine.renderer.domElement));
            const expected = 30 / Math.tan(deg(elevation));
            const ratio = m.length / expected;
            check(`shadow: length at ${elevation}° is 90–105% of height / tan(elevation)`, ratio > 0.9 && ratio < 1.05,
                { measured: +m.length.toFixed(1), expected: +expected.toFixed(1), ratio: +ratio.toFixed(3) });
        }
    });

    await test('soft shadows', async () => {
        engine.setSunDirection(southSun(20));
        engine.applyStyle({ ...FLAT, shadowSoftness: 0 }, new Map());
        check('soft: no soft preview while shadows are hard', engine.renderSoftPreview(8) === null);
        engine.render();
        const hard = measureShadow(await pixels(engine.renderer.domElement));

        engine.applyStyle({ ...FLAT, shadowSoftness: 4 }, new Map());
        let t = performance.now();
        const soft = measureShadow(await pixels(engine.renderSoftPreview(32)!));
        const softMs = Math.round(performance.now() - t);
        check('soft: 4° softness widens the shadow tip penumbra', soft.penumbraRows > hard.penumbraRows + 10,
            { hardRows: hard.penumbraRows, softRows: soft.penumbraRows, softMs });
        const expected = 30 / Math.tan(deg(20));
        check('soft: shadow keeps its length (half-shadow point)', Math.abs(soft.length / expected - 1) < 0.08,
            { measured: +soft.length.toFixed(1), expected: +expected.toFixed(1) });

        // Bands: the same frame drawn in 64-row bands must match the single-band frame.
        const single = await pixels(engine.renderSoftPreview(8)!);
        const saved = PanelRenderer.softBandPixels;
        PanelRenderer.softBandPixels = SIZE * 64;
        t = performance.now();
        let banded: ImageData;
        try {
            banded = await pixels(engine.renderSoftPreview(8)!);
        } finally {
            PanelRenderer.softBandPixels = saved;
        }
        // Rasterisation at band seams can move a few edge pixels by a few levels; anything more is a bug.
        const d = differ(single, banded);
        check('soft: banded render matches the single-band render', d.max <= 8 && d.over2 < single.data.length * 1e-4,
            { ...d, bandedMs: Math.round(performance.now() - t) });
    });

    await test('transparent export', async () => {
        engine.setView(PERSPECTIVE, 45);
        engine.setSunDirection(southSun(35));
        engine.applyStyle({ ...PRESETS['Clay'], transparent: true, contextMode: 'hidden', shadows: false }, new Map());
        const hidden = await pixels(await engine.exportPng(800));
        check('export: requested width, same aspect as the screen', hidden.width === 800 && hidden.height === 800,
            [hidden.width, hidden.height]);
        check('export: background is fully transparent', at(hidden, 2, 2).a === 0 && at(hidden, 797, 797).a === 0);
        check('export: the building is opaque', at(hidden, 400, 400).a === 255, at(hidden, 400, 400));

        engine.applyStyle({ ...PRESETS['Clay'], transparent: true, contextMode: 'shadows', shadows: true, shadowOpacity: 0.5 }, new Map());
        const shadows = await pixels(await engine.exportPng(800));
        let partial = 0, opaque = 0;
        for (let i = 3; i < shadows.data.length; i += 4) {
            if (shadows.data[i] > 0 && shadows.data[i] < 255) partial++;
            else if (shadows.data[i] === 255) opaque++;
        }
        check('export: shadows-only context gives half-transparent shadow pixels', partial > 2000, { partial, opaque });
        check('export: ground outside the shadow stays transparent', at(shadows, 2, 2).a === 0);
        check('export: screen size restored afterwards', engine.aspect === 1 && engine.renderer.domElement.width === SIZE);
    });

    await test('layered shadows', async () => {
        engine.setView(TOP_DOWN, 45);
        engine.applyStyle({ ...FLAT, transparent: false }, new Map());
        const suns: [number, number, number][] = [
            [Math.cos(deg(30)), 0, Math.sin(deg(30))], // from the east: shadow to the west
            [-Math.cos(deg(30)), 0, Math.sin(deg(30))], // from the west: shadow to the east
        ];
        const { base, masks } = engine.captureShadowLayers(SIZE, 2, (i) => engine.setSunDirection(suns[i]), 0);
        const b = await pixels(base);
        const [east, west] = await Promise.all(masks.map(pixels));
        const row = rowOfY(0);
        const westX = SIZE / 2 - 30, eastX = SIZE / 2 + 30; // 12 m either side of the box centre
        check('layers: base image has no shadows', Math.abs(lum(b, westX, row) - lum(b, eastX, row)) < 2);
        check('layers: sun from the east shades the west only', at(east, westX, row).a > 100 && at(east, eastX, row).a === 0,
            { west: at(east, westX, row).a, east: at(east, eastX, row).a });
        check('layers: sun from the west shades the east only', at(west, eastX, row).a > 100 && at(west, westX, row).a === 0);
        check('layers: no shadow drawn on the roof (buildings block the mask)', at(east, SIZE / 2, row).a === 0);

        // Without context, a ground catcher picks up the shadows instead.
        const bare = makeEngine(undefined, null);
        bare.applyStyle({ ...FLAT }, new Map());
        bare.setView(TOP_DOWN, 45);
        const noContext = bare.captureShadowLayers(SIZE, 1, () => bare.setSunDirection(southSun(20)), 0);
        const mask = await pixels(noContext.masks[0]);
        check('layers: shadows land on a flat ground when there is no context', at(mask, COL_X0, rowOfY(40)).a > 100);
        bare.dispose();
    });

    engine.dispose();
    return results;
};

(globalThis as any).runEngineTests = runEngineTests;
