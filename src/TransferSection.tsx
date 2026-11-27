import { Forma } from "forma-embedded-view-sdk/auto";
import { useMemo, useRef, useState } from "preact/hooks";
import type { Assignments, Category } from "./categories";
import { encodeGlb, translationMatrix } from "./envelope";
import {
    BuildingFunction, BuildingPair, FloorStack, GraphBuilding, Matrix, Placed, Shift, SpaceProps, TRANSFER_FORMAT,
    TRANSFER_VERSION, TransferBuilding, TransferFile, copySpaceFunctions, decodeMesh, detectShift, encodeMesh,
    functionsChange, graphToFloorStack, mapFunction, matchBuildings, ownSpaceProps, pairStacks, parseTransferFile,
    meshToBlock, planCategoryTransfer, planFunctions, shifted,
} from "./transfer";

// =============================================================
// COPY TO ANOTHER PROJECT (Data tab)
// Export a transfer file in one project, import it in another. See transfer.ts.
// =============================================================

/** The fields of a loaded building the transfer needs. */
export interface TransferSource extends Placed {
    number: number;
}

/** Element category given to buildings recreated from a mesh, so Forma lists them as buildings. */
const BUILDING_CATEGORY = 'building';
/** Light grey, opaque: recreated meshes should look like ordinary buildings, not envelopes. */
const MESH_RGBA = [0.85, 0.85, 0.85, 1];

/** Forma's URN type, taken from the SDK so `forma-elements` need not be a direct dependency. */
type Urn = Parameters<typeof Forma.elements.replace>[0]['urn'];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs one Forma call, so a failure says which step it was (Forma's own messages often don't). */
const step = async <T,>(name: string, call: () => Promise<T>): Promise<T> => {
    try {
        return await call();
    } catch (error) {
        console.error(`Transfer, ${name}:`, error);
        throw new Error(`${name} failed: ${message(error)}`);
    }
};

const readFunctions = async (): Promise<BuildingFunction[]> => {
    try {
        return (await Forma.settings.get()).buildingFunctions;
    } catch (error) {
        console.warn('Building functions could not be read', error);
        return [];
    }
};

/**
 * Floor-stack elements of a building: the building itself or its direct
 * children, wherever Forma exposes a `graphBuilding` (floors with functions).
 */
const readFloorStacks = async (path: string): Promise<(FloorStack & { urn: string })[]> => {
    const { element, elements } = await Forma.elements.getByPath({ path, recursive: true });
    const carriers: { subPath: string; urn: string }[] = [];
    if (element.representations?.graphBuilding) carriers.push({ subPath: '', urn: element.urn });
    else {
        for (const child of element.children ?? []) {
            if (elements[child.urn]?.representations?.graphBuilding) carriers.push({ subPath: child.key, urn: child.urn });
        }
    }
    const out: (FloorStack & { urn: string })[] = [];
    for (const c of carriers) {
        const graph = (await Forma.elements.representations.graphBuilding({ urn: c.urn }))?.data as GraphBuilding | undefined;
        if (!graph?.levels?.length) continue;
        const { transform } = await Forma.elements.getWorldTransform({ path: c.subPath ? `${path}/${c.subPath}` : path });
        out.push({ subPath: c.subPath, transform: [...transform], graph, urn: c.urn });
    }
    return out;
};

