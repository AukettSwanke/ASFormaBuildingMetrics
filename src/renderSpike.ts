// Render spike (option C): pure image helpers, no Forma calls.
//
// Idea: capture a normal "beauty" view, recolour every building to a unique
// flat colour and capture an "ID" view, then find edges in the ID view and
// composite them (with an adjustable line weight) over the beauty view.

/** Saturated, well-separated colour per building (golden-angle hues, alternating lightness). */
export const idColour = (index: number): string => {
    const hue = (index * 137.508) % 360;
    const light = index % 2 === 0 ? 50 : 35;
    const s = 0.9;
    const l = light / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + hue / 30) % 12;
        const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
};

export type RenderStyle = 'overBeauty' | 'overWhite';

export interface CompositeOptions {
    /** Colour difference (0–255) between neighbouring pixels that counts as an edge. */
    threshold: number;
    /** Line weight in pixels of the output image. */
    weight: number;
    lineColour: string;
    style: RenderStyle;
}

export const readPixels = (canvas: HTMLCanvasElement): ImageData => {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Captured canvas has no 2D context.');
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
};

/** 1 px edge mask: a pixel is an edge when it differs from its right or lower neighbour. */
export const detectEdges = (img: ImageData, threshold: number): Uint8Array => {
    const { width: w, height: h, data } = img;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            let diff = 0;
            if (x + 1 < w) diff = Math.max(diff, channelDiff(data, i, i + 4));
            if (y + 1 < h) diff = Math.max(diff, channelDiff(data, i, i + w * 4));
            if (diff > threshold) mask[y * w + x] = 1;
        }
    }
    return mask;
};

const channelDiff = (d: Uint8ClampedArray, a: number, b: number): number =>
    Math.max(Math.abs(d[a] - d[b]), Math.abs(d[a + 1] - d[b + 1]), Math.abs(d[a + 2] - d[b + 2]));

/** Grow the mask by `radius` pixels (square kernel, separable, so cost is independent of weight). */
export const dilate = (mask: Uint8Array, w: number, h: number, radius: number): Uint8Array => {
    if (radius <= 0) return mask;
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (!mask[row + x]) continue;
            const from = Math.max(0, x - radius), to = Math.min(w - 1, x + radius);
            for (let k = from; k <= to; k++) tmp[row + k] = 1;
        }
    }
    const out = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            if (!tmp[y * w + x]) continue;
            const from = Math.max(0, y - radius), to = Math.min(h - 1, y + radius);
            for (let k = from; k <= to; k++) out[k * w + x] = 1;
        }
    }
    return out;
};

const parseHex = (hex: string): [number, number, number] => {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export interface CompositeResult {
    canvas: HTMLCanvasElement;
    edgePixels: number;
    /** Share of pixels where the ID pass differs strongly from the beauty pass. */
    idDiffersFromBeauty: number;
}

/** Combine beauty and ID passes (must be the same size) into the final image. */
export const composite = (beauty: ImageData, id: ImageData, opts: CompositeOptions): CompositeResult => {
    const { width: w, height: h } = beauty;
    // Weight 1 = the raw 1 px edge; each extra 2 px grows the line by 1 px on every side.
    const radius = Math.max(0, Math.round((opts.weight - 1) / 2));
    const mask = dilate(detectEdges(id, opts.threshold), w, h, radius);

    const out = new ImageData(w, h);
    const [lr, lg, lb] = parseHex(opts.lineColour);
    let edgePixels = 0, differs = 0;
    for (let p = 0; p < w * h; p++) {
        const i = p * 4;
        if (Math.abs(beauty.data[i] - id.data[i]) + Math.abs(beauty.data[i + 1] - id.data[i + 1])
            + Math.abs(beauty.data[i + 2] - id.data[i + 2]) > 60) differs++;
        if (mask[p]) {
            out.data[i] = lr; out.data[i + 1] = lg; out.data[i + 2] = lb; out.data[i + 3] = 255;
            edgePixels++;
        } else if (opts.style === 'overBeauty') {
            out.data[i] = beauty.data[i]; out.data[i + 1] = beauty.data[i + 1];
            out.data[i + 2] = beauty.data[i + 2]; out.data[i + 3] = 255;
        } else {
            out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = 255;
        }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.putImageData(out, 0, 0);
    return { canvas, edgePixels, idDiffersFromBeauty: differs / (w * h) };
};

/** Resolves after the browser has painted `frames` times plus a settle delay. */
export const waitForRender = async (settleMs: number, frames = 2): Promise<void> => {
    for (let i = 0; i < frames; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => setTimeout(r, settleMs));
};
