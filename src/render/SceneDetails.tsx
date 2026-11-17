// Before loading: what the Render tab does and the Load scene button. After: figures about the scene.

import { Spinner } from '../ui';
import { SceneInfo, inputChecked } from './shared';

export function LoadPrompt({ onLoad, disabled, busy, withContext, onWithContext, status }: {
    onLoad: () => void;
    disabled: boolean;
    busy: boolean;
    withContext: boolean;
    onWithContext: (on: boolean) => void;
    status: string | null;
}) {
    return (
        <div class="section">
            <h3>Render</h3>
            <div class="empty-state">
                <p>
                    Draw this proposal here with clean lines, light and shadow, following Forma's camera,
                    then export presentation images and shadow studies.
                </p>
                <button onClick={onLoad} disabled={disabled}>
                    {busy ? <><Spinner /> Loading…</> : 'Load scene'}
                </button>
                <div style={{ marginTop: '0.9em' }}>
                    <label class="check">
                        <input type="checkbox" checked={withContext}
                            onChange={(e) => onWithContext(inputChecked(e))} /> Include terrain and context
                    </label>
                </div>
            </div>
            {status && <p class="status">{busy && <Spinner />}{status}</p>}
        </div>
    );
}

export function SceneDetails({ info, withContext, onWithContext }: {
    info: SceneInfo | null;
    withContext: boolean;
    onWithContext: (on: boolean) => void;
}) {
    return (
        <details class="disclosure" style={{ margin: '0 0 0.8em', padding: '0 0.2em' }}>
            <summary>Scene details</summary>
            <label class="check" style={{ margin: '0.4em 0 0.8em' }}>
                <input type="checkbox" checked={withContext}
                    onChange={(e) => onWithContext(inputChecked(e))} /> Include terrain and context (applies on Reload)
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
    );
}
