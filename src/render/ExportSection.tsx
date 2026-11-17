// The Export section: one image of the current view, or a shadow study (several times on a sheet, or
// all the times layered in one image). Holds the study's settings and its last result.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { ContextMode, PanelRenderer, RenderStyle } from '../panelRender';
import type { LayerMode } from '../layeredShadows';
import { formatClock, parseIsoDate } from '../timeZone';
import { Field, Segmented } from '../ui';
import { QuickDates } from './SunSection';
import { canvasToPng, renderShadowStudy } from './shadowStudy';
import type { SunState } from './useSun';
import {
    EXPORT_WIDTHS, OutputKind, PatchStyle, RunTask, StudyLayout, downloadBlob, downloadUrl, inputChecked, inputValue,
    parseClock, selectValue,
} from './shared';

export function ExportSection({ engine, style, patch, sun, busy, runTask }: {
    engine: RefObject<PanelRenderer>;
    style: RenderStyle;
    patch: PatchStyle;
    sun: SunState;
    busy: boolean;
    runTask: RunTask;
}) {
    const [outputKind, setOutputKind] = useState<OutputKind>('image');
    const [width, setWidth] = useState(2560);

    // Shadow study: several times on one date. It starts on Forma's date, in the project's time zone.
    const [studyDate, setStudyDateState] = useState(sun.formaDate ?? '2026-12-21');
    const [from, setFrom] = useState(9 * 60);
    const [to, setTo] = useState(15 * 60);
    const [count, setCount] = useState(3);
    const [columns, setColumns] = useState(3);
    const [labels, setLabels] = useState(true);
    const [layout, setLayout] = useState<StudyLayout>('separate');
    const [layerMode, setLayerMode] = useState<LayerMode>('time');
    const [study, setStudy] = useState<{ url: string; name: string } | null>(null);
    const studyUrl = useRef<string | null>(null);
    const setStudyDate = (value: string) => { if (parseIsoDate(value)) setStudyDateState(value); };

    useEffect(() => () => { if (studyUrl.current) URL.revokeObjectURL(studyUrl.current); }, []);

    const downloadImage = () => runTask('Export failed', async () => {
        const e = engine.current;
        if (!e) return;
        const blob = await e.exportPng(width);
        downloadBlob(blob, style.transparent ? 'forma-panel-render-transparent.png' : 'forma-panel-render.png');
    });

    const createStudy = async () => {
        const e = engine.current, info = sun.forma.current, day = parseIsoDate(studyDate);
        if (!e || !info?.location || !day) return;
        const location = info.location;
        await runTask('Shadow study failed', async () => {
            await new Promise((resolve) => setTimeout(resolve, 30)); // let the status paint before the heavy work
            try {
                const { sheet, note } = renderShadowStudy(e, { ...info, location }, style, {
                    day, from, to, count, layout, columns, labels, layerMode, width,
                });
                const blob = await canvasToPng(sheet);
                if (studyUrl.current) URL.revokeObjectURL(studyUrl.current);
                studyUrl.current = URL.createObjectURL(blob);
                const kind = layout === 'layered' ? 'shadow-layers' : 'shadow-study';
                setStudy({ url: studyUrl.current, name: `forma-${kind}-${studyDate}${style.transparent ? '-transparent' : ''}.png` });
                return note;
            } finally {
                sun.restore(); // put the panel's sun back to the chosen mode
            }
        }, 'Rendering the shadow study…');
    };

    const hasLocation = !!sun.forma.current?.location;
    const summary = layout === 'layered'
        ? `One image with the shadows from ${count} times between ${formatClock(from)} and ${formatClock(to)} layered on the ground. They land on the context if it is shown, otherwise on a flat ground.`
        : `${count} images from ${formatClock(from)} to ${formatClock(to)} on one sheet, in the current view and look.`;

    return (
        <div class="section">
            <h3>Export</h3>
            <Segmented label="What to export" fill value={outputKind} onChange={setOutputKind}
                options={[['image', 'Image'], ['study', 'Shadow study']]} />
            <div style={{ marginTop: '0.8em' }}>
                <Field label="Width" htmlFor="re-width">
                    <select id="re-width" value={width} onChange={(e) => setWidth(Number(selectValue(e)))}>
                        {EXPORT_WIDTHS.map((w) => <option value={w}>{w.toLocaleString('en-GB')} px</option>)}
                    </select>
                </Field>
                <Field label="Background">
                    <label class="check">
                        <input type="checkbox" checked={style.transparent}
                            onChange={(e) => {
                                const on = inputChecked(e);
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
                            onInput={(e) => patch({ shadowOpacity: Number(inputValue(e)) })} />
                    </Field>
                )}
            </div>

            {outputKind === 'image' && (
                <>
                    {style.contextMode === 'shadows' && !style.shadows && (
                        <p class="help">Shadows are off under Look, so a shadows-only context will be empty.</p>
                    )}
                    <div class="actions">
                        <button onClick={downloadImage} disabled={busy}>Download PNG</button>
                    </div>
                </>
            )}

            {outputKind === 'study' && (
                <>
                    <h4>Times</h4>
                    <Field label="Date" htmlFor="re-sdate">
                        <input id="re-sdate" type="date" value={studyDate} onInput={(e) => setStudyDate(inputValue(e))} />
                    </Field>
                    <Field label=""><QuickDates onPick={(monthDay) => setStudyDate(`${studyDate.slice(0, 4)}-${monthDay}`)} /></Field>
                    <Field label="From" htmlFor="re-sfrom">
                        <input id="re-sfrom" type="time" step="300" value={formatClock(from)}
                            onInput={(e) => { const m = parseClock(inputValue(e)); if (m !== null) setFrom(m); }} />
                    </Field>
                    <Field label="To" htmlFor="re-sto">
                        <input id="re-sto" type="time" step="300" value={formatClock(to)}
                            onInput={(e) => { const m = parseClock(inputValue(e)); if (m !== null) setTo(m); }} />
                    </Field>
                    <Field label="Times" htmlFor="re-scount">
                        <select id="re-scount" value={count} onChange={(e) => setCount(Number(selectValue(e)))}>
                            {[2, 3, 4, 5, 6, 8, 9, 12].map((n) => <option value={n}>{n}</option>)}
                        </select>
                    </Field>

                    <h4>Layout</h4>
                    <Segmented label="Layout" fill value={layout} onChange={setLayout}
                        options={[['separate', 'Separate images'], ['layered', 'One layered image']]} />
                    <div style={{ marginTop: '0.8em' }}>
                        {layout === 'separate' && (
                            <Field label="Columns" htmlFor="re-scols">
                                <select id="re-scols" value={columns} onChange={(e) => setColumns(Number(selectValue(e)))}>
                                    {[1, 2, 3, 4].map((n) => <option value={n}>{n}</option>)}
                                </select>
                                <label class="check">
                                    <input type="checkbox" checked={labels} onChange={(e) => setLabels(inputChecked(e))} /> Labels
                                </label>
                            </Field>
                        )}
                        {layout === 'layered' && (
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
                                        onInput={(e) => patch({ shadowOpacity: Number(inputValue(e)) })} />
                                </Field>
                            </>
                        )}
                    </div>
                    <p class="help">
                        {layout === 'separate' && !style.shadows
                            ? 'Shadows are off under Look, so the images will not show any.'
                            : `${summary}${style.shadows && style.shadowSoftness > 0 ? ' Soft shadows make this slower.' : ''}`}
                    </p>
                    <div class="actions">
                        <button onClick={createStudy} disabled={busy || !hasLocation}>
                            {layout === 'layered' ? 'Create layered image' : 'Create shadow study'}
                        </button>
                        {study && (
                            <button class="button-ghost" onClick={() => downloadUrl(study.url, study.name)}>Download PNG</button>
                        )}
                    </div>
                    {!hasLocation && <p class="help">The project has no location, so a shadow study is not possible.</p>}
                    {study && <img class="result-image" src={study.url} alt="Shadow study" />}
                </>
            )}
        </div>
    );
}
