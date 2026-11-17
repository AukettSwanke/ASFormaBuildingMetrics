import { Forma } from 'forma-embedded-view-sdk/auto';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ContextMode, PanelRenderer, RenderStyle } from './panelRender';
import { sunAngles, sunVector } from './sunPosition';
import { fallbackZone, formatClock, isoDate, parseIsoDate, utcToZoned, zonedToUtc } from './timeZone';
import { composeSheet, planSheet, studyTimes } from './studySheet';
import { LayerMode, composeLayered, planLayered } from './layeredShadows';
import { newId } from './categories';
import {
    LookStyle, MAX_NAME_LENGTH, MAX_PRESETS, SavedPreset, cleanName, mergeImported, nameTaken, parsePresetFile,
    serialisePresets, toLook, withLook,
} from './presets';
import { loadRenderPresets, saveRenderPresets } from './presetStorage';
import { Field, Segmented, Spinner } from './ui';

type SunMode = 'forma' | 'custom';
type OutputKind = 'image' | 'study';

/** "21 Jun 2026" for a date in the project time zone. */
const longDate = (z: { year: number; month: number; day: number }): string =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(Date.UTC(z.year, z.month - 1, z.day)));

interface SceneInfo {
    buildingTriangles: number;
    contextTriangles: number;
    lineSegments: number;
    buildingMs: number;
    contextMs: number;
    gpu: string;
}
/** Black or near-white text, whichever reads better on a sheet of the given background colour. */
const readableOn = (hex: string): string => {
    const n = parseInt(hex.replace('#', ''), 16);
    const luma = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return luma > 0.55 ? '#222222' : '#f2f2f2';
};

/** Standard planning dates for shadow studies (equinoxes and solstices, rounded to the 21st). */
const STUDY_DATES: [string, string][] = [['21 Mar', '03-21'], ['21 Jun', '06-21'], ['21 Sep', '09-21'], ['21 Dec', '12-21']];

/** Forma's camera field of view; confirmed by overlaying Forma's own capture. */
const FOV = 45;

const ASPECTS: Record<string, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1 };
type Presets = Record<string, RenderStyle>;

const targetOf = (e: Event) => e.target as HTMLInputElement;

/** Checkerboard shown behind the canvas while the background is transparent. */
const CHECKERBOARD = 'repeating-conic-gradient(#d8d8d8 0% 25%, #ffffff 0% 50%) 50% / 16px 16px';

/**
 * Draws the Forma scene with our own three.js renderer in the panel, and exports it: lines, lighting,
 * presets, transparent backgrounds, shadow studies and layered shadow images.
 * three.js is imported on first use so it does not weigh down the rest of the panel.
 */
