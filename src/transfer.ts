import type { Assignments, Category, CategoryValue } from "./categories";
import { newId } from "./categories";

// =============================================================
// PROJECT TRANSFER (pure)
// Copies work from one Forma project to another through a file, because
// Forma cannot copy between hubs. Buildings are matched by position, since
// element paths differ in every project. Nothing here calls Forma.
// =============================================================

export const TRANSFER_FORMAT = 'as-forma-building-transfer';
export const TRANSFER_VERSION = 1;

/** Forma's built-in building function IDs, the same in every project. */
export const BUILT_IN_FUNCTIONS = new Set(['residential', 'commercial', 'unspecified']);

export interface BuildingFunction {
    id: string;
    name: string;
    color?: string;
}

/** Forma's `graphBuilding` representation (only the fields used here). */
export interface GraphBuilding {
    units: { id: string; properties: { function?: string; program?: string }; spaceIds: string[] }[];
    levels: {
        height: number;
        points: Record<string, [number, number] | undefined>;
        spaces: { id: string; outerLoop: CoSurface[]; innerLoops?: CoSurface[][] }[];
        surfaces: { id: string; pointA: string; pointB: string }[];
    }[];
}
interface CoSurface { surfaceId: string; directionAToB: boolean }

/** Column-major 4×4 affine matrix, as Forma uses. */
export type Matrix = number[];

/** One floor-stack element inside a building (the building itself, or one of its children). */
export interface FloorStack {
    /** Path of the element relative to the building path ('' for the building itself). */
    subPath: string;
    /** World transform of the element. */
    transform: Matrix;
    graph: GraphBuilding;
}

export interface TransferBuilding {
    path: string;
    number: number;
    name?: string;
    /** Bounding-box centre in world coordinates. */
    centre: { x: number; y: number; z: number };
    height: number;
    footprintArea: number;
    /** Category name → value name (unassigned categories are left out). */
    values: Record<string, string>;
    /** Floor data with building functions, when Forma exposes it. */
    floorStacks: FloorStack[];
    /** Element-level function, used by some imported buildings. */
    functionId?: string;
    /** World-space triangles, base64 Float32, kept only for buildings with no floor data. */
    mesh?: string;
}

