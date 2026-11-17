import { readJson, writeJson } from './categories';
import { MAX_PRESETS, SavedPreset, sanitisePreset } from './presets';

// Saved render presets live in the Forma project's extension storage, next to the categories,
// so everyone working on the project sees the same list.
const PRESETS_KEY = 'render-presets.json';

/** Returns an empty list when nothing is saved yet; entries that fail validation are dropped. */
export const loadRenderPresets = async (): Promise<SavedPreset[]> => {
    const stored = await readJson(PRESETS_KEY) as { presets?: unknown } | undefined;
    if (!Array.isArray(stored?.presets)) return [];
    return stored.presets
        .map((p) => sanitisePreset(p))
        .filter((p): p is SavedPreset => p !== null)
        .slice(0, MAX_PRESETS);
};

export const saveRenderPresets = (presets: SavedPreset[]): Promise<void> =>
    writeJson(PRESETS_KEY, { version: 1, presets });
