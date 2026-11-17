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

type SunMode = 'forma' | 'custom';
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
    const [info, setInfo] = useState<string | null>(null);
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
            `${isoDate(z)} ${formatClock(z.hour * 60 + z.minute)} (${info.zone}) · azimuth ${angles.azimuth.toFixed(0)}° · `
            + (angles.elevation > 0 ? `elevation ${angles.elevation.toFixed(1)}°` : 'sun below the horizon'),
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
        setStatus('Loading three.js…');
        try {
            const mod = await import('./panelRender');
            presetsRef.current = mod.PRESETS;
            if (!engine.current) engine.current = new mod.PanelRenderer(canvas.current!);
            const e = engine.current;

            setStatus('Fetching building geometry…');
            let t = performance.now();
            const buildings = await Promise.all(buildingPaths.map(async (path) => ({
                path, position: await Forma.geometry.getTriangles({ path }),
            })));
            const buildingMs = Math.round(performance.now() - t);
            e.setBuildings(buildings);

            let contextMs = 0;
            if (withContext) {
                setStatus('Fetching context geometry…');
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
            setInfo(
                `${e.stats.buildingTriangles.toLocaleString()} building triangles in ${buildingMs} ms · `
                + `${e.stats.contextTriangles.toLocaleString()} context triangles in ${contextMs} ms · `
                + `${e.stats.edgeSegments.toLocaleString()} line segments · ${e.gpuInfo()}`,
            );
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
            const dateLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
                .format(new Date(Date.UTC(day.year, day.month - 1, day.day)));
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

    return (
        <div class="section">
            <h3>Render (panel engine)</h3>
            <div class="row row--wrap">
                <label class="muted">
                    <input type="checkbox" checked={withContext}
                        onChange={(e) => setWithContext(targetOf(e).checked)} /> Include context (terrain, other elements)
                </label>
            </div>
            <button onClick={load} disabled={disabled || busy || buildingPaths.length === 0}>
                {busy ? <><span class="spinner">⟳</span> Working…</> : loaded ? 'Reload geometry' : 'Load scene'}
            </button>
            <p class="muted">
                {status ?? 'Draws the scene with our own renderer, following the Forma camera. Reload after the model changes.'}
            </p>

            <div ref={host} style={{ position: 'relative', width: '100%', display: loaded ? 'block' : 'none' }}>
                <canvas ref={canvas} style={{
                    width: '100%', display: 'block', border: '1px solid var(--border-default)',
                    background: style?.transparent ? CHECKERBOARD : undefined,
                }} />
                <div ref={softHost} style={{ position: 'absolute', inset: '0', pointerEvents: 'none' }} />
                {overlay && (
                    <img src={overlay} alt="Forma view for comparison"
                        style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', opacity: overlayOpacity, pointerEvents: 'none' }} />
                )}
            </div>

            {loaded && style && (
                <>
                    <div class="row row--wrap">
                        {Object.keys(presetsRef.current ?? {}).map((name) => (
                            <button class={name === presetName ? '' : 'button-ghost'} onClick={() => choosePreset(name)}>{name}</button>
                        ))}
                        {saved.map((p) => (
                            <button class={presetName === `saved:${p.id}` ? '' : 'button-ghost'}
                                onClick={() => applyLook(`saved:${p.id}`, p.look)}>{p.name}</button>
                        ))}
                    </div>
                    <details>
                        <summary class="muted">Saved presets ({saved.length})</summary>
                        {canEdit && (
                            <div class="row row--wrap">
                                <input type="text" value={newPresetName} maxLength={MAX_NAME_LENGTH} placeholder="Name this look"
                                    aria-label="Name for the new preset"
                                    onInput={(e) => setNewPresetName(targetOf(e).value)} />
                                <button onClick={saveCurrentLook}
                                    disabled={!cleanName(newPresetName) || nameTaken(newPresetName, saved) || saved.length >= MAX_PRESETS}>
                                    Save current look
                                </button>
                            </div>
                        )}
                        {canEdit && nameTaken(newPresetName, saved) && cleanName(newPresetName) && (
                            <p class="muted">That name is already used. Choose another, or use Update on that preset.</p>
                        )}
                        {saved.map((p) => (
                            <div class="row row--wrap">
                                <span>{p.name}</span>
                                {canEdit && (
                                    <>
                                        <button class="button-ghost" onClick={() => updatePreset(p.id)}>Update</button>
                                        <button class="button-ghost" onClick={() => deletePreset(p.id)}>
                                            {confirmDelete === p.id ? 'Confirm delete' : 'Delete'}
                                        </button>
                                    </>
                                )}
                            </div>
                        ))}
                        <div class="row row--wrap">
                            <button class="button-ghost" onClick={exportPresets} disabled={saved.length === 0}>Export file</button>
                            {canEdit && (
                                <>
                                    <button class="button-ghost" onClick={() => presetFile.current?.click()}>Import file…</button>
                                    <input ref={presetFile} type="file" accept=".json,application/json" style={{ display: 'none' }}
                                        onChange={importPresets} />
                                </>
                            )}
                        </div>
                        <p class="muted">
                            {presetMessage ?? 'A preset saves the look: colours, lines and light. Transparency and context are set per export. Presets are shared with everyone on this Forma project; export a file to use one in another project.'}
                        </p>
                    </details>
                    <div class="row row--wrap">
                        <label class="muted" for="re-weight">Edge lines (px)</label>
                        <input id="re-weight" type="range" min="0.05" max="8" step="0.05" value={style.lineWeight}
                            onInput={(e) => patch({ lineWeight: Number(targetOf(e).value) })} />
                        <input type="number" min="0.01" max="20" step="0.05" value={style.lineWeight} style={{ width: '6em' }}
                            onInput={(e) => {
                                const v = Number(targetOf(e).value);
                                if (v > 0) patch({ lineWeight: Math.min(v, 20) });
                            }} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted">
                            <input type="checkbox" checked={style.silhouettes}
                                onChange={(e) => patch({ silhouettes: targetOf(e).checked })} /> Silhouettes
                        </label>
                        <input type="range" min="0.05" max="8" step="0.05" value={style.silhouetteWeight}
                            disabled={!style.silhouettes} aria-label="Silhouette weight"
                            onInput={(e) => patch({ silhouetteWeight: Number(targetOf(e).value) })} />
                        <input type="number" min="0.01" max="20" step="0.05" value={style.silhouetteWeight} style={{ width: '6em' }}
                            disabled={!style.silhouettes} aria-label="Silhouette weight in pixels"
                            onInput={(e) => {
                                const v = Number(targetOf(e).value);
                                if (v > 0) patch({ silhouetteWeight: Math.min(v, 20) });
                            }} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-depth">Depth weighting {Math.round(style.depthWeight * 100)}%</label>
                        <input id="re-depth" type="range" min="0" max="1" step="0.05" value={style.depthWeight}
                            onInput={(e) => patch({ depthWeight: Number(targetOf(e).value) })} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-line">Line</label>
                        <input id="re-line" type="color" value={style.lineColour} onInput={(e) => patch({ lineColour: targetOf(e).value })} />
                        <label class="muted" for="re-bg">Background</label>
                        <input id="re-bg" type="color" value={style.background} disabled={style.transparent}
                            onInput={(e) => patch({ background: targetOf(e).value })} />
                        <label class="muted" for="re-fill">Buildings</label>
                        <input id="re-fill" type="color" value={style.buildingColour ?? '#cccccc'}
                            onInput={(e) => patch({ buildingColour: targetOf(e).value })} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-sun">Sun {Math.round(style.sunIntensity * 100)}%</label>
                        <input id="re-sun" type="range" min="0" max="1.5" step="0.05" value={style.sunIntensity}
                            onInput={(e) => patch({ sunIntensity: Number(targetOf(e).value) })} />
                        <label class="muted" for="re-amb">Ambient {Math.round(style.ambient * 100)}%</label>
                        <input id="re-amb" type="range" min="0" max="1.5" step="0.05" value={style.ambient}
                            onInput={(e) => patch({ ambient: Number(targetOf(e).value) })} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted">
                            <input type="checkbox" checked={style.shadows} onChange={(e) => patch({ shadows: targetOf(e).checked })} /> Shadows
                        </label>
                        <select value={aspect} onChange={(e) => setAspect((e.target as unknown as HTMLSelectElement).value)}>
                            {Object.keys(ASPECTS).map((a) => <option value={a}>{a}</option>)}
                        </select>
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-soft">Shadow softness {style.shadowSoftness.toFixed(1)}°</label>
                        <input id="re-soft" type="range" min="0" max="10" step="0.1" value={style.shadowSoftness}
                            disabled={!style.shadows}
                            onInput={(e) => patch({ shadowSoftness: Number(targetOf(e).value) })} />
                    </div>
                    {style.shadows && style.shadowSoftness > 0 && (
                        <p class="muted">
                            The sun's apparent size: 0 gives hard edges, the real sun is about 0.5°. Shadows soften with distance
                            from what casts them. The preview sharpens after you stop moving; exports take longer.
                        </p>
                    )}
                    <div class="row row--wrap">
                        <label class="muted">
                            <input type="checkbox" checked={style.transparent}
                                onChange={(e) => {
                                    const on = targetOf(e).checked;
                                    // A see-through export is rarely wanted with an opaque ground, so switch to shadows only.
                                    patch(on && style.contextMode === 'shown'
                                        ? { transparent: true, contextMode: 'shadows' } : { transparent: on });
                                }} /> Transparent background
                        </label>
                        <label class="muted" for="re-context">Context</label>
                        <select id="re-context" value={style.contextMode}
                            onChange={(e) => patch({ contextMode: (e.target as unknown as HTMLSelectElement).value as ContextMode })}>
                            <option value="shown">Shown</option>
                            <option value="shadows">Shadows only</option>
                            <option value="hidden">Hidden</option>
                        </select>
                    </div>
                    {style.contextMode === 'shadows' && (
                        <div class="row row--wrap">
                            <label class="muted" for="re-shadow">Shadow strength {Math.round(style.shadowOpacity * 100)}%</label>
                            <input id="re-shadow" type="range" min="0.05" max="1" step="0.05" value={style.shadowOpacity}
                                onInput={(e) => patch({ shadowOpacity: Number(targetOf(e).value) })} />
                            {!style.shadows && <span class="muted">Switch Shadows on to see them.</span>}
                        </div>
                    )}

                    <h3>Sun</h3>
                    <div class="row row--wrap">
                        <select value={sunMode} aria-label="Sun source"
                            onChange={(e) => chooseSunMode((e.target as unknown as HTMLSelectElement).value as SunMode)}>
                            <option value="forma">Follow Forma</option>
                            <option value="custom">Choose date and time</option>
                        </select>
                        <button class="button-ghost" onClick={() => readSun()} disabled={busy}>Re-read sun</button>
                    </div>
                    {sunMode === 'custom' && (
                        <>
                            <div class="row row--wrap">
                                <label class="muted" for="re-date">Date</label>
                                <input id="re-date" type="date" value={customDate}
                                    onInput={(e) => { if (parseIsoDate(targetOf(e).value)) setCustomDate(targetOf(e).value); }} />
                                {STUDY_DATES.map(([label, monthDay]) => (
                                    <button class="button-ghost" onClick={() => chooseStudyDate(monthDay)}>{label}</button>
                                ))}
                            </div>
                            <div class="row row--wrap">
                                <label class="muted" for="re-time">Time {formatClock(customMinutes)}</label>
                                <input id="re-time" type="range" min="0" max="1430" step="10" value={customMinutes}
                                    onInput={(e) => setCustomMinutes(Number(targetOf(e).value))} />
                            </div>
                            <div class="row row--wrap">
                                <button class="button-ghost" onClick={applyToForma} disabled={busy}>Set Forma's sun to this</button>
                            </div>
                        </>
                    )}
                    <p class="muted">{sunText}</p>

                    <h3>Shadow study</h3>
                    <div class="row row--wrap">
                        <label class="muted" for="re-sdate">Date</label>
                        <input id="re-sdate" type="date" value={studyDate}
                            onInput={(e) => { if (parseIsoDate(targetOf(e).value)) setStudyDate(targetOf(e).value); }} />
                        {STUDY_DATES.map(([label, monthDay]) => (
                            <button class="button-ghost" onClick={() => setStudyDate(`${studyDate.slice(0, 4)}-${monthDay}`)}>{label}</button>
                        ))}
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-sfrom">From</label>
                        <input id="re-sfrom" type="time" step="300" value={formatClock(studyFrom)}
                            onInput={(e) => {
                                const [h, m] = targetOf(e).value.split(':').map(Number);
                                if (Number.isFinite(h) && Number.isFinite(m)) setStudyFrom(h * 60 + m);
                            }} />
                        <label class="muted" for="re-sto">to</label>
                        <input id="re-sto" type="time" step="300" value={formatClock(studyTo)}
                            onInput={(e) => {
                                const [h, m] = targetOf(e).value.split(':').map(Number);
                                if (Number.isFinite(h) && Number.isFinite(m)) setStudyTo(h * 60 + m);
                            }} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-scount">Images</label>
                        <select id="re-scount" value={studyCount}
                            onChange={(e) => setStudyCount(Number((e.target as unknown as HTMLSelectElement).value))}>
                            {[2, 3, 4, 5, 6, 8, 9, 12].map((n) => <option value={n}>{n}</option>)}
                        </select>
                        {studyLayout === 'separate' && (
                            <>
                                <label class="muted" for="re-scols">Columns</label>
                                <select id="re-scols" value={studyColumns}
                                    onChange={(e) => setStudyColumns(Number((e.target as unknown as HTMLSelectElement).value))}>
                                    {[1, 2, 3, 4].map((n) => <option value={n}>{n}</option>)}
                                </select>
                                <label class="muted">
                                    <input type="checkbox" checked={studyLabels} onChange={(e) => setStudyLabels(targetOf(e).checked)} /> Labels
                                </label>
                            </>
                        )}
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-slayout">Layout</label>
                        <select id="re-slayout" value={studyLayout}
                            onChange={(e) => setStudyLayout((e.target as unknown as HTMLSelectElement).value as 'separate' | 'layered')}>
                            <option value="separate">Separate images</option>
                            <option value="layered">One layered image</option>
                        </select>
                        {studyLayout === 'layered' && (
                            <>
                                <label class="muted" for="re-lmode">Colour</label>
                                <select id="re-lmode" value={layerMode}
                                    onChange={(e) => setLayerMode((e.target as unknown as HTMLSelectElement).value as LayerMode)}>
                                    <option value="time">By time of day</option>
                                    <option value="accumulate">Darker = more hours</option>
                                </select>
                            </>
                        )}
                    </div>
                    {studyLayout === 'layered' && (
                        <div class="row row--wrap">
                            <label class="muted" for="re-lopacity">
                                {layerMode === 'time' ? 'Shadow opacity' : 'Darkest ground'} {Math.round(style.shadowOpacity * 100)}%
                            </label>
                            <input id="re-lopacity" type="range" min="0.1" max="0.95" step="0.05" value={style.shadowOpacity}
                                onInput={(e) => patch({ shadowOpacity: Number(targetOf(e).value) })} />
                        </div>
                    )}
                    <div class="row row--wrap">
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
                    <p class="muted">
                        {studyLayout === 'layered'
                            ? `One image: the shadows from ${studyCount} times between ${formatClock(studyFrom)} and ${formatClock(studyTo)} layered on the ground, ${exportWidth}px wide. Shadows land on the context if it is shown, otherwise on a flat ground.${style.shadowSoftness > 0 ? ' Soft shadows make this slower.' : ''}`
                            : style.shadows
                            ? `${studyCount} renders from ${formatClock(studyFrom)} to ${formatClock(studyTo)} on one sheet, ${exportWidth}px wide, using the current view, look and project time zone.${style.shadowSoftness > 0 ? ' Soft shadows make this slower.' : ''}`
                            : 'Switch Shadows on first, otherwise the images will not show any.'}
                    </p>
                    {study && <img src={study.url} alt="Shadow study" style={{ width: '100%', display: 'block', border: '1px solid var(--border-default)' }} />}

                    <h3>Compare with Forma</h3>
                    <div class="row row--wrap">
                        <button class="button-ghost" onClick={grabOverlay} disabled={busy}>Overlay Forma view</button>
                        {overlay && (
                            <>
                                <input type="range" min="0" max="1" step="0.05" value={overlayOpacity}
                                    onInput={(e) => setOverlayOpacity(Number(targetOf(e).value))} />
                                <button class="button-ghost" onClick={() => setOverlay(null)}>Remove</button>
                            </>
                        )}
                    </div>

                    <div class="row row--wrap">
                        <select value={exportWidth} onChange={(e) => setExportWidth(Number((e.target as unknown as HTMLSelectElement).value))}>
                            {[1280, 1920, 2560, 3840, 5120].map((w) => <option value={w}>{w}px wide</option>)}
                        </select>
                        <button onClick={download} disabled={busy}>Download PNG</button>
                    </div>
                    <p class="muted">{info}</p>
                </>
            )}
        </div>
    );
}
