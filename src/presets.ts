// Saved render presets: the data model, validation and file format. Pure functions, no Forma calls.
//
// A preset stores the *look* of a render (colours, lines, light). Output settings (transparent
// background, how context is drawn, shadow strength) belong to a particular export, so a preset
// neither saves nor changes them.

import type { RenderStyle } from './panelRender';

export type LookStyle = Omit<RenderStyle, 'transparent' | 'contextMode' | 'shadowOpacity'>;

export interface SavedPreset {
    id: string;
    name: string;
    look: LookStyle;
    /** ISO timestamp of the last save. */
    saved: string;
}

export const MAX_PRESETS = 50;
export const MAX_NAME_LENGTH = 60;

const HEX = /^#[0-9a-f]{6}$/i;
const colour = (v: unknown): string | null => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);
const bounded = (v: unknown, min: number, max: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;

/** Checks and clamps a look read from storage or a file. Returns null if anything essential is wrong. */
export const sanitiseLook = (raw: any): LookStyle | null => {
    if (!raw || typeof raw !== 'object') return null;
    const background = colour(raw.background);
    const contextColour = colour(raw.contextColour);
    const lineColour = colour(raw.lineColour);
    const buildingColour = raw.buildingColour === null ? null : colour(raw.buildingColour);
    const lineWeight = bounded(raw.lineWeight, 0.01, 20);
    const silhouetteWeight = bounded(raw.silhouetteWeight, 0.01, 20);
    const depthWeight = bounded(raw.depthWeight, 0, 1);
    const ambient = bounded(raw.ambient, 0, 1.5);
    const sunIntensity = bounded(raw.sunIntensity, 0, 1.5);
    if (
        !background || !contextColour || !lineColour ||
        (raw.buildingColour !== null && !buildingColour) ||
        lineWeight === null || silhouetteWeight === null || depthWeight === null ||
        ambient === null || sunIntensity === null ||
        typeof raw.silhouettes !== 'boolean' || typeof raw.shadows !== 'boolean'
    ) return null;
    return {
        background, buildingColour, contextColour, lineColour, lineWeight,
        silhouettes: raw.silhouettes, silhouetteWeight, depthWeight, ambient, sunIntensity, shadows: raw.shadows,
    };
};

export const cleanName = (name: unknown): string =>
    typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH) : '';

export const sanitisePreset = (raw: any, makeId: () => string = () => Math.random().toString(36).slice(2, 10)): SavedPreset | null => {
    const name = cleanName(raw?.name);
    const look = sanitiseLook(raw?.look);
    if (!name || !look) return null;
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : makeId(),
        name,
        look,
        saved: typeof raw.saved === 'string' ? raw.saved : new Date(0).toISOString(),
    };
};

export const toLook = (style: RenderStyle): LookStyle => ({
    background: style.background, buildingColour: style.buildingColour, contextColour: style.contextColour,
    lineColour: style.lineColour, lineWeight: style.lineWeight, silhouettes: style.silhouettes,
    silhouetteWeight: style.silhouetteWeight, depthWeight: style.depthWeight, ambient: style.ambient,
    sunIntensity: style.sunIntensity, shadows: style.shadows,
});

/** Applies a look while keeping the current export settings. */
export const withLook = (current: RenderStyle, look: LookStyle): RenderStyle => ({
    ...look,
    transparent: current.transparent,
    contextMode: current.contextMode,
    shadowOpacity: current.shadowOpacity,
});

export const nameTaken = (name: string, presets: SavedPreset[]): boolean =>
    presets.some((p) => p.name.toLowerCase() === cleanName(name).toLowerCase());

/** `name`, or `name (2)`, `name (3)`… when it is already used (compared ignoring case). */
export const uniqueName = (name: string, taken: string[]): string => {
    const base = cleanName(name) || 'Preset';
    const used = new Set(taken.map((n) => n.toLowerCase()));
    if (!used.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
        const candidate = `${base.slice(0, MAX_NAME_LENGTH - 6)} (${i})`;
        if (!used.has(candidate.toLowerCase())) return candidate;
    }
};

export const serialisePresets = (presets: SavedPreset[]): string =>
    JSON.stringify({ app: 'forma-render-presets', version: 1, presets }, null, 2);

/** Reads a presets file. Returns null when it is not valid JSON of the right shape. */
export const parsePresetFile = (text: string): { presets: SavedPreset[]; skipped: number } | null => {
    let data: any;
    try { data = JSON.parse(text); } catch { return null; }
    const list = Array.isArray(data) ? data : Array.isArray(data?.presets) ? data.presets : null;
    if (!list) return null;
    const presets: SavedPreset[] = [];
    let skipped = 0;
    for (const item of list) {
        const preset = sanitisePreset(item);
        if (preset) presets.push(preset); else skipped++;
    }
    return { presets, skipped };
};

/**
 * Adds imported presets after the existing ones. Existing presets are never replaced: an imported
 * preset whose name is taken is renamed "Name (2)" and every imported preset gets a fresh id.
 */
export const mergeImported = (
    existing: SavedPreset[], incoming: SavedPreset[], makeId: () => string,
): { presets: SavedPreset[]; added: number; renamed: number; dropped: number } => {
    const presets = [...existing];
    let added = 0, renamed = 0, dropped = 0;
    for (const item of incoming) {
        if (presets.length >= MAX_PRESETS) { dropped++; continue; }
        const name = uniqueName(item.name, presets.map((p) => p.name));
        if (name !== item.name) renamed++;
        presets.push({ ...item, id: makeId(), name });
        added++;
    }
    return { presets, added, renamed, dropped };
};
