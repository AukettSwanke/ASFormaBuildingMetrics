// The Look section: preset choice, saved presets, and the lines, colours, light and shadow of the render.

import type { RenderStyle } from '../panelRender';
import { Field, Segmented } from '../ui';
import { SavedPresets } from './SavedPresets';
import type { SavedPresetsState } from './useSavedPresets';
import { PatchStyle, inputChecked, inputValue } from './shared';

/** Line weights: the slider covers 0.05–8 px, the number box allows 0.01–20 px. */
function WeightBox({ id, label, value, disabled = false, onChange }: {
    id: string; label: string; value: number; disabled?: boolean; onChange: (px: number) => void;
}) {
    return (
        <input id={id} type="number" min="0.01" max="20" step="0.05" value={value} aria-label={label} disabled={disabled}
            onInput={(e) => {
                const v = Number(inputValue(e));
                if (v > 0) onChange(Math.min(v, 20));
            }} />
    );
}

export function LookSection({ style, patch, presetOptions, presetName, onChoosePreset, presets, canEdit }: {
    style: RenderStyle;
    patch: PatchStyle;
    /** [key, label] for every built-in and saved preset. */
    presetOptions: [string, string][];
    presetName: string;
    onChoosePreset: (key: string) => void;
    presets: SavedPresetsState;
    canEdit: boolean;
}) {
    const range = (field: keyof RenderStyle) => (e: Event) => patch({ [field]: Number(inputValue(e)) });
    return (
        <div class="section">
            <h3>Look</h3>
            <Segmented label="Preset" options={presetOptions} value={presetName} onChange={onChoosePreset} />
            <SavedPresets presets={presets} canEdit={canEdit} />

            <h4>Lines</h4>
            <Field label="Edges" htmlFor="re-weight"
                value={<WeightBox id="re-weight-px" label="Edge weight in pixels" value={style.lineWeight}
                    onChange={(px) => patch({ lineWeight: px })} />}>
                <input id="re-weight" type="range" min="0.05" max="8" step="0.05" value={style.lineWeight}
                    onInput={range('lineWeight')} />
            </Field>
            <Field label="Silhouettes" htmlFor="re-silhouette-weight"
                value={<WeightBox id="re-silhouette-px" label="Silhouette weight in pixels" value={style.silhouetteWeight}
                    disabled={!style.silhouettes} onChange={(px) => patch({ silhouetteWeight: px })} />}>
                <input id="re-silhouettes" type="checkbox" checked={style.silhouettes} aria-label="Draw silhouettes"
                    onChange={(e) => patch({ silhouettes: inputChecked(e) })} />
                <input id="re-silhouette-weight" type="range" min="0.05" max="8" step="0.05" value={style.silhouetteWeight}
                    disabled={!style.silhouettes} style={{ flex: 1, width: 'auto' }}
                    onInput={range('silhouetteWeight')} />
            </Field>
            <Field label="Depth weighting" htmlFor="re-depth" value={`${Math.round(style.depthWeight * 100)}%`}>
                <input id="re-depth" type="range" min="0" max="1" step="0.05" value={style.depthWeight}
                    title="Heavier lines near the camera, lighter far away"
                    onInput={range('depthWeight')} />
            </Field>
            <Field label="Line colour" htmlFor="re-line">
                <input id="re-line" type="color" value={style.lineColour} onInput={(e) => patch({ lineColour: inputValue(e) })} />
            </Field>

            <h4>Colours</h4>
            <Field label="Background" htmlFor="re-bg" value={style.transparent ? 'Transparent' : undefined}>
                <input id="re-bg" type="color" value={style.background} disabled={style.transparent}
                    onInput={(e) => patch({ background: inputValue(e) })} />
            </Field>
            <Field label="Buildings" htmlFor="re-fill">
                <input id="re-fill" type="color" value={style.buildingColour ?? '#cccccc'} disabled={style.buildingColour === null}
                    onInput={(e) => patch({ buildingColour: inputValue(e) })} />
                <label class="check">
                    <input type="checkbox" checked={style.buildingColour === null}
                        onChange={(e) => patch({ buildingColour: inputChecked(e) ? null : '#f4f1ea' })} /> Metrics colours
                </label>
            </Field>
            <Field label="Context" htmlFor="re-ctx-colour">
                <input id="re-ctx-colour" type="color" value={style.contextColour}
                    onInput={(e) => patch({ contextColour: inputValue(e) })} />
            </Field>

            <h4>Light and shadow</h4>
            <Field label="Sun" htmlFor="re-sun" value={`${Math.round(style.sunIntensity * 100)}%`}>
                <input id="re-sun" type="range" min="0" max="1.5" step="0.05" value={style.sunIntensity}
                    onInput={range('sunIntensity')} />
            </Field>
            <Field label="Ambient" htmlFor="re-amb" value={`${Math.round(style.ambient * 100)}%`}>
                <input id="re-amb" type="range" min="0" max="1.5" step="0.05" value={style.ambient}
                    onInput={range('ambient')} />
            </Field>
            <Field label="Shadows" htmlFor="re-shadows">
                <input id="re-shadows" type="checkbox" checked={style.shadows}
                    onChange={(e) => patch({ shadows: inputChecked(e) })} />
            </Field>
            <Field label="Softness" htmlFor="re-soft" value={`${style.shadowSoftness.toFixed(1)}°`}>
                <input id="re-soft" type="range" min="0" max="10" step="0.1" value={style.shadowSoftness}
                    disabled={!style.shadows}
                    onInput={range('shadowSoftness')} />
            </Field>
            <p class="help">
                {style.shadows && style.shadowSoftness > 0
                    ? 'Softness is the sun\'s apparent size (the real sun is about 0.5°). The preview sharpens once you stop moving; exports take longer.'
                    : 'Softness 0 gives hard-edged shadows.'}
            </p>
        </div>
    );
}