export interface TransferFile {
    format: typeof TRANSFER_FORMAT;
    version: number;
    exportedAt: string;
    proposalName?: string;
    buildingFunctions: BuildingFunction[];
    categories: Category[];
    buildings: TransferBuilding[];
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads a transfer file, or explains why it can't. */
export const parseTransferFile = (text: string): { ok: true; file: TransferFile } | { ok: false; error: string } => {
    let json: unknown;
    try {
        json = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
        return { ok: false, error: 'This is not a transfer file (it is not valid JSON).' };
    }
    if (!isObj(json) || json.format !== TRANSFER_FORMAT) {
        return { ok: false, error: 'This is not a transfer file from this panel. Export one with "Export transfer file" in the other project.' };
    }
    if (!isNum(json.version) || json.version > TRANSFER_VERSION) {
        return { ok: false, error: 'This transfer file was made by a newer version of the panel. Reload the panel and try again.' };
    }
    const buildings = Array.isArray(json.buildings) ? json.buildings.filter((b: any) =>
        isObj(b) && typeof b.path === 'string' && isObj(b.centre) && isNum(b.centre.x) && isNum(b.centre.y) && isNum(b.height)) : [];
    if (buildings.length === 0) return { ok: false, error: 'The transfer file has no buildings.' };
    return {
        ok: true,
        file: {
            format: TRANSFER_FORMAT,
            version: json.version,
            exportedAt: typeof json.exportedAt === 'string' ? json.exportedAt : '',
            proposalName: typeof json.proposalName === 'string' ? json.proposalName : undefined,
            buildingFunctions: Array.isArray(json.buildingFunctions)
                ? json.buildingFunctions.filter((f: any) => typeof f?.id === 'string' && typeof f?.name === 'string')
                : [],
            categories: Array.isArray(json.categories)
                ? json.categories.filter((c: any) => typeof c?.name === 'string' && Array.isArray(c?.values))
                : [],
            buildings: buildings.map((b: any): TransferBuilding => ({
                path: b.path,
                number: isNum(b.number) ? b.number : 0,
                name: typeof b.name === 'string' ? b.name : undefined,
                centre: { x: b.centre.x, y: b.centre.y, z: isNum(b.centre.z) ? b.centre.z : 0 },
                height: b.height,
                footprintArea: isNum(b.footprintArea) ? b.footprintArea : 0,
                values: isObj(b.values) ? b.values : {},
                floorStacks: Array.isArray(b.floorStacks)
                    ? b.floorStacks.filter((s: any) => isObj(s) && Array.isArray(s.transform) && isObj(s.graph) && Array.isArray(s.graph.levels))
                    : [],
                functionId: typeof b.functionId === 'string' ? b.functionId : undefined,
                mesh: typeof b.mesh === 'string' ? b.mesh : undefined,
            })),
        },
    };
};

// -------------------------------------------------------------
// Matching buildings by position
// -------------------------------------------------------------
export interface Placed {
    path: string;
    centre: { x: number; y: number; z: number };
    height: number;
    footprintArea: number;
}

export interface Shift { x: number; y: number }

export interface BuildingPair {
    source: number;
    target: string;
    distance: number;
    /** Height or footprint differs by more than 5%: matched, but worth checking. */
    differs: boolean;
}

/** Buildings closer than this (m, between bounding-box centres, after the shift) count as the same. */
export const MATCH_TOLERANCE = 3;

const similar = (a: Placed, b: Placed) =>
    Math.abs(a.height - b.height) <= Math.max(0.5, 0.02 * a.height) &&
    Math.abs(a.footprintArea - b.footprintArea) <= Math.max(2, 0.05 * a.footprintArea);

const differs = (a: Placed, b: Placed) =>
    Math.abs(a.height - b.height) > 0.05 * Math.max(a.height, 1) ||
    Math.abs(a.footprintArea - b.footprintArea) > 0.05 * Math.max(a.footprintArea, 1);

/** One-to-one pairs, closest first, after moving the source by `shift`. */
export const matchBuildings = (source: Placed[], target: Placed[], shift: Shift, tolerance = MATCH_TOLERANCE): BuildingPair[] => {
    const candidates: { s: number; t: number; d: number }[] = [];
    source.forEach((s, si) => target.forEach((t, ti) => {
        const d = Math.hypot(s.centre.x + shift.x - t.centre.x, s.centre.y + shift.y - t.centre.y);
        if (d <= tolerance) candidates.push({ s: si, t: ti, d });
    }));
    candidates.sort((a, b) => a.d - b.d);
    const usedS = new Set<number>(), usedT = new Set<number>();
    const pairs: BuildingPair[] = [];
    for (const c of candidates) {
        if (usedS.has(c.s) || usedT.has(c.t)) continue;
        usedS.add(c.s);
        usedT.add(c.t);
        pairs.push({ source: c.s, target: target[c.t].path, distance: c.d, differs: differs(source[c.s], target[c.t]) });
    }
    return pairs.sort((a, b) => a.source - b.source);
};

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Finds a horizontal offset between the two projects, for when their reference
 * points differ. Each pair of similar buildings (height and footprint) proposes
 * an offset; the one that lines up the most buildings wins. No shift is kept
 * unless an offset matches more buildings than no shift does.
 */
export const detectShift = (source: Placed[], target: Placed[]): { shift: Shift; matched: number } => {
    const count = (shift: Shift) => matchBuildings(source, target, shift).length;
    let best = { shift: { x: 0, y: 0 }, matched: count({ x: 0, y: 0 }) };
    if (best.matched === source.length) return best;
    const tried = new Set<string>();
    let tries = 0;
    for (const s of source) {
        for (const t of target) {
            if (!similar(s, t)) continue;
            const shift = { x: t.centre.x - s.centre.x, y: t.centre.y - s.centre.y };
            const key = `${Math.round(shift.x)},${Math.round(shift.y)}`;
            if (tried.has(key) || ++tries > 500) continue;
            tried.add(key);
            const matched = count(shift);
            if (matched > best.matched) best = { shift, matched };
        }
    }
    if (best.shift.x === 0 && best.shift.y === 0) return best;
    // Refine with the median residual of the matched pairs, so one slightly moved building doesn't set the offset.
    const pairs = matchBuildings(source, target, best.shift);
    const byPath = new Map(target.map((t) => [t.path, t]));
    const refined = {
        x: median(pairs.map((p) => byPath.get(p.target)!.centre.x - source[p.source].centre.x)),
        y: median(pairs.map((p) => byPath.get(p.target)!.centre.y - source[p.source].centre.y)),
    };
    const matched = count(refined);
    return matched >= best.matched ? { shift: refined, matched } : best;
};

// -------------------------------------------------------------
// Categories
// -------------------------------------------------------------
const norm = (s: string) => s.trim().toLowerCase();

export interface CategoryTransfer {
    categories: Category[];
    assignments: Assignments;
    changedBuildings: number;
    newCategories: string[];
    newValues: string[];
}

/**
 * Adds the source's categories and values that the target lacks (matched by
 * name, keeping the source colours), then sets each paired building's values.
 * A category left unassigned in the source leaves the target's value alone.
 */
export const planCategoryTransfer = (
    sourceCategories: Category[], sourceBuildings: { values: Record<string, string> }[],
    pairs: { source: number; target: string }[], categories: Category[], assignments: Assignments,
): CategoryTransfer => {
    const next: Category[] = categories.map((c) => ({ ...c, values: [...c.values] }));
    const newCategories: string[] = [];
    const newValues: string[] = [];
    const findCategory = (name: string) => next.find((c) => norm(c.name) === norm(name));
    const ensureValue = (category: Category, name: string, color?: string): CategoryValue => {
        let value = category.values.find((v) => norm(v.name) === norm(name));
        if (!value) {
            value = { id: newId(), name, color: color ?? '#c8c8c8' };
            category.values.push(value);
            if (!newCategories.includes(category.name)) newValues.push(`${category.name}: ${name}`);
        }
        return value;
    };
    for (const sc of sourceCategories) {
        let category = findCategory(sc.name);
        if (!category) {
            category = { id: newId(), name: sc.name, values: [] };
            next.push(category);
            newCategories.push(sc.name);
        }
        for (const v of sc.values) if (typeof v?.name === 'string') ensureValue(category, v.name, v.color);
    }

    const nextAssignments: Assignments = { ...assignments };
    const changed = new Set<string>();
    for (const pair of pairs) {
        for (const [categoryName, valueName] of Object.entries(sourceBuildings[pair.source]?.values ?? {})) {
            if (typeof valueName !== 'string' || !valueName.trim()) continue;
            let category = findCategory(categoryName);
            if (!category) {
                category = { id: newId(), name: categoryName, values: [] };
                next.push(category);
                newCategories.push(categoryName);
            }
            const value = ensureValue(category, valueName);
            if (nextAssignments[category.id]?.[pair.target] === value.id) continue;
            nextAssignments[category.id] = { ...(nextAssignments[category.id] ?? {}), [pair.target]: value.id };
            changed.add(pair.target);
        }
    }
    return { categories: next, assignments: nextAssignments, changedBuildings: changed.size, newCategories, newValues };
};

// -------------------------------------------------------------
// Building functions
// -------------------------------------------------------------
/** Source functions the target doesn't have (by name), and the ID map for those it does. */
export const planFunctions = (source: BuildingFunction[], target: BuildingFunction[]) => {
    const missing: BuildingFunction[] = [];
    const map = new Map<string, string>();
    for (const id of BUILT_IN_FUNCTIONS) map.set(id, id);
    for (const f of source) {
        if (BUILT_IN_FUNCTIONS.has(f.id)) continue;
        const existing = target.find((t) => norm(t.name) === norm(f.name));
        if (existing) map.set(f.id, existing.id);
        else missing.push(f);
    }
    return { missing, map };
};

/** Maps a function as stored in the source (an ID, or sometimes a name) to a target function ID. */
export const mapFunction = (
    value: string | undefined, sourceFunctions: BuildingFunction[], targetFunctions: BuildingFunction[],
): string | undefined => {
    if (!value) return undefined;
    const source = sourceFunctions.find((f) => f.id === value) ?? sourceFunctions.find((f) => norm(f.name) === norm(value));
    const name = source?.name ?? value;
    if (BUILT_IN_FUNCTIONS.has(source?.id ?? value)) return source?.id ?? value;
    return targetFunctions.find((f) => norm(f.name) === norm(name))?.id
        ?? targetFunctions.find((f) => f.id === value)?.id;
};

// -------------------------------------------------------------
// Floor stacks: geometry helpers
// -------------------------------------------------------------
type Pt = [number, number];

const apply = (m: Matrix, [x, y]: Pt, shift: Shift = { x: 0, y: 0 }): Pt =>
    [m[0] * x + m[4] * y + m[12] + shift.x, m[1] * x + m[5] * y + m[13] + shift.y];

const signedArea = (pts: Pt[]) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
};

