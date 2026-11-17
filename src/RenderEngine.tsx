import { Forma } from 'forma-embedded-view-sdk/auto';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ContextMode, PanelRenderer, RenderStyle } from './panelRender';
import { sunAngles, sunVector } from './sunPosition';
import { fallbackZone, formatClock, isoDate, parseIsoDate, utcToZoned, zonedToUtc } from './timeZone';

type SunMode = 'forma' | 'custom';
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
 * Spike for option B: draw the Forma scene with our own three.js renderer in the panel.
 * three.js is imported on first use so it does not weigh down the rest of the panel.
 */
export function RenderEngine({ buildingPaths, panelColours, disabled }: {
    buildingPaths: string[];
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

    const lastCamera = useRef<Parameters<PanelRenderer['setView']>[0] | null>(null);

    const redraw = () => {
        const e = engine.current, el = host.current;
        if (!e || !el) return;
        e.resize(el.clientWidth, el.clientWidth / ASPECTS[aspect], Math.min(window.devicePixelRatio || 1, 2));
        e.render();
    };

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

    useEffect(() => () => {
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
            });
            unsubscribe.current = sub.unsubscribe;

            const preset = mod.PRESETS[presetName];
            setStyle(preset);
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

    const choosePreset = (name: string) => {
        setPresetName(name);
        const preset = presetsRef.current?.[name];
        if (preset) setStyle({ ...preset });
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
                    </div>
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
