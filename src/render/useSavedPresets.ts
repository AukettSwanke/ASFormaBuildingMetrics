// Saved render presets: kept in the Forma project (shared by everyone working on it), saved, updated,
// deleted, and moved between projects as a JSON file. The rules live in ../presets.ts.

import { useEffect, useState } from 'preact/hooks';
import type { RenderStyle } from '../panelRender';
import { newId } from '../categories';
import {
    MAX_PRESETS, SavedPreset, cleanName, mergeImported, nameTaken, parsePresetFile, serialisePresets, toLook,
} from '../presets';
import { loadRenderPresets, saveRenderPresets } from '../presetStorage';
import { downloadBlob } from './shared';

/** How long a Delete click stays armed waiting for the confirming click. */
const CONFIRM_MS = 4000;

export const savedKey = (id: string) => `saved:${id}`;

export function useSavedPresets({ style, presetName, setPresetName }: {
    style: RenderStyle | null;
    /** Key of the preset shown as chosen: a built-in name, or `saved:<id>`. */
    presetName: string;
    setPresetName: (key: string) => void;
}) {
    const [saved, setSaved] = useState<SavedPreset[]>([]);
    const [newName, setNewName] = useState('');
    const [message, setMessage] = useState<string | null>(null);
    /** Preset whose Delete button has been clicked once. */
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    useEffect(() => {
        loadRenderPresets()
            .then(setSaved)
            .catch((error) => {
                console.error(error);
                setMessage('Saved presets could not be loaded from the Forma project.');
            });
    }, []);

    /** Stores the list in the project; on failure the list on screen is kept and the user is told. */
    const persist = async (next: SavedPreset[], success: string) => {
        setSaved(next);
        try {
            await saveRenderPresets(next);
            setMessage(success);
        } catch (error) {
            console.error(error);
            setMessage('Could not save to the Forma project. The change will be lost when the panel closes.');
        }
    };

    const canSave = !!cleanName(newName) && !nameTaken(newName, saved) && saved.length < MAX_PRESETS;

    const save = async () => {
        const name = cleanName(newName);
        if (!style || !canSave) return;
        const preset: SavedPreset = { id: newId(), name, look: toLook(style), saved: new Date().toISOString() };
        setPresetName(savedKey(preset.id));
        setNewName('');
        await persist([...saved, preset], `Saved "${name}".`);
    };

    const update = async (id: string) => {
        if (!style) return;
        const target = saved.find((p) => p.id === id);
        if (!target) return;
        await persist(
            saved.map((p) => (p.id === id ? { ...p, look: toLook(style), saved: new Date().toISOString() } : p)),
            `Updated "${target.name}" with the current look.`,
        );
    };

    /** Two clicks: the first arms the button, the second deletes. */
    const remove = async (id: string) => {
        const target = saved.find((p) => p.id === id);
        if (!target) return;
        if (confirmDelete !== id) {
            setConfirmDelete(id);
            setTimeout(() => setConfirmDelete((current) => (current === id ? null : current)), CONFIRM_MS);
            return;
        }
        setConfirmDelete(null);
        if (presetName === savedKey(id)) setPresetName('');
        await persist(saved.filter((p) => p.id !== id), `Deleted "${target.name}".`);
    };

    const exportFile = () => {
        downloadBlob(new Blob([serialisePresets(saved)], { type: 'application/json' }), 'forma-render-presets.json');
        setMessage(`Exported ${saved.length} preset${saved.length === 1 ? '' : 's'}.`);
    };

    /** Adds the presets in a chosen file; existing presets are never replaced. */
    const importFile = async (event: Event) => {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = ''; // lets the same file be chosen again
        if (!file) return;
        const parsed = parsePresetFile(await file.text());
        if (!parsed) { setMessage('That file is not a presets file.'); return; }
        const merged = mergeImported(saved, parsed.presets, newId);
        if (merged.added === 0) {
            setMessage(parsed.skipped > 0 ? `Nothing imported: ${parsed.skipped} entries were not valid presets.` : 'The file had no presets.');
            return;
        }
        const notes = [
            merged.renamed > 0 ? `${merged.renamed} renamed because the name was taken` : '',
            parsed.skipped > 0 ? `${parsed.skipped} invalid skipped` : '',
            merged.dropped > 0 ? `${merged.dropped} left out (limit of ${MAX_PRESETS})` : '',
        ].filter(Boolean);
        await persist(merged.presets, `Imported ${merged.added} preset${merged.added === 1 ? '' : 's'}${notes.length ? ` (${notes.join(', ')})` : ''}.`);
    };

    return {
        saved, newName, setNewName, canSave, nameClash: !!cleanName(newName) && nameTaken(newName, saved),
        message, confirmDelete, save, update, remove, exportFile, importFile,
    };
}

export type SavedPresetsState = ReturnType<typeof useSavedPresets>;