const centroid = (pts: Pt[]): Pt => {
    const a = signedArea(pts);
    if (Math.abs(a) < 1e-9) {
        return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    }
    let cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        const f = x1 * y2 - x2 * y1;
        cx += (x1 + x2) * f;
        cy += (y1 + y2) * f;
    }
    return [cx / (6 * a), cy / (6 * a)];
};

const inside = ([x, y]: Pt, pts: Pt[]) => {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
};

/** Point IDs around a loop, in order. */
const loopIds = (loop: CoSurface[], surfaces: Map<string, { pointA: string; pointB: string }>): string[] =>
    loop.map((c) => {
        const s = surfaces.get(c.surfaceId);
        return s ? (c.directionAToB ? s.pointA : s.pointB) : '';
    }).filter(Boolean);

/** Each space with its outline in world coordinates, level elevations and the unit properties it belongs to. */
const describe = (stack: { graph: GraphBuilding; transform: Matrix }, shift?: Shift) => {
    const props = new Map<string, { function?: string; program?: string }>();
    for (const u of stack.graph.units ?? []) for (const id of u.spaceIds ?? []) props.set(id, u.properties ?? {});
    let base = stack.transform[14] ?? 0;
    return stack.graph.levels.map((level) => {
        const surfaces = new Map(level.surfaces.map((s) => [s.id, s]));
        const spaces = level.spaces.map((space) => {
            const ids = loopIds(space.outerLoop, surfaces);
            const world = ids.map((id) => level.points[id]).filter((p): p is Pt => !!p).map((p) => apply(stack.transform, p, shift));
            return { id: space.id, world, props: props.get(space.id) ?? {} };
        });
        const out = { bottom: base, top: base + level.height, spaces };
        base += level.height;
        return out;
    });
};

