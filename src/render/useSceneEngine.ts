// The three.js engine's life in the panel: loading geometry, following the Forma camera, redrawing on
// style and size changes, and the soft-shadow preview. three.js is imported on first load only.

import { Forma } from 'forma-embedded-view-sdk/auto';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { PanelRenderer, RenderStyle } from '../panelRender';
import { ASPECTS, FOV, SceneInfo } from './shared';

type CameraState = Parameters<PanelRenderer['setView']>[0];

/** Samples averaged for the on-screen soft-shadow preview (exports use more). */
const PREVIEW_SOFT_SAMPLES = 16;
/** How long the view must be still before the soft preview is drawn. */
const SOFT_DELAY_MS = 350;

export function useSceneEngine({ canvas, host, softHost, aspect, style, panelColours, loaded }: {
    canvas: RefObject<HTMLCanvasElement>;
    /** Element whose width the preview fills. */
    host: RefObject<HTMLDivElement>;
    /** Element the averaged soft-shadow image is placed in, over the canvas. */
    softHost: RefObject<HTMLDivElement>;
    aspect: string;
    style: RenderStyle | null;
    panelColours: Map<string, string>;
    loaded: boolean;
}) {
    const engine = useRef<PanelRenderer | null>(null);
    const lastCamera = useRef<CameraState | null>(null);
    const unsubscribe = useRef<(() => void) | null>(null);

    // Soft shadows are drawn by averaging many renders, which is too slow while the camera moves. The plain
    // render shows during interaction; once the view has been still for a moment, the averaged image is
    // laid over it.
    const [softCanvas, setSoftCanvas] = useState<HTMLCanvasElement | null>(null);
    const softTimer = useRef<number | undefined>(undefined);
    /** Always the latest scheduleSoft, for the camera subscription made once at load. */
    const scheduleSoftRef = useRef<() => void>(() => undefined);

    /** Hides the soft image at once (the view just changed) and draws a fresh one after a short pause. */
    const scheduleSoft = () => {
        window.clearTimeout(softTimer.current);
        setSoftCanvas(null);
        softTimer.current = window.setTimeout(() => {
            const e = engine.current;
            if (e) setSoftCanvas(e.renderSoftPreview(PREVIEW_SOFT_SAMPLES));
        }, SOFT_DELAY_MS);
    };
    scheduleSoftRef.current = scheduleSoft;

    /** Fits the canvas to the preview width at the chosen frame shape and draws. */
    const redraw = () => {
        const e = engine.current, el = host.current;
        if (!e || !el) return;
        e.resize(el.clientWidth, el.clientWidth / ASPECTS[aspect], Math.min(window.devicePixelRatio || 1, 2));
        e.render();
        scheduleSoftRef.current();
    };

    useEffect(() => {
        const el = softHost.current;
        if (!el) return;
        if (!softCanvas) { el.replaceChildren(); return; }
        softCanvas.style.cssText = 'display:block;width:100%;height:100%';
        softCanvas.dataset.role = 'soft-shadow-preview';
        el.replaceChildren(softCanvas);
    }, [softCanvas]);

    // Style, colour and frame changes: push to the engine and redraw.
    useEffect(() => {
        const e = engine.current;
        if (!e || !loaded || !style) return;
        e.applyStyle(style, panelColours);
        e.setView(lastCamera.current!, FOV);
        redraw();
    }, [style, panelColours, aspect, loaded]);

    // The preview follows the panel's width (and is sized again when a hidden tab is shown).
    useEffect(() => {
        const el = host.current;
        if (!el || !loaded) return;
        const observer = new ResizeObserver(redraw);
        observer.observe(el);
        return () => observer.disconnect();
    }, [loaded, aspect]);

    useEffect(() => () => {
        window.clearTimeout(softTimer.current);
        unsubscribe.current?.();
        engine.current?.dispose();
        engine.current = null;
    }, []);

    /**
     * Creates the engine on first use and loads the buildings (and the context, if asked) into it.
     * Returns the built-in presets and figures for Scene details.
     */
    const loadGeometry = async (
        buildingPaths: string[], withContext: boolean, onStatus: (text: string) => void,
    ): Promise<{ presets: Record<string, RenderStyle>; info: SceneInfo }> => {
        onStatus('Loading the renderer…');
        const mod = await import('../panelRender');
        if (!engine.current) engine.current = new mod.PanelRenderer(canvas.current!);
        const e = engine.current;

        onStatus('Reading buildings from Forma…');
        let t = performance.now();
        const buildings = await Promise.all(buildingPaths.map(async (path) => ({
            path, position: await Forma.geometry.getTriangles({ path }),
        })));
        const buildingMs = Math.round(performance.now() - t);
        e.setBuildings(buildings);

        let contextMs = 0;
        if (withContext) {
            onStatus('Reading terrain and context from Forma…');
            t = performance.now();
            e.setContext(await Forma.geometry.getTriangles({ excludedPaths: buildingPaths }));
            contextMs = Math.round(performance.now() - t);
        } else {
            e.setContext(null);
        }
        return {
            presets: mod.PRESETS,
            info: {
                buildingTriangles: e.stats.buildingTriangles,
                contextTriangles: e.stats.contextTriangles,
                lineSegments: e.stats.edgeSegments,
                buildingMs,
                contextMs,
                gpu: e.gpuInfo(),
            },
        };
    };

    /** Reads Forma's camera now and redraws on every later camera move. Safe to call again on reload. */
    const followCamera = async () => {
        lastCamera.current = await Forma.camera.getCurrent();
        unsubscribe.current?.();
        const sub = await Forma.camera.subscribe((state) => {
            lastCamera.current = state;
            engine.current?.setView(state, FOV);
            engine.current?.render();
            scheduleSoftRef.current();
        });
        unsubscribe.current = sub.unsubscribe;
    };

    return { engine, redraw, loadGeometry, followCamera };
}
