// Synthetic geometry for the tests: outward-wound boxes and a flat ground, in Forma's space
// (metres, Z up, X east, Y north). Pure, so node and browser tests can share it.

/** A closed box as 12 triangles (9 floats each), every face wound so its normal points outwards. */
export const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array => {
    const p = [
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    // Each quad listed counter-clockwise seen from outside.
    const quads = [
        [0, 3, 2, 1], // bottom (normal -Z)
        [4, 5, 6, 7], // top (+Z)
        [0, 1, 5, 4], // south (-Y)
        [2, 3, 7, 6], // north (+Y)
        [1, 2, 6, 5], // east (+X)
        [3, 0, 4, 7], // west (-X)
    ];
    const out: number[] = [];
    for (const [a, b, c, d] of quads) out.push(...p[a], ...p[b], ...p[c], ...p[a], ...p[c], ...p[d]);
    return new Float32Array(out);
};

/** A horizontal square of ground centred on (cx, cy), facing up. */
export const ground = (cx: number, cy: number, half: number, z = 0): Float32Array => new Float32Array([
    cx - half, cy - half, z, cx + half, cy - half, z, cx + half, cy + half, z,
    cx - half, cy - half, z, cx + half, cy + half, z, cx - half, cy + half, z,
]);

/** An upright prism with `sides` faces (a faceted cylinder), wound outwards, with caps. */
export const prism = (cx: number, cy: number, radius: number, height: number, sides: number): Float32Array => {
    const out: number[] = [];
    for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * 2 * Math.PI, a1 = ((i + 1) / sides) * 2 * Math.PI;
        const x0 = cx + radius * Math.cos(a0), y0 = cy + radius * Math.sin(a0);
        const x1 = cx + radius * Math.cos(a1), y1 = cy + radius * Math.sin(a1);
        out.push(x0, y0, 0, x1, y1, 0, x1, y1, height, x0, y0, 0, x1, y1, height, x0, y0, height); // side
        out.push(cx, cy, height, x0, y0, height, x1, y1, height); // top
        out.push(cx, cy, 0, x1, y1, 0, x0, y0, 0); // bottom
    }
    return new Float32Array(out);
};

/** A Forma `graphBuilding` made of rectangular spaces, in the element's own coordinates. */
export interface GraphSpec {
    height: number;
    spaces: { rect: [number, number, number, number]; function?: string; clockwise?: boolean }[];
}

/**
 * Builds a graph building from rectangles. `prefix` makes point, surface and
 * space IDs differ between buildings, as they would in two projects.
 */
export const graphOf = (levels: GraphSpec[], prefix = 'g') => {
    const units: { id: string; properties: { function?: string }; spaceIds: string[] }[] = [];
    const out = levels.map((level, li) => {
        const points: Record<string, [number, number]> = {};
        const surfaces: { id: string; pointA: string; pointB: string }[] = [];
        const spaces = level.spaces.map((space, si) => {
            const [x0, y0, x1, y1] = space.rect;
            let corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            if (space.clockwise) corners = [...corners].reverse();
            const ids = corners.map((c, k) => {
                const id = `${prefix}${li}p${si}_${k}`;
                points[id] = c;
                return id;
            });
            // Surfaces run backwards with directionAToB false, so the loop walks them the right way.
            const outerLoop = ids.map((a, k) => {
                const b = ids[(k + 1) % ids.length];
                const id = `${prefix}${li}s${si}_${k}`;
                surfaces.push({ id, pointA: b, pointB: a });
                return { id: `${id}c`, partnerId: null, surfaceId: id, directionAToB: false };
            });
            const id = `${prefix}${li}space${si}`;
            units.push({ id: `${id}u`, properties: space.function ? { function: space.function } : {}, spaceIds: [id] });
            return { id, outerLoop };
        });
        return { height: level.height, points, spaces, surfaces };
    });
    return { units, levels: out };
};
