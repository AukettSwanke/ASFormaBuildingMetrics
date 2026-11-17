// Small presentational building blocks shared by the panel and the render UI. No Forma calls.

import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';

/** Reads and writes a per-viewer UI preference; storage can be blocked inside Forma's iframe. */
export const preference = {
    get: (key: string): string | null => {
        try { return window.localStorage.getItem(`building-metrics:${key}`); } catch { return null; }
    },
    set: (key: string, value: string): void => {
        try { window.localStorage.setItem(`building-metrics:${key}`, value); } catch { /* not available */ }
    },
};

export interface TabDef<T extends string> { id: T; label: string }

/**
 * A row of tabs. Panels are rendered by the caller and hidden (not unmounted) when inactive, so state
 * such as the loaded 3D scene survives switching. Arrow keys move between tabs.
 */
export function Tabs<T extends string>({ tabs, active, onChange, label }: {
    tabs: TabDef<T>[]; active: T; onChange: (id: T) => void; label: string;
}) {
    const list = useRef<HTMLDivElement>(null);
    const onKeyDown = (e: KeyboardEvent) => {
        const i = tabs.findIndex((t) => t.id === active);
        const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (next === null) return;
        e.preventDefault();
        const tab = tabs[(next + tabs.length) % tabs.length];
        onChange(tab.id);
        list.current?.querySelector<HTMLButtonElement>(`#tab-${tab.id}`)?.focus();
    };
    return (
        <div class="tabs" role="tablist" aria-label={label} ref={list} onKeyDown={onKeyDown}>
            {tabs.map((t) => (
                <button
                    key={t.id}
                    id={`tab-${t.id}`}
                    class="tabs__tab"
                    role="tab"
                    aria-selected={t.id === active}
                    aria-controls={`panel-${t.id}`}
                    tabIndex={t.id === active ? 0 : -1}
                    onClick={() => onChange(t.id)}
                >
                    {t.label}
                </button>
            ))}
        </div>
    );
}

export function TabPanel({ id, active, children }: { id: string; active: boolean; children: ComponentChildren }) {
    return (
        <div id={`panel-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={!active}>
            {children}
        </div>
    );
}

/** Mutually exclusive choices shown as a row of buttons. */
export function Segmented<T extends string>({ options, value, onChange, label, fill = false, disabled = false }: {
    options: [T, string][]; value: T; onChange: (value: T) => void; label: string; fill?: boolean; disabled?: boolean;
}) {
    return (
        <div class={`segmented${fill ? ' segmented--fill' : ''}`} role="group" aria-label={label}>
            {options.map(([id, text]) => (
                <button key={id} type="button" aria-pressed={id === value} disabled={disabled} onClick={() => onChange(id)}>
                    {text}
                </button>
            ))}
        </div>
    );
}

/** A labelled row: label, control, and an optional value or second control on the right. */
export function Field({ label, htmlFor, children, value }: {
    label: ComponentChildren; htmlFor?: string; children: ComponentChildren; value?: ComponentChildren;
}) {
    return (
        <div class="field">
            {htmlFor ? <label class="field__label" for={htmlFor}>{label}</label> : <span class="field__label">{label}</span>}
            <div class="field__control">{children}</div>
            <div class="field__value">{value}</div>
        </div>
    );
}

export function Legend({ items }: { items: [string, string][] }) {
    return (
        <div class="legend">
            {items.map(([colour, label]) => (
                <div key={label} class="legend__item">
                    <span class="legend__swatch" style={{ backgroundColor: colour }} />
                    <span>{label}</span>
                </div>
            ))}
        </div>
    );
}

export function Spinner() {
    return <span class="spinner" aria-hidden="true">⟳</span>;
}
