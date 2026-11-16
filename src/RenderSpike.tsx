import { Forma } from 'forma-embedded-view-sdk/auto';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
    CompositeResult, RenderStyle, composite, idColour, readPixels, waitForRender,
} from './renderSpike';

interface Passes {
    beauty: ImageData;
    id: ImageData;
    beautyCanvas: HTMLCanvasElement;
    idCanvas: HTMLCanvasElement;
    beautyMs: number;
    idMs: number;
}

const ASPECTS: Record<string, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1 };

/** Puts an existing canvas into the page, scaled to the panel width. */
function CanvasView({ canvas, label }: { canvas: HTMLCanvasElement | null; label: string }) {
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = host.current;
        if (!el) return;
        if (!canvas) { el.replaceChildren(); return; }
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        canvas.style.border = '1px solid var(--border-default)';
        el.replaceChildren(canvas);
    }, [canvas]);
    return (
        <div>
            <p class="muted">{label}</p>
            <div ref={host} />
        </div>
    );
}

/**
 * Spike for the "render" feature: two-pass capture (beauty + per-building flat ID colours),
 * then edge detection on the ID pass composited over the beauty pass.
 * The point is to answer, inside Forma: does capture work at size, and does it include
 * our element colours? Everything shown here is diagnostic.
 */
export function RenderSpike({ buildingPaths, restoreColours, disabled }: {
    buildingPaths: string[];
    /** Re-applies whatever colours the user had before the ID pass (or clears them). */
    restoreColours: () => Promise<void>;
    disabled: boolean;
}) {
    const [width, setWidth] = useState(1280);
    const [aspect, setAspect] = useState('16:9');
    const [settleMs, setSettleMs] = useState(250);
    const [weight, setWeight] = useState(3);
    const [threshold, setThreshold] = useState(40);
    const [lineColour, setLineColour] = useState('#111111');
    const [style, setStyle] = useState<RenderStyle>('overBeauty');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [passes, setPasses] = useState<Passes | null>(null);
    const [result, setResult] = useState<CompositeResult | null>(null);

    const height = Math.round(width / ASPECTS[aspect]);

    const run = async () => {
        setBusy(true);
        setPasses(null);
        setResult(null);
        let idPassStarted = false;
        try {
            setStatus('Capturing beauty pass…');
            let t = performance.now();
            const beautyCanvas = await Forma.camera.capture({ width, height });
            const beautyMs = Math.round(performance.now() - t);

            setStatus('Colouring buildings for the ID pass…');
            idPassStarted = true;
            await Forma.render.cleanup();
            const pathsToColor = new Map<string, string>();
            buildingPaths.forEach((path, i) => pathsToColor.set(path, idColour(i)));
            await Forma.render.elementColors.set({ pathsToColor });
            await waitForRender(settleMs);

            setStatus('Capturing ID pass…');
            t = performance.now();
            const idCanvas = await Forma.camera.capture({ width, height });
            const idMs = Math.round(performance.now() - t);

            setPasses({
                beauty: readPixels(beautyCanvas), id: readPixels(idCanvas),
                beautyCanvas, idCanvas, beautyMs, idMs,
            });
            setStatus(null);
        } catch (error) {
            console.error(error);
            setStatus(`Capture failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (idPassStarted) {
                try { await restoreColours(); } catch (error) { console.error(error); }
            }
            setBusy(false);
        }
    };

    // Re-composite whenever a control changes; no new capture needed.
    useEffect(() => {
        if (!passes) return;
        if (passes.beauty.width !== passes.id.width || passes.beauty.height !== passes.id.height) {
            setStatus('Beauty and ID captures came back at different sizes, so they cannot be combined.');
            setResult(null);
            return;
        }
        setResult(composite(passes.beauty, passes.id, { threshold, weight, lineColour, style }));
    }, [passes, threshold, weight, lineColour, style]);

    const download = () => {
        result?.canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'forma-render-spike.png';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/png');
    };

    return (
        <div class="section">
            <h3>Render (spike)</h3>
            <div class="row row--wrap">
                <label class="muted" for="rs-width">Width</label>
                <select id="rs-width" value={width} onChange={(e) => setWidth(Number((e.target as HTMLSelectElement).value))}>
                    {[640, 1280, 1920, 2560, 3840].map((w) => <option value={w}>{w}px</option>)}
                </select>
                <select value={aspect} onChange={(e) => setAspect((e.target as HTMLSelectElement).value)}>
                    {Object.keys(ASPECTS).map((a) => <option value={a}>{a}</option>)}
                </select>
                <label class="muted" for="rs-settle">Settle (ms)</label>
                <input id="rs-settle" type="number" min="0" step="50" value={settleMs}
                    onInput={(e) => setSettleMs(Math.max(0, Number((e.target as HTMLInputElement).value) || 0))} />
            </div>
            <button onClick={run} disabled={disabled || busy || buildingPaths.length === 0}>
                {busy ? <><span class="spinner">⟳</span> Capturing…</> : `Capture ${width}×${height}`}
            </button>
            <p class="muted">
                {status ?? 'Captures the current view, briefly recolours buildings with flat IDs, captures again, then restores your colours. The view will flicker.'}
            </p>

            {passes && (
                <>
                    <div class="row row--wrap">
                        <label class="muted" for="rs-weight">Line weight {weight}px</label>
                        <input id="rs-weight" type="range" min="1" max="15" value={weight}
                            onInput={(e) => setWeight(Number((e.target as HTMLInputElement).value))} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="rs-threshold">Edge threshold {threshold}</label>
                        <input id="rs-threshold" type="range" min="5" max="150" value={threshold}
                            onInput={(e) => setThreshold(Number((e.target as HTMLInputElement).value))} />
                    </div>
                    <div class="row row--wrap">
                        <label class="muted" for="rs-colour">Line colour</label>
                        <input id="rs-colour" type="color" value={lineColour}
                            onInput={(e) => setLineColour((e.target as HTMLInputElement).value)} />
                        <select value={style} onChange={(e) => setStyle((e.target as HTMLSelectElement).value as RenderStyle)}>
                            <option value="overBeauty">Lines over view</option>
                            <option value="overWhite">Lines on white</option>
                        </select>
                    </div>

                    <CanvasView canvas={result?.canvas ?? null} label="Result" />
                    <button class="button-ghost" onClick={download} disabled={!result}>Download PNG</button>

                    <p class="muted">
                        Beauty {passes.beauty.width}×{passes.beauty.height} in {passes.beautyMs} ms · ID {passes.id.width}×{passes.id.height} in {passes.idMs} ms
                        {result && <> · {result.edgePixels.toLocaleString()} edge px · ID pass differs from beauty in {(result.idDiffersFromBeauty * 100).toFixed(1)}% of pixels</>}
                    </p>
                    {result && result.idDiffersFromBeauty < 0.01 && (
                        <p class="muted">
                            The ID pass looks almost identical to the beauty pass. Either the flat colours did not show up in the capture (try a longer Settle), or capture ignores element colours, which would break this approach.
                        </p>
                    )}

                    <CanvasView canvas={passes.beautyCanvas} label="Beauty pass" />
                    <CanvasView canvas={passes.idCanvas} label="ID pass" />
                </>
            )}
        </div>
    );
}