const download = (name: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// -------------------------------------------------------------
// Preview, worked out from the file and the open proposal
// -------------------------------------------------------------
interface Rebuild {
    pair: BuildingPair;
    /** Path of the floor-stack element to replace. */
    path: string;
    graph: GraphBuilding;
    props: SpaceProps;
    copied: number;
}

interface Preview {
    file: TransferFile;
    shift: Shift;
    pairs: BuildingPair[];
    /** Source buildings with no match here, by index. */
    missing: number[];
    targetFunctions: BuildingFunction[];
    newFunctions: BuildingFunction[];
    rebuilds: Rebuild[];
    /** Matched buildings whose functions can't be copied, with the reason. */
    skipped: string[];
}

const label = (b: TransferBuilding) => b.name || `Building ${b.number}`;
/** The name sent to Forma: every mesh building refused with an empty 400 had a "#" in its name. */
const elementName = (b: TransferBuilding) => label(b).replace(/#/g, '').replace(/\s+/g, ' ').trim() || `Building ${b.number}`;

const buildPreview = async (file: TransferFile, buildings: TransferSource[], onStep: (text: string) => void): Promise<Preview> => {
    const { shift } = detectShift(file.buildings, buildings);
    const pairs = matchBuildings(file.buildings, buildings, shift);
    const matched = new Set(pairs.map((p) => p.source));
    const missing = file.buildings.map((_, i) => i).filter((i) => !matched.has(i));
    const targetFunctions = await readFunctions();
    const { missing: newFunctions } = planFunctions(file.buildingFunctions, targetFunctions);
    // Functions as they will be once the missing ones are added (their IDs are only known then).
    const afterFunctions = [...targetFunctions, ...newFunctions];
    const toTarget = (v: string | undefined) => mapFunction(v, file.buildingFunctions, afterFunctions);

    const rebuilds: Rebuild[] = [];
    const skipped: string[] = [];
    for (const [i, pair] of pairs.entries()) {
        const source = file.buildings[pair.source];
        if (source.floorStacks.length === 0) continue;
        onStep(`Reading floors ${i + 1} of ${pairs.length}…`);
        let stacks: Awaited<ReturnType<typeof readFloorStacks>>;
        try {
            stacks = await readFloorStacks(pair.target);
        } catch (error) {
            skipped.push(`${label(source)}: ${message(error)}`);
            continue;
        }
        if (stacks.length === 0) {
            skipped.push(`${label(source)}: the building here has no floor data, so its functions can't be set`);
            continue;
        }
        for (const { target, source: from } of pairStacks(source.floorStacks, stacks, shift)) {
            const { props, copied } = copySpaceFunctions(target, from, shift);
            // Compare with the mapping a name-only match would give, so functions not yet created still count as changes.
            const compare = (v: string | undefined) => toTarget(v) ?? v;
            if (copied === 0 || !functionsChange(target.graph, props, compare)) continue;
            rebuilds.push({
                pair, path: target.subPath ? `${pair.target}/${target.subPath}` : pair.target,
                graph: target.graph, props, copied,
            });
        }
    }
    return { file, shift, pairs, missing, targetFunctions, newFunctions, rebuilds, skipped };
};

// -------------------------------------------------------------
// Component
// -------------------------------------------------------------
export function TransferSection({ buildings, categories, assignments, canEdit, disabled, onCategories, onReload }: {
    buildings: TransferSource[];
    categories: Category[];
    assignments: Assignments;
    canEdit: boolean;
    disabled: boolean;
    onCategories: (categories: Category[], assignments: Assignments) => void;
    onReload: () => void;
}) {
    const [busy, setBusy] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [doCategories, setDoCategories] = useState(true);
    const [doFunctions, setDoFunctions] = useState(true);
    const [doRebuild, setDoRebuild] = useState(true);
    const [doCreate, setDoCreate] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    // ---- Export ----
    const exportFile = async () => {
        setBusy('Reading buildings…');
        setNote(null);
        setError(null);
        try {
            const buildingFunctions = await readFunctions();
            const out: TransferBuilding[] = [];
            let withFloors = 0, failed = 0;
            for (const [i, b] of buildings.entries()) {
                setBusy(`Reading building ${i + 1} of ${buildings.length}…`);
                const values: Record<string, string> = {};
                for (const c of categories) {
                    const v = c.values.find((x) => x.id === assignments[c.id]?.[b.path]);
                    if (v) values[c.name] = v.name;
                }
                let floorStacks: FloorStack[] = [];
                let name: string | undefined, functionId: string | undefined;
                try {
                    const { element } = await Forma.elements.getByPath({ path: b.path });
                    name = typeof element.properties?.name === 'string' ? element.properties.name : undefined;
                    functionId = typeof element.properties?.functionId === 'string' ? element.properties.functionId : undefined;
                    floorStacks = (await readFloorStacks(b.path)).map(({ urn: _urn, ...s }) => s);
                } catch (e) {
                    console.warn(`Could not read the element at ${b.path}`, e);
                    failed++;
                }
                if (floorStacks.length) withFloors++;
                const mesh = floorStacks.length ? undefined : encodeMesh(await Forma.geometry.getTriangles({ path: b.path }));
                out.push({
                    path: b.path, number: b.number, name, centre: b.centre, height: b.height,
                    footprintArea: b.footprintArea, values, floorStacks, functionId, mesh,
                });
            }
            const file: TransferFile = {
                format: TRANSFER_FORMAT, version: TRANSFER_VERSION, exportedAt: new Date().toISOString(),
                buildingFunctions, categories, buildings: out,
            };
            download(`forma-transfer-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(file));
            setNote(
                `Transfer file with ${plural(out.length, 'building')} created (${withFloors} with floor functions` +
                `${failed ? `, ${failed} could not be read` : ''}). Open the other project's matching proposal and import it there.`,
            );
        } catch (e) {
            console.error(e);
            setError(`Could not create the transfer file: ${message(e)}`);
        } finally {
            setBusy(null);
        }
    };

    // ---- Import: preview ----
    const onFileChosen = async (e: Event) => {
        const input = e.target as HTMLInputElement;
        const chosen = input.files?.[0];
        input.value = '';
        if (!chosen) return;
        setNote(null);
        setError(null);
        setPreview(null);
        const parsed = parseTransferFile(await chosen.text());
        if (!parsed.ok) {
            setError(parsed.error);
            return;
        }
        setBusy('Matching buildings…');
        try {
            setPreview(await buildPreview(parsed.file, buildings, setBusy));
        } catch (err) {
            console.error(err);
            setError(`Could not read this proposal: ${message(err)}`);
        } finally {
            setBusy(null);
        }
    };

    const categoryPlan = useMemo(
        () => preview && planCategoryTransfer(preview.file.categories, preview.file.buildings, preview.pairs, categories, assignments),
        [preview, categories, assignments],
    );

    // ---- Import: apply ----
    const apply = async () => {
        if (!preview) return;
        const { file, shift } = preview;
        const problems: string[] = [];
        const done: string[] = [];
        setError(null);
        try {
            // 1. Building functions the project lacks.
            let functions = preview.targetFunctions;
            if ((doFunctions || doRebuild || doCreate) && preview.newFunctions.length) {
                setBusy('Adding building functions…');
                let added = 0;
                for (const f of preview.newFunctions) {
                    try {
                        functions = (await Forma.settings.buildingFunctions.add({
                            name: f.name, ...(f.color ? { color: f.color as `#${string}` } : {}),
                        })).buildingFunctions;
                        added++;
                    } catch (e) {
                        problems.push(`Function "${f.name}": ${message(e)}`);
                    }
                }
                done.push(`${plural(added, 'building function')} added`);
            }
            const toTarget = (v: string | undefined) => mapFunction(v, file.buildingFunctions, functions);

            // 2. Functions onto matched buildings: rebuild each floor stack from its own floors, with the copied functions.
            if (doRebuild && preview.rebuilds.length) {
                let rebuilt = 0;
                for (const [i, r] of preview.rebuilds.entries()) {
                    setBusy(`Setting functions ${i + 1} of ${preview.rebuilds.length}…`);
                    try {
                        const { urn } = await step('creating the rebuilt building',
                            () => Forma.elements.floorStack.createFromFloors(graphToFloorStack(r.graph, r.props, toTarget)));
                        await step('swapping it in', () => Forma.elements.replace({ path: r.path, urn: urn as Urn }));
                        rebuilt++;
                    } catch (e) {
                        problems.push(`${label(file.buildings[r.pair.source])}: ${message(e)}`);
                    }
                }
                done.push(`functions set on ${plural(rebuilt, 'building')}`);
            }

            // 3. Buildings missing here.
            const created: { source: number; target: string }[] = [];
            const blocks: string[] = [];
            if (doCreate && preview.missing.length) {
                for (const [i, index] of preview.missing.entries()) {
                    const b = file.buildings[index];
                    setBusy(`Adding building ${i + 1} of ${preview.missing.length}…`);
                    let meshInfo = '';
                    try {
                        if (b.floorStacks.length) {
                            for (const stack of b.floorStacks) {
                                const { urn } = await step('creating the building from its floors', () => Forma.elements.floorStack.createFromFloors(
                                    graphToFloorStack(stack.graph, ownSpaceProps(stack.graph), toTarget),
                                ));
                                const { path } = await step('placing it', () => Forma.elements.add({
                                    urn: urn as Urn, transform: shifted(stack.transform as Matrix, shift), name: b.name,
                                }));
                                created.push({ source: index, target: path });
                            }
                        } else if (b.mesh) {
                            const world = decodeMesh(b.mesh);
                            let ox = Infinity, oy = Infinity, oz = Infinity;
                            for (let k = 0; k < world.length; k += 3) {
                                ox = Math.min(ox, world[k]); oy = Math.min(oy, world[k + 1]); oz = Math.min(oz, world[k + 2]);
                            }
                            const local = new Float32Array(world.length);
                            for (let k = 0; k < world.length; k += 3) {
                                local[k] = world[k] - ox; local[k + 1] = world[k + 1] - oy; local[k + 2] = world[k + 2] - oz;
                            }
                            let sx = 0, sy = 0, sz = 0;
                            for (let k = 0; k < world.length; k += 3) {
                                sx = Math.max(sx, world[k] - ox); sy = Math.max(sy, world[k + 1] - oy); sz = Math.max(sz, world[k + 2] - oz);
                            }
                            const finite = world.every(Number.isFinite);
                            // Shown with any failure below, to find what refused meshes have in common.
                            meshInfo = `${world.length / 9} triangles, ${(world.length * 8 / 1024).toFixed(0)} KB, ${sx.toFixed(1)} × ${sy.toFixed(1)} × ${sz.toFixed(1)} m${finite ? '' : ', NON-FINITE VALUES'}`;
                            const functionId = toTarget(b.functionId);
                            let path: string;
                            try {
                                const { blobId } = await step('uploading its shape', () => Forma.integrateElements.uploadFile({
                                    data: encodeGlb(local, { name: elementName(b), rgba: MESH_RGBA }),
                                }));
                                const { urn } = await step('creating the building element', () => Forma.integrateElements.createElementV2({
                                    properties: { name: elementName(b), category: BUILDING_CATEGORY, ...(functionId ? { functionId } : {}) },
                                    representations: { volumeMesh: { type: 'linked', blobId } },
                                }));
                                ({ path } = await step('placing it', () => Forma.elements.add({
                                    urn, name: elementName(b), transform: translationMatrix([ox + shift.x, oy + shift.y, oz]),
                                })));
                            } catch (meshError) {
                                // Forma refuses these meshes with an empty 400 (cause unknown), so rebuild the building as a plain block instead.
                                const block = meshToBlock(world, functionId);
                                if (!block) throw meshError;
                                console.warn('Transfer: mesh refused, adding a plain block instead', meshError);
                                const { urn } = await step('creating the block from its outline', () => Forma.elements.floorStack.createFromFloors(block.request));
                                ({ path } = await step('placing the block', () => Forma.elements.add({
                                    urn: urn as Urn, name: elementName(b),
                                    transform: translationMatrix([block.origin[0] + shift.x, block.origin[1] + shift.y, block.origin[2]]),
                                })));
                                blocks.push(label(b));
                            }
                            created.push({ source: index, target: path });
                        } else {
                            problems.push(`${label(b)}: the file has no geometry for it`);
                        }
                    } catch (e) {
                        problems.push(`${label(b)}: ${message(e)}${meshInfo ? ` [${meshInfo}]` : ''}`);
                    }
                }
                done.push(`${plural(new Set(created.map((c) => c.source)).size, 'building')} added`);
                if (blocks.length) problems.push(`${plural(blocks.length, 'building')} added as plain extruded blocks (Forma refused their meshes, so the roof shape is lost): ${blocks.join(', ')}`);
            }

            // 4. Categories, against the latest state, including buildings just added.
            if (doCategories) {
                const plan = planCategoryTransfer(file.categories, file.buildings, [...preview.pairs, ...created], categories, assignments);
                onCategories(plan.categories, plan.assignments);
                done.push(`categories set on ${plural(plan.changedBuildings, 'building')}`);
            }

            setPreview(null);
            setNote(`Done: ${done.join(', ') || 'nothing to change'}.${problems.length ? '' : ' Check the result in Forma.'}`);
            if (problems.length) setError(`Some changes failed:\n${problems.join('\n')}`);
            if (created.length || (doRebuild && preview.rebuilds.length)) onReload();
        } catch (e) {
            console.error(e);
            setError(`The transfer stopped part way: ${message(e)}${done.length ? ` (already done: ${done.join(', ')})` : ''}`);
        } finally {
            setBusy(null);
        }
    };

    const p = preview;
    const shiftText = p && (p.shift.x || p.shift.y)
        ? `This project's site is offset from the file's by ${p.shift.x.toFixed(1)} m east and ${p.shift.y.toFixed(1)} m north; matching allows for it.`
        : null;
    const notMatchedHere = p ? buildings.length - p.pairs.length : 0;
    const nothingChosen = !doCategories && !doFunctions && !doRebuild && !doCreate;

    return (
        <div class="section">
            <h3>Copy to another project</h3>
            <p class="help" style={{ marginTop: 0 }}>
                For moving work between projects, including other hubs. Export a transfer file from a proposal here,
                then open the matching proposal in the other project and import it. Buildings are matched by
                position. It carries your categories, Forma's building functions and, if you choose, buildings
                the other proposal lacks. Do one proposal at a time.
            </p>
            <div class="actions">
                <button onClick={exportFile} disabled={disabled || !!busy}>Export transfer file</button>
                {canEdit && (
                    <button class="button-ghost" onClick={() => fileInput.current?.click()} disabled={disabled || !!busy}>
                        Import transfer file…
                    </button>
                )}
                <input ref={fileInput} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onFileChosen} />
            </div>
            {busy && <p class="help" role="status">{busy}</p>}

            {p && categoryPlan && (
                <div class="import-preview">
                    <h3>Transfer preview</h3>
                    <ul>
                        <li>
                            <strong>{p.pairs.length} of {p.file.buildings.length}</strong> buildings in the file matched buildings here
                            {p.pairs.some((x) => x.differs) && ` (${p.pairs.filter((x) => x.differs).length} differ in height or footprint by over 5%)`}
                        </li>
                        {shiftText && <li>{shiftText}</li>}
                        {notMatchedHere > 0 && <li>{plural(notMatchedHere, 'building')} here not in the file are left alone</li>}
                        {p.skipped.length > 0 && (
                            <li>Functions can't be copied for {p.skipped.length}: {p.skipped.slice(0, 3).join('; ')}{p.skipped.length > 3 ? '…' : ''}</li>
                        )}
                    </ul>
                    <div class="transfer-options">
                        <label class="check">
                            <input type="checkbox" checked={doCategories} onChange={() => setDoCategories(!doCategories)} />
                            Categories: {plural(categoryPlan.changedBuildings, 'matched building')} {categoryPlan.changedBuildings === 1 ? 'changes' : 'change'}
                            {categoryPlan.newCategories.length > 0 && `, new: ${categoryPlan.newCategories.join(', ')}`}
                        </label>
                        <label class="check">
                            <input type="checkbox" checked={doFunctions} onChange={() => setDoFunctions(!doFunctions)} />
                            Add {plural(p.newFunctions.length, 'building function')} this project lacks
                            {p.newFunctions.length > 0 && ` (${p.newFunctions.map((f) => f.name).join(', ')})`}
                        </label>
                        <label class="check">
                            <input type="checkbox" checked={doRebuild} onChange={() => setDoRebuild(!doRebuild)} />
                            Set functions on {plural(p.rebuilds.length, 'matched building')}
                        </label>
                        <label class="check">
                            <input type="checkbox" checked={doCreate} onChange={() => setDoCreate(!doCreate)} />
                            Add {plural(p.missing.length, 'building')} from the file that {p.missing.length === 1 ? 'is' : 'are'} missing here
                        </label>
                    </div>
                    <p class="help">
                        Setting functions rebuilds each of those buildings from its own floors here, with the functions
                        copied, and swaps it in. Its shape and position stay the same, but other data on the element
                        (such as its name) may not carry over. Duplicate the proposal first if you want a fallback.
                        {doRebuild && p.newFunctions.length > 0 && !doFunctions && ' Missing functions are added anyway when they are needed.'}
                    </p>
                    <div class="row">
                        <button onClick={apply} disabled={!!busy || nothingChosen}>Apply transfer</button>
                        <button class="button-ghost" onClick={() => setPreview(null)} disabled={!!busy}>Cancel</button>
                    </div>
                </div>
            )}
            {note && <p class="help">{note}</p>}
            {error && <p class="help transfer-error" role="alert">{error}</p>}
            {!canEdit && <p class="help">Importing a transfer file needs edit access to this Forma project.</p>}
        </div>
    );
}