/** Horizontal centre of a floor stack's ground level, for pairing stacks within a building. */
const stackCentre = (stack: { graph: GraphBuilding; transform: Matrix }, shift?: Shift): Pt => {
    const pts = describe(stack, shift)[0]?.spaces.flatMap((s) => s.world) ?? [];
    if (pts.length === 0) return apply(stack.transform, [0, 0], shift);
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
};

/** Pairs each target floor stack with the nearest source floor stack (by ground-level centre). */
export const pairStacks = <T extends { graph: GraphBuilding; transform: Matrix }>(
    source: { graph: GraphBuilding; transform: Matrix }[], target: T[], shift: Shift,
): { target: T; source: { graph: GraphBuilding; transform: Matrix } }[] => {
    if (source.length === 0) return [];
    const sourceCentres = source.map((s) => stackCentre(s, shift));
    return target.map((t) => {
        const c = stackCentre(t);
        let best = 0, bestD = Infinity;
        sourceCentres.forEach((sc, i) => {
            const d = Math.hypot(sc[0] - c[0], sc[1] - c[1]);
            if (d < bestD) { bestD = d; best = i; }
        });
        return { target: t, source: source[best] };
    });
};

/** Function (and programme) for each target space, keyed by space ID. */
export type SpaceProps = Map<string, { function?: string; program?: string }>;

