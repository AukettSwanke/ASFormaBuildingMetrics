// Lays out a shadow study: several renders of the same view, one per time of day, on one sheet.
// Canvas drawing only, no Forma or three.js calls.

export interface SheetPlan {
    width: number;
    height: number;
    columns: number;
    gap: number;
    tileWidth: number;
    tileHeight: number;
    labelHeight: number;
    headerHeight: number;
    labelFont: number;
    titleFont: number;
}

export interface SheetTile {
    canvas: HTMLCanvasElement;
    /** Large line, e.g. "12:00". */
    time: string;
    /** Smaller line, e.g. "azimuth 180° · elevation 15°". */
    detail: string;
}

export interface SheetOptions {
    title: string | null;
    labels: boolean;
    /** Sheet background colour, or null to leave it transparent. */
    background: string | null;
    textColour: string;
}

/** Works out tile and sheet sizes for a sheet `width` pixels wide, before any tile is rendered. */
export const planSheet = (
    width: number, columns: number, count: number, tileAspect: number, labels: boolean, hasTitle: boolean,
): SheetPlan => {
    const cols = Math.max(1, Math.min(columns, count));
    const gap = Math.round(width * 0.015);
    const tileWidth = Math.floor((width - gap * (cols + 1)) / cols);
    const tileHeight = Math.round(tileWidth / tileAspect);
    const labelFont = Math.max(12, Math.round(tileWidth * 0.05));
    const titleFont = Math.round(labelFont * 1.35);
    const labelHeight = labels ? Math.round(labelFont * 2.5) : 0;
    const headerHeight = hasTitle ? Math.round(titleFont * 2.4) : 0;
    const rows = Math.ceil(count / cols);
    const height = headerHeight + rows * (tileHeight + labelHeight + gap) + gap;
    return { width, height, columns: cols, gap, tileWidth, tileHeight, labelHeight, headerHeight, labelFont, titleFont };
};

export const composeSheet = (tiles: SheetTile[], plan: SheetPlan, options: SheetOptions): HTMLCanvasElement => {
    const sheet = document.createElement('canvas');
    sheet.width = plan.width;
    sheet.height = plan.height;
    const ctx = sheet.getContext('2d')!;
    if (options.background) {
        ctx.fillStyle = options.background;
        ctx.fillRect(0, 0, plan.width, plan.height);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = options.textColour;
    const family = 'Inter, system-ui, Helvetica, Arial, sans-serif';

    if (options.title) {
        ctx.font = `600 ${plan.titleFont}px ${family}`;
        ctx.fillText(options.title, plan.gap, plan.gap + plan.titleFont * 1.2);
    }

    tiles.forEach((tile, i) => {
        const col = i % plan.columns, row = Math.floor(i / plan.columns);
        const x = plan.gap + col * (plan.tileWidth + plan.gap);
        const y = plan.headerHeight + plan.gap + row * (plan.tileHeight + plan.labelHeight + plan.gap);
        ctx.drawImage(tile.canvas, x, y, plan.tileWidth, plan.tileHeight);
        // A hairline frame keeps a white tile visible on a white sheet.
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = options.textColour;
        ctx.lineWidth = Math.max(1, Math.round(plan.width / 2000));
        ctx.strokeRect(x + 0.5, y + 0.5, plan.tileWidth - 1, plan.tileHeight - 1);
        ctx.restore();
        if (plan.labelHeight > 0) {
            ctx.font = `600 ${plan.labelFont}px ${family}`;
            ctx.fillText(tile.time, x, y + plan.tileHeight + plan.labelFont * 1.25);
            ctx.save();
            ctx.globalAlpha = 0.7;
            ctx.font = `400 ${Math.round(plan.labelFont * 0.8)}px ${family}`;
            ctx.fillText(tile.detail, x, y + plan.tileHeight + plan.labelFont * 2.2);
            ctx.restore();
        }
    });
    return sheet;
};

/** `count` times from `from` to `to` minutes, evenly spaced and rounded to 5 minutes. */
export const studyTimes = (from: number, to: number, count: number): number[] => {
    if (count <= 1) return [from];
    return Array.from({ length: count }, (_, i) => Math.round((from + ((to - from) * i) / (count - 1)) / 5) * 5);
};
