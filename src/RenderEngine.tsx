import { Forma } from 'forma-embedded-view-sdk/auto';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PanelRenderer, RenderStyle } from './panelRender';
import { sunAngles, sunVector } from './sunPosition';

const ASPECTS: Record<string, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1 };
type Presets = Record<string, RenderStyle>;

const targetOf = (e: Event) => e.target as HTMLInputElement;

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
    const sunBase = useRef<ReturnType<typeof sunAngles> | null>(null);

    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [withContext, setWithContext] = useState(true);
    const [status, setStatus] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [aspect, setAspect] = useState('16:9');
    const [fov, setFov] = useState(45);
    const [presetName, setPresetName] = useState('Clay');
    const [style, setStyle] = useState<RenderStyle | null>(null);
    const [sunRotation, setSunRotation] = useState(0);
    const [overlay, setOverlay] = useState<string | null>(null);
    const [overlayOpacity, setOverlayOpacity] = useState(0.5);
    const [exportWidth, setExportWidth] = useState(2560);
    const [sunText, setSunText] = useState<string | null>(null);

    const lastCamera = useRef<Parameters<PanelRenderer['setView']>[0] | null>(null);
    // The camera subscription outlives renders, so it reads the FOV through a ref.
    const fovRef = useRef(fov);
    fovRef.current = fov;

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
        e.setView(lastCamera.current!, fov);
        if (sunBase.current) e.setSunDirection(sunVector(sunBase.current, sunRotation));
        redraw();
    }, [style, panelColours, fov, aspect, sunRotation, loaded]);

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
        const [date, location] = await Promise.all([Forma.sun.getDate(), Forma.project.getGeoLocation()]);
        if (!location) { setSunText('No project location, so the sun direction is a default.'); return; }
        const angles = sunAngles(date, location[0], location[1]);
        sunBase.current = angles;
        setSunText(`Sun ${date.toISOString().slice(0, 16)}Z · azimuth ${angles.azimuth.toFixed(1)}° · elevation ${angles.elevation.toFixed(1)}°`);
        engine.current?.setSunDirection(sunVector(angles, sunRotation));
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
                engine.current?.setView(state, fovRef.current);
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
            a.download = 'forma-panel-render.png';
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
                <canvas ref={canvas} style={{ width: '100%', display: 'block', border: '1px solid var(--border-default)' }} />
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
                        <label class="muted" for="re-weight">Line weight (px)</label>
                        <input id="re-weight" type="range" min="0.05" max="8" step="0.05" value={style.lineWeight}
                            onInput={(e) => patch({ lineWeight: Number(targetOf(e).value) })} />
                        <input type="number" min="0.01" max="20" step="0.05" value={style.lineWeight} style={{ width: '6em' }}
                            onInput={(e) => {
                                const v = Number(targetOf(e).value);
                                if (v > 0) patch({ lineWeight: Math.min(v, 20) });
                            }} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-line">Line</label>
                        <input id="re-line" type="color" value={style.lineColour} onInput={(e) => patch({ lineColour: targetOf(e).value })} />
                        <label class="muted" for="re-bg">Background</label>
                        <input id="re-bg" type="color" value={style.background} onInput={(e) => patch({ background: targetOf(e).value })} />
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

                    <h3>Match to Forma</h3>
                    <div class="row row--wrap">
                        <label class="muted" for="re-fov">Field of view {fov}°</label>
                        <input id="re-fov" type="range" min="15" max="90" value={fov} onInput={(e) => setFov(Number(targetOf(e).value))} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="re-rot">Sun rotation {sunRotation}°</label>
                        <input id="re-rot" type="range" min="-180" max="180" value={sunRotation}
                            onInput={(e) => setSunRotation(Number(targetOf(e).value))} />
                        <button class="button-ghost" onClick={() => readSun().then(redraw)} disabled={busy}>Re-read sun</button>
                    </div>
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
                    <p class="muted">{sunText}</p>
                    <p class="muted">{info}</p>
                </>
            )}
        </div>
    );
}
