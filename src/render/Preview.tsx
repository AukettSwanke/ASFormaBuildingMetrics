// The render preview: the engine's canvas, the soft-shadow image and Forma's view laid over it, and the
// toolbar under it. Always mounted (hidden until loaded) because the engine draws into its canvas.

import type { RefObject } from 'preact';
import { Field, Spinner } from '../ui';
import { ASPECTS, CHECKERBOARD, inputValue, selectValue } from './shared';

export function Preview({
    visible, canvas, host, softHost, transparent, aspect, onAspect, overlay, overlayOpacity, onOverlayOpacity,
    onCompare, onHideOverlay, onReload, busy, reloadDisabled, status,
}: {
    visible: boolean;
    canvas: RefObject<HTMLCanvasElement>;
    host: RefObject<HTMLDivElement>;
    softHost: RefObject<HTMLDivElement>;
    /** Shows a checkerboard behind the canvas, as the export will be see-through. */
    transparent: boolean;
    aspect: string;
    onAspect: (aspect: string) => void;
    /** Data URL of Forma's own view, or null when not comparing. */
    overlay: string | null;
    overlayOpacity: number;
    onOverlayOpacity: (opacity: number) => void;
    onCompare: () => void;
    onHideOverlay: () => void;
    onReload: () => void;
    busy: boolean;
    reloadDisabled: boolean;
    status: string | null;
}) {
    return (
        <div class="section" style={{ display: visible ? 'block' : 'none' }}>
            <div ref={host} class="preview" style={{ background: transparent ? CHECKERBOARD : undefined }}>
                <canvas ref={canvas} />
                <div ref={softHost} style={{ position: 'absolute', inset: '0', pointerEvents: 'none' }} />
                {overlay && (
                    <img src={overlay} alt="Forma view for comparison"
                        style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', opacity: overlayOpacity, pointerEvents: 'none' }} />
                )}
            </div>
            <div class="toolbar">
                <label class="visually-hidden" for="re-aspect">Frame</label>
                <select id="re-aspect" value={aspect} onChange={(e) => onAspect(selectValue(e))} title="Frame shape, for the preview and every export">
                    {Object.keys(ASPECTS).map((a) => <option value={a}>{a}</option>)}
                </select>
                {overlay
                    ? <button class="button-ghost" onClick={onHideOverlay}>Hide Forma view</button>
                    : <button class="button-ghost" onClick={onCompare} disabled={busy} title="Lay Forma's own view over the preview to compare">Compare with Forma</button>}
                <span class="toolbar__spacer" />
                <button class="button-ghost" onClick={onReload} disabled={reloadDisabled} title="Read the geometry again after the model changes">
                    Reload
                </button>
            </div>
            {overlay && (
                <Field label="Forma view" htmlFor="re-overlay" value={`${Math.round(overlayOpacity * 100)}%`}>
                    <input id="re-overlay" type="range" min="0" max="1" step="0.05" value={overlayOpacity}
                        onInput={(e) => onOverlayOpacity(Number(inputValue(e)))} />
                </Field>
            )}
            {status && <p class="status" role="status">{busy && <Spinner />}{status}</p>}
        </div>
    );
}
