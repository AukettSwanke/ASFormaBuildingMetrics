// Constants, types and small helpers shared by the Render tab's components. No Forma calls, and only
// type imports from the engine, so three.js stays out of the main bundle.

import type { RenderStyle } from '../panelRender';

/** Forma's camera field of view; confirmed by overlaying Forma's own capture. */
export const FOV = 45;

/** Frame shapes for the preview and every export. */
export const ASPECTS: Record<string, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1 };

/** Export widths offered, in pixels. */
export const EXPORT_WIDTHS = [1280, 1920, 2560, 3840, 5120];

/** Standard planning dates for shadow studies (equinoxes and solstices, rounded to the 21st). */
export const STUDY_DATES: [string, string][] = [['21 Mar', '03-21'], ['21 Jun', '06-21'], ['21 Sep', '09-21'], ['21 Dec', '12-21']];

/** Checkerboard shown behind the canvas while the background is transparent. */
export const CHECKERBOARD = 'repeating-conic-gradient(#d8d8d8 0% 25%, #ffffff 0% 50%) 50% / 16px 16px';

export type SunMode = 'forma' | 'custom';
export type OutputKind = 'image' | 'study';
export type StudyLayout = 'separate' | 'layered';

/** Changes a few fields of the current render style. */
export type PatchStyle = (changes: Partial<RenderStyle>) => void;

/** What Forma last reported about the sun and the project. */
export interface FormaSun {
    date: Date;
    /** [latitude, longitude], or null for a project with no location. */
    location: [number, number] | null;
    /** IANA time zone of the project, or a fallback from the longitude. */
    zone: string;
}

/** Figures shown under Scene details after a load. */
export interface SceneInfo {
    buildingTriangles: number;
    contextTriangles: number;
    lineSegments: number;
    buildingMs: number;
    contextMs: number;
    gpu: string;
}

/** Runs a slow step with the panel marked busy, showing `pending` and reporting failures. */
export type RunTask = (failure: string, work: () => Promise<string | null | void>, pending?: string) => Promise<void>;

/** "21 Jun 2026" for a calendar date (already in the project time zone). */
export const longDate = (z: { year: number; month: number; day: number }): string =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(Date.UTC(z.year, z.month - 1, z.day)));

/** Black or near-white text, whichever reads better on a sheet of the given background colour. */
export const readableOn = (hex: string): string => {
    const n = parseInt(hex.replace('#', ''), 16);
    const luma = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return luma > 0.55 ? '#222222' : '#f2f2f2';
};

/** "09:30" from an `<input type="time">` value as minutes after midnight, or null. */
export const parseClock = (value: string): number | null => {
    const [h, m] = value.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

export const inputValue = (e: Event) => (e.target as HTMLInputElement).value;
export const inputChecked = (e: Event) => (e.target as HTMLInputElement).checked;
export const selectValue = (e: Event) => (e.target as HTMLSelectElement).value;

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Saves a blob or object URL as a file through a temporary link. */
export const downloadUrl = (url: string, name: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
};

export const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    downloadUrl(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
