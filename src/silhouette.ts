// Edge classification and silhouette finding. Pure functions, no three.js or Forma calls.
//
// Input is a non-indexed triangle list (9 floats per triangle). Triangles are assumed to be
// consistently wound with outward-facing normals, as Forma building meshes are.
//
// Edges split into three kinds:
//  - hard:   open boundary, or the faces meet at more than the crease angle. Always drawn.
//  - smooth: both faces are nearly coplanar (curved surfaces). Drawn only when they are a
//            silhouette: one face towards the camera and the other away.
// Hard edges that are also silhouettes need no special handling, they are already drawn.

export interface EdgeSet {
    /** Segment end points, 6 floats per edge, always drawn. */
    hard: Float32Array;
    /** Segment end points of smooth edges, 6 floats per edge. */
    smooth: Float32Array;
    /** For each smooth edge, the two adjoining face indices. */
    smoothFaces: Int32Array;
    /** Per face: unit normal (3 floats) then first vertex (3 floats). */
    faces: Float32Array;
}

const KEY_SCALE = 100; // merge vertices closer than 1 cm
const ID_RANGE = 2 ** 26;

export const buildEdgeSet = (position: Float32Array, creaseAngleDeg: number): EdgeSet => {
    const triangles = Math.floor(position.length / 9);
    const faces = new Float32Array(triangles * 6);
    const vertexIds = new Map<string, number>();
    const idOf = (x: number, y: number, z: number): number => {
        const key = `${Math.round(x * KEY_SCALE)},${Math.round(y * KEY_SCALE)},${Math.round(z * KEY_SCALE)}`;
        let id = vertexIds.get(key);
        if (id === undefined) { id = vertexIds.size; vertexIds.set(key, id); }
        return id;
    };

    // edge key -> [face a, face b, offset of the segment in `ends`]
    const edges = new Map<number, [number, number, number]>();
    const ends: number[] = [];
    const addEdge = (ia: number, ib: number, p: number, q: number, face: number) => {
        const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
        if (lo === hi) return; // degenerate
        const key = lo * ID_RANGE + hi;
        const entry = edges.get(key);
        if (!entry) {
            const offset = ends.length;
            ends.push(position[p], position[p + 1], position[p + 2], position[q], position[q + 1], position[q + 2]);
            edges.set(key, [face, -1, offset]);
        } else if (entry[1] === -1) {
            entry[1] = face;
        } // a third face on one edge is non-manifold; ignore it
    };

    for (let f = 0; f < triangles; f++) {
        const o = f * 9;
        const ux = position[o + 3] - position[o], uy = position[o + 4] - position[o + 1], uz = position[o + 5] - position[o + 2];
        const vx = position[o + 6] - position[o], vy = position[o + 7] - position[o + 1], vz = position[o + 8] - position[o + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; }
        faces.set([nx, ny, nz, position[o], position[o + 1], position[o + 2]], f * 6);

        const a = idOf(position[o], position[o + 1], position[o + 2]);
        const b = idOf(position[o + 3], position[o + 4], position[o + 5]);
        const c = idOf(position[o + 6], position[o + 7], position[o + 8]);
        addEdge(a, b, o, o + 3, f);
        addEdge(b, c, o + 3, o + 6, f);
        addEdge(c, a, o + 6, o, f);
    }

    const cosCrease = Math.cos((creaseAngleDeg * Math.PI) / 180);
    const hard: number[] = [];
    const smooth: number[] = [];
    const smoothFaces: number[] = [];
    for (const [fa, fb, offset] of edges.values()) {
        const segment = ends.slice(offset, offset + 6);
        if (fb === -1) { hard.push(...segment); continue; }
        const dot = faces[fa * 6] * faces[fb * 6] + faces[fa * 6 + 1] * faces[fb * 6 + 1] + faces[fa * 6 + 2] * faces[fb * 6 + 2];
        if (dot < cosCrease) hard.push(...segment);
        else { smooth.push(...segment); smoothFaces.push(fa, fb); }
    }
    return {
        hard: new Float32Array(hard),
        smooth: new Float32Array(smooth),
        smoothFaces: new Int32Array(smoothFaces),
        faces,
    };
};

export type ViewPoint =
    | { kind: 'perspective'; x: number; y: number; z: number }
    /** Direction the camera looks along (target minus position), need not be normalised. */
    | { kind: 'orthographic'; x: number; y: number; z: number };

/** Smooth edges whose two faces disagree about facing the camera, as segment end points. */
export const findSilhouettes = (set: EdgeSet, view: ViewPoint): Float32Array => {
    const { faces, smooth, smoothFaces } = set;
    const faceCount = faces.length / 6;
    const front = new Uint8Array(faceCount);
    for (let f = 0; f < faceCount; f++) {
        const o = f * 6;
        // Perspective: vector from the face to the camera. Orthographic: opposite of the look direction.
        const dx = view.kind === 'perspective' ? view.x - faces[o + 3] : -view.x;
        const dy = view.kind === 'perspective' ? view.y - faces[o + 4] : -view.y;
        const dz = view.kind === 'perspective' ? view.z - faces[o + 5] : -view.z;
        front[f] = faces[o] * dx + faces[o + 1] * dy + faces[o + 2] * dz > 0 ? 1 : 0;
    }
    const out: number[] = [];
    for (let e = 0; e < smoothFaces.length / 2; e++) {
        if (front[smoothFaces[e * 2]] !== front[smoothFaces[e * 2 + 1]]) {
            const o = e * 6;
            out.push(smooth[o], smooth[o + 1], smooth[o + 2], smooth[o + 3], smooth[o + 4], smooth[o + 5]);
        }
    }
    return new Float32Array(out);
};