/**
 * Takes each target space's function from the source space under its centre
 * (same storey, found by elevation). Spaces with no source space under them
 * keep their own function. Functions stay as source values here; they are
 * mapped to target IDs when the floors are built.
 */
export const copySpaceFunctions = (
    target: { graph: GraphBuilding; transform: Matrix },
    source: { graph: GraphBuilding; transform: Matrix },
    shift: Shift,
): { props: SpaceProps; copied: number; kept: number } => {
    const s = describe(source, shift);
    const t = describe(target);
    const props: SpaceProps = new Map();
    let copied = 0, kept = 0;
    t.forEach((level, index) => {
        const mid = (level.bottom + level.top) / 2;
        const sourceLevel = s.find((l) => mid >= l.bottom - 0.5 && mid <= l.top + 0.5)
            ?? (s.length === t.length ? s[index] : undefined);
        for (const space of level.spaces) {
            const c = space.world.length ? centroid(space.world) : undefined;
            const from = c && sourceLevel?.spaces.find((sp) => sp.world.length > 2 && inside(c, sp.world));
            if (from) {
                props.set(space.id, { ...space.props, function: from.props.function, program: from.props.program ?? space.props.program });
                copied++;
            } else {
                props.set(space.id, space.props);
                kept++;
            }
        }
    });
    return { props, copied, kept };
};

/** Space properties as the graph itself stores them. */
export const ownSpaceProps = (graph: GraphBuilding): SpaceProps => {
    const props: SpaceProps = new Map();
    for (const u of graph.units ?? []) for (const id of u.spaceIds ?? []) props.set(id, u.properties ?? {});
    return props;
};

const PROGRAMS = new Set(['CORE', 'CORRIDOR', 'LIVING_UNIT', 'PARKING']);

export interface FloorStackRequest {
    floors: { planId: string; height: number }[];
    plans: {
        id: string;
        vertices: { id: string; x: number; y: number }[];
        units: { polygon: string[]; program?: 'CORE' | 'CORRIDOR' | 'LIVING_UNIT' | 'PARKING'; functionId?: string; holes: string[][] }[];
    }[];
}

/** Forma's rule for plan and vertex IDs in `createFromFloors` (checked by the server). */
export const FLOOR_STACK_ID = /^[a-zA-Z0-9-]{2,20}$/;

/**
 * Converts a graph building into the floors and plans that
 * `Forma.elements.floorStack.createFromFloors` takes, in the element's own
 * coordinates. Each space becomes a unit; loops are wound counter-clockwise
 * as the SDK asks (for holes too). `toFunctionId` maps stored functions to
 * the target project's IDs.
 *
 * Forma's own point IDs can't be passed on (they break the ID rule above), so
 * each vertex is renumbered "v0", "v1"… with numbers unique across all plans
 * of the building (Forma rejects a repeat in another plan), merging points
 * within one plan that sit at the same place (to 0.1 mm). Repeated points in a loop are dropped, and loops
 * left with fewer than three points are skipped.
 */
