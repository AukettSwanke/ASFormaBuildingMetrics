// Stand-in for `forma-embedded-view-sdk/auto`, so the panel can run outside Forma. The test bundles
// alias the SDK to this file. It covers the calls the panel makes, with a configurable scene:
//
//   globalThis.__formaScene  scene and project settings (see `FormaScene`), read on every call
//   globalThis.__storage     extension storage, key -> JSON text (survives unmount and remount)
//   globalThis.__formaCalls  a log of calls that change something in Forma, for assertions
//
// Nothing here talks to a real Forma. Behaviour is only as faithful as the comments say.

import { box, ground } from '../lib/scene';

export interface FormaScene {
    buildings: Record<string, Float32Array>;
    /** Returned for `getTriangles({ excludedPaths })`, i.e. the context. */
    context: Float32Array | null;
    canEdit: boolean;
    /** [latitude, longitude] or null for a project with no location. */
    location: [number, number] | null;
    timezone: string | undefined;
    sunDate: Date;
    camera: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; type: 'perspective' | 'orthographic' };
    selection: string[];
    rootUrn: string;
}

const defaultScene = (): FormaScene => ({
    buildings: {
        'root/b1': box(-30, -10, 0, -10, 10, 30),
        'root/b2': box(5, -5, 0, 25, 15, 18),
        'root/b3': box(-5, 25, 0, 10, 40, 45),
    },
    context: ground(0, 0, 400),
    canEdit: true,
    location: [51.5072, -0.1276], // London
    timezone: 'Europe/London',
    sunDate: new Date('2026-06-21T12:00:00Z'),
    camera: { position: { x: 120, y: -160, z: 110 }, target: { x: 0, y: 10, z: 10 }, type: 'perspective' },
    selection: [],
    rootUrn: 'urn:adsk-forma-elements:proposal:pro_test:proposal-1:1700000000',
});

const g = globalThis as any;
g.__formaScene ??= defaultScene();
g.__storage ??= {};
g.__formaCalls ??= [];
const scene = (): FormaScene => g.__formaScene;
const log = (name: string, args?: unknown) => g.__formaCalls.push({ name, args });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Resets the scene, storage and call log. Exposed for test pages. */
export const resetForma = (overrides: Partial<FormaScene> = {}) => {
    g.__formaScene = { ...defaultScene(), ...overrides };
    g.__storage = {};
    g.__formaCalls = [];
};
g.__resetForma = resetForma;

const cameraListeners = new Set<(state: FormaScene['camera']) => void>();
/** Moves the stub camera and notifies subscribers, as Forma does when the user orbits. */
g.__moveCamera = (state: FormaScene['camera']) => {
    scene().camera = state;
    for (const listener of cameraListeners) listener(state);
};

const footprintOf = (position: Float32Array) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < position.length; i += 3) {
        minX = Math.min(minX, position[i]); maxX = Math.max(maxX, position[i]);
        minY = Math.min(minY, position[i + 1]); maxY = Math.max(maxY, position[i + 1]);
    }
    return { coordinates: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] };
};

export const Forma = {
    getCanEdit: async () => scene().canEdit,
    geometry: {
        getPathsByCategory: async ({ category }: { category: string }) => {
            await tick();
            return category === 'building' ? Object.keys(scene().buildings) : [];
        },
        getTriangles: async ({ path, excludedPaths }: { path?: string; excludedPaths?: string[] } = {}) => {
            await tick();
            if (path !== undefined) return scene().buildings[path] ?? new Float32Array(0);
            if (excludedPaths) return scene().context ?? new Float32Array(0);
            return new Float32Array(0);
        },
        getFootprint: async ({ path }: { path: string }) => {
            const position = scene().buildings[path];
            return position ? footprintOf(position) : undefined;
        },
    },
    selection: { getSelection: async () => [...scene().selection] },
    camera: {
        getCurrent: async () => structuredClone(scene().camera),
        subscribe: async (listener: (state: FormaScene['camera']) => void) => {
            cameraListeners.add(listener);
            return { unsubscribe: () => cameraListeners.delete(listener) };
        },
        move: async (args: unknown) => { log('camera.move', args); },
        /** A flat grey image of the requested size (Forma's real capture is the 3D view). */
        capture: async ({ width, height }: { width: number; height: number }) => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#7f8c99';
            ctx.fillRect(0, 0, width, height);
            return canvas;
        },
    },
    sun: {
        getDate: async () => new Date(scene().sunDate),
        setDate: async ({ date }: { date: Date }) => { log('sun.setDate', date.toISOString()); scene().sunDate = new Date(date); },
    },
    project: {
        getGeoLocation: async () => scene().location ?? undefined,
        getTimezone: async () => scene().timezone,
    },
    udm: { getRootUrn: async () => scene().rootUrn },
    extensions: {
        storage: {
            getTextObject: async ({ key }: { key: string }) => {
                await tick();
                return key in g.__storage ? { data: g.__storage[key] } : undefined;
            },
            setObject: async ({ key, data }: { key: string; data: string }) => {
                await tick();
                g.__storage[key] = data;
                log('storage.setObject', key);
            },
        },
    },
    render: {
        cleanup: async () => { log('render.cleanup'); },
        updateMesh: async (args: { id: string }) => { log('render.updateMesh', args.id); },
        elementColors: {
            set: async (args: { pathsToColor: Map<string, string> | Record<string, string> }) => { log('elementColors.set', args); },
            clear: async (args: { paths: string[] }) => { log('elementColors.clear', args.paths); },
            clearAll: async () => { log('elementColors.clearAll'); },
        },
    },
    integrateElements: {
        uploadFile: async () => { log('integrateElements.uploadFile'); return { blobId: 'blob-1' }; },
        createElementV2: async () => { log('integrateElements.createElementV2'); return { urn: 'urn:test:element:1' }; },
    },
    elements: {
        add: async () => { log('elements.add'); return { path: 'root/envelope-1' }; },
        remove: async () => { log('elements.remove'); },
    },
};
