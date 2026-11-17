// Composes a layered shadow image: one render of the buildings with the shadows from several times of day
// laid over the ground. Canvas drawing only, no Forma or three.js calls.

export type LayerMode = 'time' | 'accumulate';

export interface LayeredPlan {
    width: number;
    height: number;
    gap: number;
    imageWidth: number;
    imageHeight: number;
    headerHeight: number;
    legendHeight: number;
    font: number;
    titleFont: number;
    /** Legend chips per row, in 'time' mode. */
    chipsPerRow: number;
}

export interface LayeredOptions {
    mode: LayerMode;
    /** In 'time' mode the opacity of each shadow; in 'accumulate' mode how dark ground shadowed at every time gets. */
    opacity: number;
    /** One label per mask, e.g. "09:00". */
    times: string[];
    /** Sheet background colour, or null to leave it transparent. */
    background: string | null;
    textColour: string;
    title: string | null;
    /** Shadow colour in 'accumulate' mode. */
    accumulateColour: string;
}

const RAMP = ['#1f4e9c', '#7b4ea3', '#e0702d']; // early (cool) to late (warm)

const hexToRgb = (hex: string): [number, number, number] => {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = ([r, g, b]: number[]): string =>
    `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Colour for position `t` (0 = first time, 1 = last) along the early-to-late ramp. */
export const timeColour = (t: number): string => {
    const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(x));
    const f = x - i;
    const a = hexToRgb(RAMP[i]), b = hexToRgb(RAMP[i + 1]);
    return toHex(a.map((v, k) => v + (b[k] - v) * f));
};

/** Opacity each layer needs so that ground shadowed at all `count` times reaches `maxDarkness`. */
export const layerAlpha = (maxDarkness: number, count: number): number =>
    1 - Math.pow(1 - Math.max(0, Math.min(0.99, maxDarkness)), 1 / Math.max(1, count));

export const planLayered = (width: number, aspect: number, hasTitle: boolean, count: number, mode: LayerMode): LayeredPlan => {
    const gap = Math.round(width * 0.015);
    const imageWidth = width - gap * 2;
    const imageHeight = Math.round(imageWidth / aspect);
    const font = Math.max(12, Math.round(imageWidth * 0.017));
    const titleFont = Math.round(font * 1.5);
    const headerHeight = hasTitle ? Math.round(titleFont * 2.4) : 0;
    const chipsPerRow = Math.max(1, Math.floor(imageWidth / (font * 5.5)));
    const legendRows = mode === 'time' ? Math.ceil(count / chipsPerRow) : 1;
    const legendHeight = mode === 'time' ? Math.round(legendRows * font * 2.1 + gap) : Math.round(font * 4.2 + gap);
    const height = headerHeight + gap + imageHeight + legendHeight + gap;
    return { width, height, gap, imageWidth, imageHeight, headerHeight, legendHeight, font, titleFont, chipsPerRow };
};

const tint = (mask: HTMLCanvasElement, colour: string, w: number, h: number): HTMLCanvasElement => {
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const ctx = layer.getContext('2d')!;
    ctx.drawImage(mask, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-in'; // keeps the mask's alpha, replaces its colour
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, w, h);
    return layer;
};

export const composeLayered = (
    base: HTMLCanvasElement, masks: HTMLCanvasElement[], plan: LayeredPlan, options: LayeredOptions,
): HTMLCanvasElement => {
    const sheet = document.createElement('canvas');
    sheet.width = plan.width;
    sheet.height = plan.height;
    const ctx = sheet.getContext('2d')!;
    if (options.background) {
        ctx.fillStyle = options.background;
        ctx.fillRect(0, 0, plan.width, plan.height);
    }
    const family = 'Inter, system-ui, Helvetica, Arial, sans-serif';
    ctx.fillStyle = options.textColour;
    if (options.title) {
        ctx.font = `600 ${plan.titleFont}px ${family}`;
        ctx.fillText(options.title, plan.gap, plan.gap + plan.titleFont * 1.2);
    }

    const x = plan.gap, y = plan.headerHeight + plan.gap;
    ctx.drawImage(base, x, y, plan.imageWidth, plan.imageHeight);

    // Shadows go over the base. Buildings are transparent in every mask, so they stay on top of their own shadows.
    const alpha = options.mode === 'time' ? options.opacity : layerAlpha(options.opacity, masks.length);
    masks.forEach((mask, i) => {
        const colour = options.mode === 'time'
            ? timeColour(masks.length === 1 ? 0.5 : i / (masks.length - 1))
            : options.accumulateColour;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(tint(mask, colour, plan.imageWidth, plan.imageHeight), x, y);
        ctx.restore();
    });

    // Hairline frame so a white image stays visible on a white sheet.
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = options.textColour;
    ctx.lineWidth = Math.max(1, Math.round(plan.width / 2000));
    ctx.strokeRect(x + 0.5, y + 0.5, plan.imageWidth - 1, plan.imageHeight - 1);
    ctx.restore();

    // Legend
    const ly = y + plan.imageHeight + plan.gap;
    ctx.textBaseline = 'middle';
    ctx.font = `500 ${plan.font}px ${family}`;
    if (options.mode === 'time') {
        const chipW = plan.imageWidth / plan.chipsPerRow;
        options.times.forEach((time, i) => {
            const cx = x + (i % plan.chipsPerRow) * chipW;
            const cy = ly + Math.floor(i / plan.chipsPerRow) * plan.font * 2.1 + plan.font * 0.9;
            ctx.fillStyle = timeColour(options.times.length === 1 ? 0.5 : i / (options.times.length - 1));
            ctx.fillRect(cx, cy - plan.font * 0.55, plan.font * 1.1, plan.font * 1.1);
            ctx.fillStyle = options.textColour;
            ctx.fillText(time, cx + plan.font * 1.6, cy);
        });
    } else {
        const barW = Math.min(plan.imageWidth * 0.45, plan.font * 22), barH = plan.font * 1.1;
        const by = ly + plan.font * 0.4;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, by, barW, barH);
        ctx.clip();
        const steps = 24;
        for (let k = 0; k < steps; k++) {
            ctx.globalAlpha = 1 - Math.pow(1 - alpha, 1 + (k / (steps - 1)) * (masks.length - 1));
            ctx.fillStyle = options.accumulateColour;
            ctx.fillRect(x + (k * barW) / steps, by, barW / steps + 1, barH);
        }
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = options.textColour;
        ctx.strokeRect(x + 0.5, by + 0.5, barW - 1, barH - 1);
        ctx.restore();
        ctx.fillStyle = options.textColour;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('1', x, by + barH + plan.font * 1.3);
        ctx.textAlign = 'right';
        ctx.fillText(`all ${masks.length}`, x + barW, by + barH + plan.font * 1.3);
        ctx.textAlign = 'left';
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.fillText(
            `Darker ground is in shadow at more of the ${masks.length} times (${options.times[0]} to ${options.times[options.times.length - 1]}).`,
            x + barW + plan.font * 1.5, by + barH * 0.8,
        );
        ctx.restore();
    }
    return sheet;
};