export const graphToFloorStack = (
    graph: GraphBuilding, props: SpaceProps, toFunctionId: (value: string | undefined) => string | undefined,
): FloorStackRequest => {
    const floors: FloorStackRequest['floors'] = [];
    const plans: FloorStackRequest['plans'] = [];
    // Forma needs vertex IDs unique across the whole building, not just per plan.
    let nextVertex = 0;
    graph.levels.forEach((level, index) => {
        const id = `plan-${index}`;
        const surfaces = new Map(level.surfaces.map((s) => [s.id, s]));
        const vertices: FloorStackRequest['plans'][number]['vertices'] = [];
        const byPlace = new Map<string, string>();
        const vertexAt = ([x, y]: Pt) => {
            const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
            let v = byPlace.get(key);
            if (!v) {
                v = `v${nextVertex++}`;
                byPlace.set(key, v);
                vertices.push({ id: v, x, y });
            }
            return v;
        };
        const loop = (pointIds: string[]): string[] => {
            const pts = pointIds.map((p) => level.points[p]).filter((p): p is Pt => !!p);
            const ids: string[] = [];
            const kept: Pt[] = [];
            for (const p of pts) {
                const v = vertexAt(p);
                if (ids[ids.length - 1] !== v) { ids.push(v); kept.push(p); }
            }
            while (ids.length > 1 && ids[0] === ids[ids.length - 1]) { ids.pop(); kept.pop(); }
            if (new Set(ids).size < 3) return [];
            return signedArea(kept) < 0 ? ids.reverse() : ids;
        };
        const units = level.spaces.map((space) => {
            const p = props.get(space.id) ?? {};
            const program = p.program?.toUpperCase();
            const functionId = toFunctionId(p.function);
            return {
                polygon: loop(loopIds(space.outerLoop, surfaces)),
                holes: (space.innerLoops ?? []).map((l) => loop(loopIds(l, surfaces))).filter((h) => h.length >= 3),
                ...(program && PROGRAMS.has(program) ? { program: program as 'CORE' } : {}),
                ...(functionId ? { functionId } : {}),
            };
        }).filter((u) => u.polygon.length >= 3);
        // Only vertices a kept loop uses (a skipped loop may have added some).
        const used = new Set(units.flatMap((u) => [...u.polygon, ...u.holes.flat()]));
        plans.push({ id, vertices: vertices.filter((v) => used.has(v.id)), units });
        floors.push({ planId: id, height: level.height });
    });
    return { floors, plans };
};

/** Whether rebuilding would change any space's function. */
export const functionsChange = (graph: GraphBuilding, props: SpaceProps, toFunctionId: (v: string | undefined) => string | undefined) => {
    const own = ownSpaceProps(graph);
    return graph.levels.some((l) => l.spaces.some((s) => toFunctionId(props.get(s.id)?.function) !== own.get(s.id)?.function));
};

/** A world transform moved by `shift`. */
export const shifted = (m: Matrix, shift: Shift): Matrix => {
    const out = [...m];
    out[12] = (out[12] ?? 0) + shift.x;
    out[13] = (out[13] ?? 0) + shift.y;
    return out;
};

// -------------------------------------------------------------
// Mesh encoding (for buildings with no floor data)
// -------------------------------------------------------------
export const encodeMesh = (positions: Float32Array): string => {
    const bytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
};

export const decodeMesh = (text: string): Float32Array => {
    const s = atob(text);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
};

// -------------------------------------------------------------
// Mesh → plain block (fallback for buildings Forma refuses as meshes)
// -------------------------------------------------------------
export interface MeshBlock {
    /** World position of the block's local origin (lowest corner of its bounding box). */
    origin: [number, number, number];
    request: FloorStackRequest;
    floors: number;
}

/**
 * Rebuilds a building as an extruded block: traces the outline of the mesh's
 * lowest faces, then stacks floors of about `storey` m up to the mesh's height.
 * The roof shape is lost. Returns null when no outline can be found.
 */
