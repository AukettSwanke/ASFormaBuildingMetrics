// Renders a shadow study (several times on one sheet) or a layered shadow image (all the times in one
// picture) with the engine, and returns it as a canvas. No UI; the caller shows progress and errors.

import type { PanelRenderer, RenderStyle } from '../panelRender';
import { sunAngles, sunVector } from '../sunPosition';
import { formatClock, zonedToUtc } from '../timeZone';
import { composeSheet, planSheet, studyTimes } from '../studySheet';
import { LayerMode, composeLayered, planLayered } from '../layeredShadows';
import { FormaSun, StudyLayout, longDate, readableOn } from './shared';

export interface StudyOptions {
    day: { year: number; month: number; day: number };
    /** Minutes after midnight, project time. */
    from: number;
    to: number;
    count: number;
    layout: StudyLayout;
    /** Separate images: columns on the sheet and whether each tile is labelled. */
    columns: number;
    labels: boolean;
    /** Layered image: colour by time, or darker where shadow lasts longer. */
    layerMode: LayerMode;
    /** Width of the whole sheet in pixels. */
    width: number;
}

/**
 * Moves the engine's sun through the chosen times and draws the result. The engine's sun is left at the
 * last time drawn, so the caller must put it back. `note` reports times left out of a layered image.
 */
export const renderShadowStudy = (
    engine: PanelRenderer, sun: FormaSun & { location: [number, number] }, style: RenderStyle, o: StudyOptions,
): { sheet: HTMLCanvasElement; note: string | null } => {
    const [latitude, longitude] = sun.location;
    const times = studyTimes(o.from, o.to, o.count);
    const angles = times.map((m) => sunAngles(
        zonedToUtc({ ...o.day, hour: Math.floor(m / 60), minute: m % 60 }, sun.zone), latitude, longitude,
    ));
    const dateLabel = longDate(o.day);
    const background = style.transparent ? null : style.background;
    const textColour = style.transparent ? style.lineColour : readableOn(style.background);

    if (o.layout === 'layered') {
        // Only times with the sun up cast a shadow, so the others are left out.
        const up = times.map((_, i) => i).filter((i) => angles[i].elevation > 0);
        if (up.length === 0) throw new Error('The sun is below the horizon at every chosen time.');
        const note = up.length < times.length
            ? `${times.length - up.length} time(s) with the sun below the horizon were left out.` : null;
        const plan = planLayered(o.width, engine.aspect, true, up.length, o.layerMode);
        const reference = Math.floor((up.length - 1) / 2); // the buildings are lit as at the middle time
        const { base, masks } = engine.captureShadowLayers(
            plan.imageWidth, up.length, (i) => engine.setSunDirection(sunVector(angles[up[i]])), reference,
        );
        const sheet = composeLayered(base, masks, plan, {
            mode: o.layerMode,
            opacity: style.shadowOpacity,
            times: up.map((i) => formatClock(times[i])),
            background,
            textColour,
            title: `Layered shadows · ${dateLabel} · ${sun.zone}`,
            accumulateColour: '#101418',
        });
        return { sheet, note };
    }

    const plan = planSheet(o.width, o.columns, times.length, engine.aspect, o.labels, true);
    const frames = engine.captureSequence(plan.tileWidth, times.length, (i) => engine.setSunDirection(sunVector(angles[i])));
    const tiles = frames.map((canvas, i) => ({
        canvas,
        time: formatClock(times[i]),
        detail: angles[i].elevation > 0
            ? `azimuth ${angles[i].azimuth.toFixed(0)}° · elevation ${angles[i].elevation.toFixed(0)}°`
            : 'sun below the horizon',
    }));
    const sheet = composeSheet(tiles, plan, {
        title: `Shadow study · ${dateLabel} · ${sun.zone}`,
        labels: o.labels,
        background,
        textColour,
    });
    return { sheet, note: null };
};

export const canvasToPng = (canvas: HTMLCanvasElement): Promise<Blob> =>
    new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