export function RenderEngine({ buildingPaths, panelColours, canEdit, disabled }: {
    buildingPaths: string[];
    /** False for view-only users, who can apply saved presets but not change them. */
    canEdit: boolean;
    /** Colour currently shown for each building by the panel's colour mode (memoised by the caller). */
    panelColours: Map<string, string>;
    disabled: boolean;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const host = useRef<HTMLDivElement>(null);
    const engine = useRef<PanelRenderer | null>(null);
    const presetsRef = useRef<Presets | null>(null);
    const unsubscribe = useRef<(() => void) | null>(null);
    /** What Forma last reported about the sun and the project, read by readSun. */
    const formaSun = useRef<{ date: Date; location: [number, number] | null; zone: string } | null>(null);

    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [withContext, setWithContext] = useState(true);
    const [status, setStatus] = useState<string | null>(null);
    const [info, setInfo] = useState<SceneInfo | null>(null);
    const [outputKind, setOutputKind] = useState<OutputKind>('image');
    const [aspect, setAspect] = useState('16:9');
    const [presetName, setPresetName] = useState('Clay');

    // Saved presets (stored in the Forma project, shared by everyone working on it).
    const [saved, setSaved] = useState<SavedPreset[]>([]);
    const [newPresetName, setNewPresetName] = useState('');
    const [presetMessage, setPresetMessage] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const presetFile = useRef<HTMLInputElement>(null);

    // Soft shadows are drawn by averaging many renders, which is too slow while the camera moves. The plain
    // render shows during interaction; once the view has been still for a moment, the averaged image is
    // laid over it.
    const [softCanvas, setSoftCanvas] = useState<HTMLCanvasElement | null>(null);
    const softHost = useRef<HTMLDivElement>(null);
    const softTimer = useRef<number | undefined>(undefined);
    const scheduleSoftRef = useRef<() => void>(() => undefined);
    const [style, setStyle] = useState<RenderStyle | null>(null);
    const [overlay, setOverlay] = useState<string | null>(null);
    const [overlayOpacity, setOverlayOpacity] = useState(0.5);
    const [exportWidth, setExportWidth] = useState(2560);
    const [sunText, setSunText] = useState<string | null>(null);
    const [sunMode, setSunMode] = useState<SunMode>('forma');
    const [customDate, setCustomDate] = useState('2026-06-21');
    const [customMinutes, setCustomMinutes] = useState(12 * 60);
    /** Bumped whenever Forma's sun is re-read, so the sun effect runs again. */
    const [sunTick, setSunTick] = useState(0);

    // Shadow study: several times on one date, laid out on a single sheet.
    const [studyDate, setStudyDate] = useState('2026-12-21');
    const [studyFrom, setStudyFrom] = useState(9 * 60);
    const [studyTo, setStudyTo] = useState(15 * 60);
    const [studyCount, setStudyCount] = useState(3);
    const [studyColumns, setStudyColumns] = useState(3);
    const [studyLabels, setStudyLabels] = useState(true);
    /** Separate images on a sheet, or all the times layered into one image. */
    const [studyLayout, setStudyLayout] = useState<'separate' | 'layered'>('separate');
    const [layerMode, setLayerMode] = useState<LayerMode>('time');
    const [study, setStudy] = useState<{ url: string; name: string } | null>(null);
    const studySeeded = useRef(false);
    const studyUrl = useRef<string | null>(null);

    const lastCamera = useRef<Parameters<PanelRenderer['setView']>[0] | null>(null);

    const redraw = () => {
        const e = engine.current, el = host.current;
        if (!e || !el) return;
        e.resize(el.clientWidth, el.clientWidth / ASPECTS[aspect], Math.min(window.devicePixelRatio || 1, 2));
        e.render();
        scheduleSoftRef.current();
    };

    /** Hides the soft image at once (the view just changed) and draws a fresh one after a short pause. */
    const scheduleSoft = () => {
        window.clearTimeout(softTimer.current);
        setSoftCanvas(null);
        softTimer.current = window.setTimeout(() => {
            const e = engine.current;
            if (e) setSoftCanvas(e.renderSoftPreview(16));
        }, 350);
    };
    scheduleSoftRef.current = scheduleSoft;

    useEffect(() => {
        const el = softHost.current;
        if (!el) return;
        if (!softCanvas) { el.replaceChildren(); return; }
        softCanvas.style.cssText = 'display:block;width:100%;height:100%';
        softCanvas.dataset.role = 'soft-shadow-preview';
        el.replaceChildren(softCanvas);
    }, [softCanvas]);

    // Style, aspect, FOV and sun rotation changes: push to the engine and redraw.
    useEffect(() => {
        const e = engine.current;
        if (!e || !loaded || !style) return;
        e.applyStyle(style, panelColours);
        e.setView(lastCamera.current!, FOV);
        redraw();
    }, [style, panelColours, aspect, loaded]);

    useEffect(() => {
        const el = host.current;
        if (!el || !loaded) return;
        const observer = new ResizeObserver(redraw);
        observer.observe(el);
        return () => observer.disconnect();
    }, [loaded, aspect]);

    useEffect(() => {
        loadRenderPresets()
            .then(setSaved)
            .catch((error) => {
                console.error(error);
                setPresetMessage('Saved presets could not be loaded from the Forma project.');
            });
    }, []);

    useEffect(() => () => {
        if (studyUrl.current) URL.revokeObjectURL(studyUrl.current);
        window.clearTimeout(softTimer.current);
        unsubscribe.current?.();
        engine.current?.dispose();
        engine.current = null;
    }, []);

    const readSun = async () => {
        const [date, location, timezone] = await Promise.all([
            Forma.sun.getDate(), Forma.project.getGeoLocation(), Forma.project.getTimezone(),
        ]);
        formaSun.current = {
            date,
            location: location ?? null,
            zone: timezone ?? (location ? fallbackZone(location[1]) : 'UTC'),
        };
        if (!studySeeded.current) {
            // Start the study on Forma's current date, in the project's time zone.
            studySeeded.current = true;
            setStudyDate(isoDate(utcToZoned(date, formaSun.current.zone)));
        }
        setSunTick((n) => n + 1);
    };

    /** The instant the panel should light the scene for, in the chosen mode. */
    const sunInstant = (): Date | null => {
        const info = formaSun.current;
        if (!info) return null;
        if (sunMode === 'forma') return info.date;
        const day = parseIsoDate(customDate);
        if (!day) return null;
        return zonedToUtc({ ...day, hour: Math.floor(customMinutes / 60), minute: customMinutes % 60 }, info.zone);
    };

    // Light the scene for the chosen moment whenever the mode, date, time or Forma's sun changes.
    useEffect(() => {
        const e = engine.current, info = formaSun.current;
        if (!e || !loaded || !info) return;
        if (!info.location) { setSunText('The project has no location, so the sun direction is a default.'); return; }
        const date = sunInstant();
        if (!date) return;
        const angles = sunAngles(date, info.location[0], info.location[1]);
        e.setSunDirection(sunVector(angles));
        const z = utcToZoned(date, info.zone);
        setSunText(
            `${longDate(z)}, ${formatClock(z.hour * 60 + z.minute)} (${info.zone}) · `
            + (angles.elevation > 0
                ? `azimuth ${angles.azimuth.toFixed(0)}°, elevation ${angles.elevation.toFixed(1)}°`
                : 'sun below the horizon'),
        );
        redraw();
    }, [loaded, sunMode, customDate, customMinutes, sunTick]);

    const chooseSunMode = (mode: SunMode) => {
        if (mode === 'custom' && formaSun.current) {
            // Start from where Forma's sun is now, so the slider begins at the current view.
            const z = utcToZoned(formaSun.current.date, formaSun.current.zone);
            setCustomDate(isoDate(z));
            setCustomMinutes(Math.min(1430, Math.round((z.hour * 60 + z.minute) / 10) * 10));
        }
        setSunMode(mode);
    };

    const chooseStudyDate = (monthDay: string) => setCustomDate(`${customDate.slice(0, 4)}-${monthDay}`);

    /** Moves Forma's own sun to the chosen moment, so the Forma view matches the panel. */
    const applyToForma = async () => {
        const date = sunInstant();
        if (!date) return;
        try {
            await Forma.sun.setDate({ date });
            await readSun();
        } catch (error) {
            console.error(error);
            setStatus(`Could not set Forma's sun: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const load = async () => {
        setBusy(true);
        setStatus('Loading the renderer…');
        try {
            const mod = await import('./panelRender');
            presetsRef.current = mod.PRESETS;
            if (!engine.current) engine.current = new mod.PanelRenderer(canvas.current!);
            const e = engine.current;

            setStatus('Reading buildings from Forma…');
            let t = performance.now();
            const buildings = await Promise.all(buildingPaths.map(async (path) => ({
                path, position: await Forma.geometry.getTriangles({ path }),
            })));
            const buildingMs = Math.round(performance.now() - t);
            e.setBuildings(buildings);

            let contextMs = 0;
            if (withContext) {
                setStatus('Reading terrain and context from Forma…');
                t = performance.now();
                e.setContext(await Forma.geometry.getTriangles({ excludedPaths: buildingPaths }));
                contextMs = Math.round(performance.now() - t);
            } else {
                e.setContext(null);
            }

            lastCamera.current = await Forma.camera.getCurrent();
            await readSun();
            unsubscribe.current?.();
            const sub = await Forma.camera.subscribe((state) => {
                lastCamera.current = state;
                engine.current?.setView(state, FOV);
                engine.current?.render();
                scheduleSoftRef.current();
            });
            unsubscribe.current = sub.unsubscribe;

            const preset = mod.PRESETS[presetName];
            setStyle((current) => current ?? preset); // keep any tweaks when the geometry is reloaded
            setLoaded(true);
            setInfo({
                buildingTriangles: e.stats.buildingTriangles,
                contextTriangles: e.stats.contextTriangles,
                lineSegments: e.stats.edgeSegments,
                buildingMs,
                contextMs,
                gpu: e.gpuInfo(),
            });
            setStatus(null);
        } catch (error) {
            console.error(error);
            setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    // A preset sets the look only: transparency, context treatment and shadow strength belong to the
    // export being made, so they stay as they are.
    const applyLook = (key: string, look: LookStyle) => {
        setPresetName(key);
        setStyle((current) => (current ? withLook(current, look) : current));
    };

    const choosePreset = (name: string) => {
        const preset = presetsRef.current?.[name];
        if (preset) applyLook(name, toLook(preset));
    };

    /** Stores the list in the project; on failure the list on screen is kept and the user is told. */
    const persistPresets = async (next: SavedPreset[], success: string) => {
        setSaved(next);
        try {
            await saveRenderPresets(next);
            setPresetMessage(success);
        } catch (error) {
            console.error(error);
            setPresetMessage('Could not save to the Forma project. The change will be lost when the panel closes.');
        }
    };

    const saveCurrentLook = async () => {
        const name = cleanName(newPresetName);
        if (!style || !name || nameTaken(name, saved) || saved.length >= MAX_PRESETS) return;
        const preset: SavedPreset = { id: newId(), name, look: toLook(style), saved: new Date().toISOString() };
        setPresetName(`saved:${preset.id}`);
        setNewPresetName('');
        await persistPresets([...saved, preset], `Saved "${name}".`);
    };

    const updatePreset = async (id: string) => {
        if (!style) return;
        const target = saved.find((p) => p.id === id);
        if (!target) return;
        await persistPresets(
            saved.map((p) => (p.id === id ? { ...p, look: toLook(style), saved: new Date().toISOString() } : p)),
            `Updated "${target.name}" with the current look.`,
        );
    };

    const deletePreset = async (id: string) => {
        const target = saved.find((p) => p.id === id);
        if (!target) return;
        // Two clicks: the first arms the button, the second deletes.
        if (confirmDelete !== id) {
            setConfirmDelete(id);
            setTimeout(() => setConfirmDelete((current) => (current === id ? null : current)), 4000);
            return;
        }
        setConfirmDelete(null);
        if (presetName === `saved:${id}`) setPresetName('');
        await persistPresets(saved.filter((p) => p.id !== id), `Deleted "${target.name}".`);
    };

    const exportPresets = () => {
        const url = URL.createObjectURL(new Blob([serialisePresets(saved)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'forma-render-presets.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setPresetMessage(`Exported ${saved.length} preset${saved.length === 1 ? '' : 's'}.`);
    };

    const importPresets = async (event: Event) => {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = ''; // lets the same file be chosen again
        if (!file) return;
        const parsed = parsePresetFile(await file.text());
        if (!parsed) { setPresetMessage('That file is not a presets file.'); return; }
        const merged = mergeImported(saved, parsed.presets, newId);
        if (merged.added === 0) {
            setPresetMessage(parsed.skipped > 0 ? `Nothing imported: ${parsed.skipped} entries were not valid presets.` : 'The file had no presets.');
            return;
        }
        const notes = [
            merged.renamed > 0 ? `${merged.renamed} renamed because the name was taken` : '',
            parsed.skipped > 0 ? `${parsed.skipped} invalid skipped` : '',
            merged.dropped > 0 ? `${merged.dropped} left out (limit of ${MAX_PRESETS})` : '',
        ].filter(Boolean);
        await persistPresets(merged.presets, `Imported ${merged.added} preset${merged.added === 1 ? '' : 's'}${notes.length ? ` (${notes.join(', ')})` : ''}.`);
    };

    const patch = (changes: Partial<RenderStyle>) => setStyle((s) => (s ? { ...s, ...changes } : s));

    const grabOverlay = async () => {
        const el = host.current;
        if (!el) return;
        setBusy(true);
        try {
            const w = Math.round(el.clientWidth * 2);
            const captured = await Forma.camera.capture({ width: w, height: Math.round(w / ASPECTS[aspect]) });
            setOverlay(captured.toDataURL('image/png'));
        } catch (error) {
            console.error(error);
            setStatus(`Overlay capture failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const createStudy = async () => {
        const e = engine.current, info = formaSun.current, current = style;
        const day = parseIsoDate(studyDate);
        if (!e || !info?.location || !current || !day) return;
        setBusy(true);
        try {
            setStatus('Rendering the shadow study…');
            await new Promise((resolve) => setTimeout(resolve, 30)); // let the status paint before the heavy work
            const [latitude, longitude] = info.location;
            const times = studyTimes(studyFrom, studyTo, studyCount);
            const angles = times.map((m) => sunAngles(
                zonedToUtc({ ...day, hour: Math.floor(m / 60), minute: m % 60 }, info.zone), latitude, longitude,
            ));
            const dateLabel = longDate(day);
            const background = current.transparent ? null : current.background;
            const textColour = current.transparent ? current.lineColour : readableOn(current.background);
            let sheet: HTMLCanvasElement;
            let note: string | null = null;
            if (studyLayout === 'layered') {
                // Only times with the sun up cast a shadow, so the others are left out.
                const up = times.map((_, i) => i).filter((i) => angles[i].elevation > 0);
                if (up.length === 0) throw new Error('The sun is below the horizon at every chosen time.');
                if (up.length < times.length) note = `${times.length - up.length} time(s) with the sun below the horizon were left out.`;
                const plan = planLayered(exportWidth, e.aspect, true, up.length, layerMode);
                const reference = Math.floor((up.length - 1) / 2); // the buildings are lit as at the middle time
                const { base, masks } = e.captureShadowLayers(
                    plan.imageWidth, up.length, (i) => e.setSunDirection(sunVector(angles[up[i]])), reference,
                );
                sheet = composeLayered(base, masks, plan, {
                    mode: layerMode,
                    opacity: current.shadowOpacity,
                    times: up.map((i) => formatClock(times[i])),
                    background,
                    textColour,
                    title: `Layered shadows · ${dateLabel} · ${info.zone}`,
                    accumulateColour: '#101418',
                });
            } else {
                const plan = planSheet(exportWidth, studyColumns, times.length, e.aspect, studyLabels, true);
                const frames = e.captureSequence(plan.tileWidth, times.length, (i) => e.setSunDirection(sunVector(angles[i])));
                const tiles = frames.map((canvas, i) => ({
                    canvas,
                    time: formatClock(times[i]),
                    detail: angles[i].elevation > 0
                        ? `azimuth ${angles[i].azimuth.toFixed(0)}° · elevation ${angles[i].elevation.toFixed(0)}°`
                        : 'sun below the horizon',
                }));
                sheet = composeSheet(tiles, plan, {
                    title: `Shadow study · ${dateLabel} · ${info.zone}`,
                    labels: studyLabels,
                    background,
                    textColour,
                });
            }
            const blob = await new Promise<Blob>((resolve, reject) =>
                sheet.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
            if (studyUrl.current) URL.revokeObjectURL(studyUrl.current);
            studyUrl.current = URL.createObjectURL(blob);
            const kind = studyLayout === 'layered' ? 'shadow-layers' : 'shadow-study';
            setStudy({ url: studyUrl.current, name: `forma-${kind}-${studyDate}${current.transparent ? '-transparent' : ''}.png` });
            setStatus(note);
        } catch (error) {
            console.error(error);
            setStatus(`Shadow study failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSunTick((n) => n + 1); // put the panel's sun back to the chosen mode
            setBusy(false);
        }
    };

    const download = async () => {
        const e = engine.current;
        if (!e) return;
        setBusy(true);
        try {
            const blob = await e.exportPng(exportWidth);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = style?.transparent ? 'forma-panel-render-transparent.png' : 'forma-panel-render.png';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            console.error(error);
            setStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const builtIn = Object.keys(presetsRef.current ?? {});
    const presetOptions: [string, string][] = [
        ...builtIn.map((name): [string, string] => [name, name]),
        ...saved.map((p): [string, string] => [`saved:${p.id}`, p.name]),
    ];
    const choosePresetKey = (key: string) => {
        if (key.startsWith('saved:')) {
            const preset = saved.find((p) => `saved:${p.id}` === key);
            if (preset) applyLook(key, preset.look);
        } else {
            choosePreset(key);
        }
    };
    const selectValue = (e: Event) => (e.target as HTMLSelectElement).value;
    const parseClock = (value: string): number | null => {
        const [h, m] = value.split(':').map(Number);
        return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
    };
    const weightInput = (id: string, label: string, value: number, key: 'lineWeight' | 'silhouetteWeight', disabledFlag = false) => (
        <input id={id} type="number" min="0.01" max="20" step="0.05" value={value} aria-label={label} disabled={disabledFlag}
            onInput={(e) => {
                const v = Number(targetOf(e).value);
                if (v > 0) patch({ [key]: Math.min(v, 20) });
            }} />
    );
    const quickDates = (onPick: (monthDay: string) => void) => (
        <div class="segmented segmented--fill segmented--compact" role="group" aria-label="Standard dates">
            {STUDY_DATES.map(([label, monthDay]) => (
                <button key={monthDay} type="button" onClick={() => onPick(monthDay)}>{label}</button>
            ))}
        </div>
    );
    const studySummary = studyLayout === 'layered'
        ? `One image with the shadows from ${studyCount} times between ${formatClock(studyFrom)} and ${formatClock(studyTo)} layered on the ground. They land on the context if it is shown, otherwise on a flat ground.`
        : `${studyCount} images from ${formatClock(studyFrom)} to ${formatClock(studyTo)} on one sheet, in the current view and look.`;

    return (
        <div class="render">
            {!loaded && (
                <div class="section">
                    <h3>Render</h3>
                    <div class="empty-state">
                        <p>
                            Draw this proposal here with clean lines, light and shadow, following Forma's camera,
                            then export presentation images and shadow studies.
                        </p>
                        <button onClick={load} disabled={disabled || busy || buildingPaths.length === 0}>
                            {busy ? <><Spinner /> Loading…</> : 'Load scene'}
                        </button>
                        <div style={{ marginTop: '0.9em' }}>
                            <label class="check">
                                <input type="checkbox" checked={withContext}
                                    onChange={(e) => setWithContext(targetOf(e).checked)} /> Include terrain and context
                            </label>
                        </div>
                    </div>
                    {status && <p class="status">{busy && <Spinner />}{status}</p>}
                </div>
            )}

            <div class="section" style={{ display: loaded ? 'block' : 'none' }}>
                <div ref={host} class="preview" style={{ background: style?.transparent ? CHECKERBOARD : undefined }}>
                    <canvas ref={canvas} />
                    <div ref={softHost} style={{ position: 'absolute', inset: '0', pointerEvents: 'none' }} />
                    {overlay && (
                        <img src={overlay} alt="Forma view for comparison"
                            style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', opacity: overlayOpacity, pointerEvents: 'none' }} />
                    )}
                </div>
                <div class="toolbar">
                    <label class="visually-hidden" for="re-aspect">Frame</label>
                    <select id="re-aspect" value={aspect} onChange={(e) => setAspect(selectValue(e))} title="Frame shape, for the preview and every export">
                        {Object.keys(ASPECTS).map((a) => <option value={a}>{a}</option>)}
                    </select>
                    {overlay
                        ? <button class="button-ghost" onClick={() => setOverlay(null)}>Hide Forma view</button>
                        : <button class="button-ghost" onClick={grabOverlay} disabled={busy} title="Lay Forma's own view over the preview to compare">Compare with Forma</button>}
                    <span class="toolbar__spacer" />
                    <button class="button-ghost" onClick={load} disabled={disabled || busy} title="Read the geometry again after the model changes">
                        Reload
                    </button>
                </div>
                {overlay && (
                    <Field label="Forma view" htmlFor="re-overlay" value={`${Math.round(overlayOpacity * 100)}%`}>
                        <input id="re-overlay" type="range" min="0" max="1" step="0.05" value={overlayOpacity}
                            onInput={(e) => setOverlayOpacity(Number(targetOf(e).value))} />
                    </Field>
                )}
                {status && <p class="status" role="status">{busy && <Spinner />}{status}</p>}
            </div>

            {loaded && style && (
                <>
                    <div class="section">
                        <h3>Look</h3>
                        <Segmented label="Preset" options={presetOptions} value={presetName} onChange={choosePresetKey} />

                        <details class="disclosure">
                            <summary>Saved presets ({saved.length})</summary>
                            <p class="help" style={{ marginTop: 0 }}>
                                A preset keeps the look: colours, lines and light. Background and context are set
                                when you export. Saved presets are shared with everyone on this Forma project.
                            </p>
                            {canEdit && (
                                <div class="row" style={{ marginTop: '0.6em' }}>
                                    <input type="text" value={newPresetName} maxLength={MAX_NAME_LENGTH} placeholder="Name this look"
                                        aria-label="Name for the new preset" style={{ flex: 1 }}
                                        onInput={(e) => setNewPresetName(targetOf(e).value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') saveCurrentLook(); }} />
                                    <button onClick={saveCurrentLook}
                                        disabled={!cleanName(newPresetName) || nameTaken(newPresetName, saved) || saved.length >= MAX_PRESETS}>
                                        Save current look
                                    </button>
                                </div>
                            )}
                            {canEdit && nameTaken(newPresetName, saved) && cleanName(newPresetName) && (
                                <p class="help">That name is already used. Choose another, or update that preset.</p>
                            )}
                            {saved.map((p) => (
                                <div class="field" key={p.id}>
                                    <span class="field__label" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                                    <div class="field__control">
                                        {canEdit && (
                                            <>
                                                <button class="button-ghost" onClick={() => updatePreset(p.id)}
                                                    aria-label={`Update ${p.name} with the current look`}>Update</button>
                                                <button class="button-ghost" onClick={() => deletePreset(p.id)}
                                                    aria-label={confirmDelete === p.id ? `Confirm delete ${p.name}` : `Delete ${p.name}`}>
                                                    {confirmDelete === p.id ? 'Confirm delete' : 'Delete'}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                    <span />
                                </div>
                            ))}
                            <div class="actions">
                                <button class="button-ghost" onClick={exportPresets} disabled={saved.length === 0}>Export to file</button>
                                {canEdit && (
                                    <>
                                        <button class="button-ghost" onClick={() => presetFile.current?.click()}>Import from file…</button>
                                        <input ref={presetFile} type="file" accept=".json,application/json" style={{ display: 'none' }}
                                            onChange={importPresets} />
                                    </>
                                )}
                            </div>
                            {presetMessage && <p class="help" role="status">{presetMessage}</p>}
                        </details>

                        <h4>Lines</h4>
                        <Field label="Edges" htmlFor="re-weight" value={weightInput('re-weight-px', 'Edge weight in pixels', style.lineWeight, 'lineWeight')}>
                            <input id="re-weight" type="range" min="0.05" max="8" step="0.05" value={style.lineWeight}
                                onInput={(e) => patch({ lineWeight: Number(targetOf(e).value) })} />
                        </Field>
                        <Field label="Silhouettes" htmlFor="re-silhouette-weight"
                            value={weightInput('re-silhouette-px', 'Silhouette weight in pixels', style.silhouetteWeight, 'silhouetteWeight', !style.silhouettes)}>
                            <input id="re-silhouettes" type="checkbox" checked={style.silhouettes} aria-label="Draw silhouettes"
                                onChange={(e) => patch({ silhouettes: targetOf(e).checked })} />
                            <input id="re-silhouette-weight" type="range" min="0.05" max="8" step="0.05" value={style.silhouetteWeight}
                                disabled={!style.silhouettes} style={{ flex: 1, width: 'auto' }}
                                onInput={(e) => patch({ silhouetteWeight: Number(targetOf(e).value) })} />
                        </Field>
                        <Field label="Depth weighting" htmlFor="re-depth" value={`${Math.round(style.depthWeight * 100)}%`}>
                            <input id="re-depth" type="range" min="0" max="1" step="0.05" value={style.depthWeight}
                                title="Heavier lines near the camera, lighter far away"
                                onInput={(e) => patch({ depthWeight: Number(targetOf(e).value) })} />
                        </Field>
                        <Field label="Line colour" htmlFor="re-line">
                            <input id="re-line" type="color" value={style.lineColour} onInput={(e) => patch({ lineColour: targetOf(e).value })} />
                        </Field>

                        <h4>Colours</h4>
                        <Field label="Background" htmlFor="re-bg" value={style.transparent ? 'Transparent' : undefined}>
                            <input id="re-bg" type="color" value={style.background} disabled={style.transparent}
                                onInput={(e) => patch({ background: targetOf(e).value })} />
                        </Field>
                        <Field label="Buildings" htmlFor="re-fill">
                            <input id="re-fill" type="color" value={style.buildingColour ?? '#cccccc'} disabled={style.buildingColour === null}
                                onInput={(e) => patch({ buildingColour: targetOf(e).value })} />
                            <label class="check">
                                <input type="checkbox" checked={style.buildingColour === null}
                                    onChange={(e) => patch({ buildingColour: targetOf(e).checked ? null : '#f4f1ea' })} /> Metrics colours
                            </label>
                        </Field>
                        <Field label="Context" htmlFor="re-ctx-colour">
                            <input id="re-ctx-colour" type="color" value={style.contextColour}
                                onInput={(e) => patch({ contextColour: targetOf(e).value })} />
                        </Field>

                        <h4>Light and shadow</h4>
                        <Field label="Sun" htmlFor="re-sun" value={`${Math.round(style.sunIntensity * 100)}%`}>
                            <input id="re-sun" type="range" min="0" max="1.5" step="0.05" value={style.sunIntensity}
                                onInput={(e) => patch({ sunIntensity: Number(targetOf(e).value) })} />
                        </Field>
                        <Field label="Ambient" htmlFor="re-amb" value={`${Math.round(style.ambient * 100)}%`}>
                            <input id="re-amb" type="range" min="0" max="1.5" step="0.05" value={style.ambient}
                                onInput={(e) => patch({ ambient: Number(targetOf(e).value) })} />
                        </Field>
                        <Field label="Shadows" htmlFor="re-shadows">
                            <input id="re-shadows" type="checkbox" checked={style.shadows}
                                onChange={(e) => patch({ shadows: targetOf(e).checked })} />
                        </Field>
                        <Field label="Softness" htmlFor="re-soft" value={`${style.shadowSoftness.toFixed(1)}°`}>
                            <input id="re-soft" type="range" min="0" max="10" step="0.1" value={style.shadowSoftness}
                                disabled={!style.shadows}
                                onInput={(e) => patch({ shadowSoftness: Number(targetOf(e).value) })} />
                        </Field>
                        <p class="help">
                            {style.shadows && style.shadowSoftness > 0
                                ? 'Softness is the sun\'s apparent size (the real sun is about 0.5°). The preview sharpens once you stop moving; exports take longer.'
                                : 'Softness 0 gives hard-edged shadows.'}
                        </p>
                    </div>

                    <div class="section">
                        <div class="section__head">
                            <h3>Sun</h3>
                            <button class="button-ghost" onClick={() => readSun()} disabled={busy} title="Read Forma's sun and project location again">
                                Re-read
                            </button>
                        </div>
                        <Segmented label="Sun position" fill value={sunMode} onChange={chooseSunMode}
                            options={[['forma', 'Follow Forma'], ['custom', 'Choose a time']]} />
                        {sunMode === 'custom' && (
                            <div style={{ marginTop: '0.8em' }}>
                                <Field label="Date" htmlFor="re-date">
                                    <input id="re-date" type="date" value={customDate}
                                        onInput={(e) => { if (parseIsoDate(targetOf(e).value)) setCustomDate(targetOf(e).value); }} />
                                </Field>
                                <Field label="">{quickDates(chooseStudyDate)}</Field>
                                <Field label="Time" htmlFor="re-time" value={formatClock(customMinutes)}>
                                    <input id="re-time" type="range" min="0" max="1430" step="10" value={customMinutes}
                                        onInput={(e) => setCustomMinutes(Number(targetOf(e).value))} />
                                </Field>
                                <div class="actions">
                                    <button class="button-ghost" onClick={applyToForma} disabled={busy}>Set Forma's sun to this</button>
                                </div>
                            </div>
                        )}
                        <p class="help" role="status">{sunText}</p>
                    </div>

                    <div class="section">
                        <h3>Export</h3>
                        <Segmented label="What to export" fill value={outputKind} onChange={setOutputKind}
                            options={[['image', 'Image'], ['study', 'Shadow study']]} />
                        <div style={{ marginTop: '0.8em' }}>
                            <Field label="Width" htmlFor="re-width">
                                <select id="re-width" value={exportWidth} onChange={(e) => setExportWidth(Number(selectValue(e)))}>
                                    {[1280, 1920, 2560, 3840, 5120].map((w) => <option value={w}>{w.toLocaleString('en-GB')} px</option>)}
                                </select>
                            </Field>
                            <Field label="Background">
                                <label class="check">
                                    <input type="checkbox" checked={style.transparent}
                                        onChange={(e) => {
                                            const on = targetOf(e).checked;
                                            // A see-through export is rarely wanted with an opaque ground, so switch to shadows only.
                                            patch(on && style.contextMode === 'shown'
                                                ? { transparent: true, contextMode: 'shadows' } : { transparent: on });
                                        }} /> Transparent
                                </label>
                            </Field>
                            <Field label="Context" htmlFor="re-context">
                                <select id="re-context" value={style.contextMode}
                                    onChange={(e) => patch({ contextMode: selectValue(e) as ContextMode })}>
                                    <option value="shown">Shown</option>
                                    <option value="shadows">Shadows only</option>
                                    <option value="hidden">Hidden</option>
                                </select>
                            </Field>
                            {style.contextMode === 'shadows' && outputKind === 'image' && (
                                <Field label="Shadow strength" htmlFor="re-shadow" value={`${Math.round(style.shadowOpacity * 100)}%`}>
                                    <input id="re-shadow" type="range" min="0.05" max="1" step="0.05" value={style.shadowOpacity}
                                        onInput={(e) => patch({ shadowOpacity: Number(targetOf(e).value) })} />
                                </Field>
                            )}
                        </div>

                        {outputKind === 'image' && (
                            <>
                                {style.contextMode === 'shadows' && !style.shadows && (
                                    <p class="help">Shadows are off under Look, so a shadows-only context will be empty.</p>
                                )}
                                <div class="actions">
                                    <button onClick={download} disabled={busy}>Download PNG</button>
                                </div>
                            </>
                        )}

                        {outputKind === 'study' && (
                            <>
                                <h4>Times</h4>
                                <Field label="Date" htmlFor="re-sdate">
                                    <input id="re-sdate" type="date" value={studyDate}
                                        onInput={(e) => { if (parseIsoDate(targetOf(e).value)) setStudyDate(targetOf(e).value); }} />
                                </Field>
                                <Field label="">{quickDates((monthDay) => setStudyDate(`${studyDate.slice(0, 4)}-${monthDay}`))}</Field>
                                <Field label="From" htmlFor="re-sfrom">
                                    <input id="re-sfrom" type="time" step="300" value={formatClock(studyFrom)}
                                        onInput={(e) => { const m = parseClock(targetOf(e).value); if (m !== null) setStudyFrom(m); }} />
                                </Field>
                                <Field label="To" htmlFor="re-sto">
                                    <input id="re-sto" type="time" step="300" value={formatClock(studyTo)}
                                        onInput={(e) => { const m = parseClock(targetOf(e).value); if (m !== null) setStudyTo(m); }} />
                                </Field>
                                <Field label="Times" htmlFor="re-scount">
                                    <select id="re-scount" value={studyCount} onChange={(e) => setStudyCount(Number(selectValue(e)))}>
                                        {[2, 3, 4, 5, 6, 8, 9, 12].map((n) => <option value={n}>{n}</option>)}
                                    </select>
                                </Field>

                                <h4>Layout</h4>
                                <Segmented label="Layout" fill value={studyLayout} onChange={setStudyLayout}
                                    options={[['separate', 'Separate images'], ['layered', 'One layered image']]} />
                                <div style={{ marginTop: '0.8em' }}>
                                    {studyLayout === 'separate' && (
                                        <Field label="Columns" htmlFor="re-scols">
                                            <select id="re-scols" value={studyColumns} onChange={(e) => setStudyColumns(Number(selectValue(e)))}>
                                                {[1, 2, 3, 4].map((n) => <option value={n}>{n}</option>)}
                                            </select>
                                            <label class="check">
                                                <input type="checkbox" checked={studyLabels} onChange={(e) => setStudyLabels(targetOf(e).checked)} /> Labels
                                            </label>
                                        </Field>
                                    )}
                                    {studyLayout === 'layered' && (
                                        <>
                                            <Field label="Colour" htmlFor="re-lmode">
                                                <select id="re-lmode" value={layerMode} onChange={(e) => setLayerMode(selectValue(e) as LayerMode)}>
                                                    <option value="time">By time of day</option>
                                                    <option value="accumulate">Darker = more hours</option>
                                                </select>
                                            </Field>
                                            <Field label={layerMode === 'time' ? 'Shadow opacity' : 'Darkest ground'} htmlFor="re-lopacity"
                                                value={`${Math.round(style.shadowOpacity * 100)}%`}>
                                                <input id="re-lopacity" type="range" min="0.1" max="0.95" step="0.05" value={style.shadowOpacity}
                                                    onInput={(e) => patch({ shadowOpacity: Number(targetOf(e).value) })} />
                                            </Field>
                                        </>
                                    )}
                                </div>
                                <p class="help">
                                    {studyLayout === 'separate' && !style.shadows
                                        ? 'Shadows are off under Look, so the images will not show any.'
                                        : `${studySummary}${style.shadows && style.shadowSoftness > 0 ? ' Soft shadows make this slower.' : ''}`}
                                </p>
                                <div class="actions">
                                    <button onClick={createStudy} disabled={busy || !formaSun.current?.location}>
                                        {studyLayout === 'layered' ? 'Create layered image' : 'Create shadow study'}
                                    </button>
                                    {study && (
                                        <button class="button-ghost" onClick={() => {
                                            const link = document.createElement('a');
                                            link.href = study.url;
                                            link.download = study.name;
                                            link.click();
                                        }}>Download PNG</button>
                                    )}
                                </div>
                                {!formaSun.current?.location && <p class="help">The project has no location, so a shadow study is not possible.</p>}
                                {study && <img class="result-image" src={study.url} alt="Shadow study" />}
                            </>
                        )}
                    </div>

                    <details class="disclosure" style={{ margin: '0 0 0.8em', padding: '0 0.2em' }}>
                        <summary>Scene details</summary>
                        <label class="check" style={{ margin: '0.4em 0 0.8em' }}>
                            <input type="checkbox" checked={withContext}
                                onChange={(e) => setWithContext(targetOf(e).checked)} /> Include terrain and context (applies on Reload)
                        </label>
                        {info && (
                            <dl class="facts">
                                <dt>Buildings</dt><dd>{info.buildingTriangles.toLocaleString('en-GB')} triangles, read in {info.buildingMs} ms</dd>
                                <dt>Context</dt><dd>{info.contextTriangles.toLocaleString('en-GB')} triangles, read in {info.contextMs} ms</dd>
                                <dt>Lines</dt><dd>{info.lineSegments.toLocaleString('en-GB')} edge segments</dd>
                                <dt>Graphics</dt><dd>{info.gpu}</dd>
                            </dl>
                        )}
                    </details>
                </>
            )}
        </div>
    );
}