export const meshToBlock = (world: ArrayLike<number>, functionId?: string, storey = 3.5): MeshBlock | null => {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < world.length; i += 3) {
        minX = Math.min(minX, world[i]); minY = Math.min(minY, world[i + 1]);
        minZ = Math.min(minZ, world[i + 2]); maxZ = Math.max(maxZ, world[i + 2]);
    }
    const height = maxZ - minZ;
    if (!(height > 0.5)) return null;
    // The outline is the bottom edge of each wall (a near-vertical face with two corners on the lowest level), so
    // it works whether or not the mesh has a floor. Without any walls, use the edges of the floor faces instead.
    const key = (x: number, y: number) => `${Math.round(x * 1e3)},${Math.round(y * 1e3)}`;
    const point = new Map<string, Pt>();
    const edges = new Map<string, [string, string]>();
    const uses = new Map<string, number>();
    const addEdge = (a: string, b: string, count: number) => {
        if (a === b) return;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        uses.set(k, (uses.get(k) ?? 0) + count);
        edges.set(k, [a, b]);
    };
    const low = (z: number) => z - minZ <= 0.05;
    const corner = (t: number, k: number) => {
        const id = key(world[t + k], world[t + k + 1]);
        point.set(id, [world[t + k] - minX, world[t + k + 1] - minY]);
        return id;
    };
    const floorEdges: [string, string][] = [];
    for (let t = 0; t + 8 < world.length; t += 9) {
        const [ux, uy, uz] = [world[t + 3] - world[t], world[t + 4] - world[t + 1], world[t + 5] - world[t + 2]];
        const [vx, vy, vz] = [world[t + 6] - world[t], world[t + 7] - world[t + 1], world[t + 8] - world[t + 2]];
        const n = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) || 1;
        const nz = Math.abs(ux * vy - uy * vx) / n;
        const lowCorners = [0, 1, 2].filter((c) => low(world[t + c * 3 + 2]));
        if (nz < 0.2 && lowCorners.length === 2) {
            addEdge(corner(t, lowCorners[0] * 3), corner(t, lowCorners[1] * 3), 1);
        } else if (lowCorners.length === 3) {
            const ids = [0, 3, 6].map((k) => corner(t, k));
            for (let e = 0; e < 3; e++) floorEdges.push([ids[e], ids[(e + 1) % 3]]);
        }
    }
    if (!uses.size) for (const [a, b] of floorEdges) addEdge(a, b, 1); // an edge shared by two floor faces is used twice, so drops out
    const next = new Map<string, string[]>();
    for (const [k, n] of uses) if (n === 1) {
        const [a, b] = edges.get(k)!;
        (next.get(a) ?? next.set(a, []).get(a)!).push(b);
        (next.get(b) ?? next.set(b, []).get(b)!).push(a);
    }
    // Walk the outline edges into closed loops.
    const seen = new Set<string>();
    const loops: Pt[][] = [];
    for (const start of next.keys()) {
        if (seen.has(start)) continue;
        const ids = [start];
        seen.add(start);
        let cur = start;
        for (;;) {
            const n = (next.get(cur) ?? []).find((c) => !seen.has(c));
            if (!n) break;
            ids.push(n); seen.add(n); cur = n;
        }
        const pts = ids.map((id) => point.get(id)!);
        // Drop points on a straight line.
        const keep = pts.filter((p, i) => {
            const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
            return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > 1e-3;
        });
        if (keep.length >= 3 && Math.abs(signedArea(keep)) > 1) loops.push(keep);
    }
    if (!loops.length) return null;
    loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    const vertices: FloorStackRequest['plans'][number]['vertices'] = [];
    const ring = (pts: Pt[]) => {
        const ordered = signedArea(pts) < 0 ? [...pts].reverse() : pts;
        return ordered.map(([x, y]) => { const id = `v${vertices.length}`; vertices.push({ id, x, y }); return id; });
    };
    const polygon = ring(loops[0]);
    const holes = loops.slice(1).map(ring);
    const floors = Math.max(1, Math.round(height / storey));
    return {
        origin: [minX, minY, minZ],
        floors,
        request: {
            floors: Array.from({ length: floors }, () => ({ planId: 'plan-0', height: height / floors })),
            plans: [{ id: 'plan-0', vertices, units: [{ polygon, holes, ...(functionId ? { functionId } : {}) }] }],
        },
    };
};
