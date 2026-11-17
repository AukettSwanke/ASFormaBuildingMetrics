// The "Saved presets" disclosure under Look: save the current look by name, update or delete saved
// ones, and move them between projects as a file. View-only users can only export.

import { useRef } from 'preact/hooks';
import { MAX_NAME_LENGTH } from '../presets';
import type { SavedPresetsState } from './useSavedPresets';
import { inputValue } from './shared';

export function SavedPresets({ presets: p, canEdit }: { presets: SavedPresetsState; canEdit: boolean }) {
    const fileInput = useRef<HTMLInputElement>(null);
    return (
        <details class="disclosure">
            <summary>Saved presets ({p.saved.length})</summary>
            <p class="help" style={{ marginTop: 0 }}>
                A preset keeps the look: colours, lines and light. Background and context are set
                when you export. Saved presets are shared with everyone on this Forma project.
            </p>
            {canEdit && (
                <div class="row" style={{ marginTop: '0.6em' }}>
                    <input type="text" value={p.newName} maxLength={MAX_NAME_LENGTH} placeholder="Name this look"
                        aria-label="Name for the new preset" style={{ flex: 1 }}
                        onInput={(e) => p.setNewName(inputValue(e))}
                        onKeyDown={(e) => { if (e.key === 'Enter') p.save(); }} />
                    <button onClick={p.save} disabled={!p.canSave}>Save current look</button>
                </div>
            )}
            {canEdit && p.nameClash && (
                <p class="help">That name is already used. Choose another, or update that preset.</p>
            )}
            {p.saved.map((preset) => (
                <div class="field" key={preset.id}>
                    <span class="field__label" style={{ color: 'var(--text-primary)' }}>{preset.name}</span>
                    <div class="field__control">
                        {canEdit && (
                            <>
                                <button class="button-ghost" onClick={() => p.update(preset.id)}
                                    aria-label={`Update ${preset.name} with the current look`}>Update</button>
                                <button class="button-ghost" onClick={() => p.remove(preset.id)}
                                    aria-label={p.confirmDelete === preset.id ? `Confirm delete ${preset.name}` : `Delete ${preset.name}`}>
                                    {p.confirmDelete === preset.id ? 'Confirm delete' : 'Delete'}
                                </button>
                            </>
                        )}
                    </div>
                    <span />
                </div>
            ))}
            <div class="actions">
                <button class="button-ghost" onClick={p.exportFile} disabled={p.saved.length === 0}>Export to file</button>
                {canEdit && (
                    <>
                        <button class="button-ghost" onClick={() => fileInput.current?.click()}>Import from file…</button>
                        <input ref={fileInput} type="file" accept=".json,application/json" style={{ display: 'none' }}
                            onChange={p.importFile} />
                    </>
                )}
            </div>
            {p.message && <p class="help" role="status">{p.message}</p>}
        </details>
    );
}
