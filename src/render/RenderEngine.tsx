// The Render tab: draws the Forma scene with our own three.js renderer in the panel and exports it.
// This component holds the state the sections share (the look, the frame, busy and status) and wires
// the hooks and sections together; each section lives in its own file in this folder.
//
// three.js is imported on first *Load scene* (see useSceneEngine), so it does not weigh down the panel.

import { useRef, useState } from 'preact/hooks';
import { Forma } from 'forma-embedded-view-sdk/auto';
import type { RenderStyle } from '../panelRender';
import { toLook, withLook, LookStyle } from '../presets';
import { ExportSection } from './ExportSection';
import { LookSection } from './LookSection';
import { Preview } from './Preview';
import { LoadPrompt, SceneDetails } from './SceneDetails';
import { SunSection } from './SunSection';
import { useSceneEngine } from './useSceneEngine';
import { savedKey, useSavedPresets } from './useSavedPresets';
import { useSun } from './useSun';
import { ASPECTS, RunTask, SceneInfo, errorText } from './shared';

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
    const softHost = useRef<HTMLDivElement>(null);

    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [withContext, setWithContext] = useState(true);
    const [info, setInfo] = useState<SceneInfo | null>(null);
    const [aspect, setAspect] = useState('16:9');
    const [style, setStyle] = useState<RenderStyle | null>(null);
    /** Built-in presets, available once the engine module has loaded. */
    const [builtIn, setBuiltIn] = useState<Record<string, RenderStyle>>({});
    /** Preset shown as chosen: a built-in name or `saved:<id>`. */
    const [presetName, setPresetName] = useState('Clay');
    const [overlay, setOverlay] = useState<string | null>(null);
    const [overlayOpacity, setOverlayOpacity] = useState(0.5);

    const scene = useSceneEngine({ canvas, host, softHost, aspect, style, panelColours, loaded });
    const sun = useSun({ engine: scene.engine, loaded, redraw: scene.redraw, onError: setStatus });
    const presets = useSavedPresets({ style, presetName, setPresetName });

    const patch = (changes: Partial<RenderStyle>) => setStyle((s) => (s ? { ...s, ...changes } : s));

    /** Marks the panel busy for slow work, shows `pending`, and reports a failure as `failure: reason`. */
    const runTask: RunTask = async (failure, work, pending) => {
        setBusy(true);
        if (pending !== undefined) setStatus(pending);
        try {
            const result = await work();
            if (pending !== undefined || typeof result === 'string') setStatus(result ?? null);
        } catch (error) {
            console.error(error);
            setStatus(`${failure}: ${errorText(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const load = () => runTask('Load failed', async () => {
        const result = await scene.loadGeometry(buildingPaths, withContext, setStatus);
        await scene.followCamera();
        await sun.read();
        setBuiltIn(result.presets);
        setStyle((current) => current ?? result.presets[presetName]); // keep any tweaks when the geometry is reloaded
        setInfo(result.info);
        setLoaded(true);
        return null;
    }, 'Loading the renderer…');

    // A preset sets the look only: transparency, context treatment and shadow strength belong to the
    // export being made, so they stay as they are.
    const applyLook = (key: string, look: LookStyle) => {
        setPresetName(key);
        setStyle((current) => (current ? withLook(current, look) : current));
    };
    const choosePreset = (key: string) => {
        const savedPreset = presets.saved.find((p) => savedKey(p.id) === key);
        if (savedPreset) applyLook(key, savedPreset.look);
        else if (builtIn[key]) applyLook(key, toLook(builtIn[key]));
    };
    const presetOptions: [string, string][] = [
        ...Object.keys(builtIn).map((name): [string, string] => [name, name]),
        ...presets.saved.map((p): [string, string] => [savedKey(p.id), p.name]),
    ];

    /** Lays Forma's own view over the preview, to compare framing and sun. */
    const compareWithForma = () => runTask('Overlay capture failed', async () => {
        const el = host.current;
        if (!el) return;
        const w = Math.round(el.clientWidth * 2);
        const captured = await Forma.camera.capture({ width: w, height: Math.round(w / ASPECTS[aspect]) });
        setOverlay(captured.toDataURL('image/png'));
    });

    return (
        <div class="render">
            {!loaded && (
                <LoadPrompt onLoad={load} disabled={disabled || busy || buildingPaths.length === 0} busy={busy}
                    withContext={withContext} onWithContext={setWithContext} status={status} />
            )}

            <Preview visible={loaded} canvas={canvas} host={host} softHost={softHost}
                transparent={!!style?.transparent} aspect={aspect} onAspect={setAspect}
                overlay={overlay} overlayOpacity={overlayOpacity} onOverlayOpacity={setOverlayOpacity}
                onCompare={compareWithForma} onHideOverlay={() => setOverlay(null)}
                onReload={load} busy={busy} reloadDisabled={disabled || busy} status={status} />

            {loaded && style && (
                <>
                    <LookSection style={style} patch={patch} presetOptions={presetOptions} presetName={presetName}
                        onChoosePreset={choosePreset} presets={presets} canEdit={canEdit} />
                    <SunSection sun={sun} busy={busy} />
                    <ExportSection engine={scene.engine} style={style} patch={patch} sun={sun} busy={busy} runTask={runTask} />
                    <SceneDetails info={info} withContext={withContext} onWithContext={setWithContext} />
                </>
            )}
        </div>
    );
}
