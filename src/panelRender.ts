// Panel render engine: draws the Forma scene with three.js inside the panel,
// so line weight, lighting and presets are fully ours. Loaded lazily from RenderEngine.tsx.
//
// Forma world space is metres, Z up, so the camera simply uses Z as "up".

import {
    AmbientLight, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight,
    Mesh, MeshLambertMaterial, OrthographicCamera, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Scene,
    ShadowMaterial, Sphere, Vector3, Vector4, WebGLRenderer,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { EdgeSet, buildEdgeSet, findSilhouettes } from './silhouette';

/**
 * Screen-space line material whose width varies with distance from the camera. The width is
 * multiplied per segment end, so long edges taper smoothly towards the distant end.
 * `depthRange` = (near distance, far distance, scale at near, scale at far).
 */
class DepthLineMaterial extends LineMaterial {
    readonly depthRange = new Vector4(0, 1, 1, 1);

    constructor(parameters: ConstructorParameters<typeof LineMaterial>[0]) {
        super(parameters);
        this.uniforms.depthRange = { value: this.depthRange };
        const patched = this.vertexShader
            .replace('uniform float linewidth;', 'uniform float linewidth;\n\t\tuniform vec4 depthRange;')
            .replace('offset *= linewidth;', `vec4 depthPoint = ( position.y < 0.5 ) ? start : end;
\t\t\t\tfloat depthT = clamp( ( - depthPoint.z - depthRange.x ) / max( depthRange.y - depthRange.x, 0.001 ), 0.0, 1.0 );
\t\t\t\toffset *= linewidth * mix( depthRange.z, depthRange.w, depthT );`);
        if (patched === this.vertexShader || !patched.includes('depthRange')) {
            console.warn('Depth-weighted lines: three.js line shader changed, depth weighting is disabled.');
        } else {
            this.vertexShader = patched;
        }
        this.needsUpdate = true;
    }
}

/** How everything that is not a building (terrain, trees, other elements) is drawn. */
export type ContextMode = 'shown' | 'shadows' | 'hidden';

export interface RenderStyle {
    background: string;
    /** Leave the background transparent (PNG alpha). The colour above is then ignored. */
    transparent: boolean;
    /** `shadows` draws only the shadows falling on the context, so the ground stays see-through. */
    contextMode: ContextMode;
    /** Darkness of context shadows, 0–1, used by `shadows` mode. */
    shadowOpacity: number;
    /** Flat colour for all buildings, or null to use the colours currently applied in the panel. */
    buildingColour: string | null;
    contextColour: string;
    lineColour: string;
    /** Crease line width in pixels at the on-screen size; scaled up automatically for exports. */
    lineWeight: number;
    /** Outline of curved and overlapping forms, found for the current view. */
    silhouettes: boolean;
    /** Silhouette line width in pixels. */
    silhouetteWeight: number;
    /** 0 = uniform lines, 1 = strong contrast between near (heavy) and far (light) lines. */
    depthWeight: number;
    /** 0–1 */
    ambient: number;
    /** 0–1 */
    sunIntensity: number;
    shadows: boolean;
    /**
     * Apparent size of the sun in degrees (0 = hard-edged shadows, the real sun is about 0.5). The
     * penumbra grows with distance from the object casting the shadow, as in life.
     */
    shadowSoftness: number;
}

export const PRESETS: Record<string, RenderStyle> = {
    'Line drawing': {
        background: '#ffffff', transparent: false, contextMode: 'shown', shadowOpacity: 0.35, buildingColour: '#ffffff', contextColour: '#ffffff', lineColour: '#111111',
        lineWeight: 1, silhouettes: true, silhouetteWeight: 2.5, depthWeight: 0.5,
        ambient: 1, sunIntensity: 0, shadows: false, shadowSoftness: 0,
    },
    'Clay': {
        background: '#e9e6df', transparent: false, contextMode: 'shown', shadowOpacity: 0.35, buildingColour: '#f4f1ea', contextColour: '#d9d5cc', lineColour: '#3a3a3a',
        lineWeight: 1, silhouettes: true, silhouetteWeight: 2, depthWeight: 0.4,
        ambient: 0.45, sunIntensity: 0.9, shadows: true, shadowSoftness: 0,
    },
    'Panel colours': {
        background: '#f5f5f5', transparent: false, contextMode: 'shown', shadowOpacity: 0.35, buildingColour: null, contextColour: '#e0e0e0', lineColour: '#222222',
        lineWeight: 1, silhouettes: true, silhouetteWeight: 2, depthWeight: 0.4,
        ambient: 0.6, sunIntensity: 0.7, shadows: true, shadowSoftness: 0,
    },
    'Night': {
        background: '#0b1220', transparent: false, contextMode: 'shown', shadowOpacity: 0.35, buildingColour: '#1c2a44', contextColour: '#121a2b', lineColour: '#8fb4ff',
        lineWeight: 1, silhouettes: true, silhouetteWeight: 1.8, depthWeight: 0.3,
        ambient: 0.25, sunIntensity: 0.35, shadows: true, shadowSoftness: 0,
    },
};

export interface CameraInput {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    type: 'perspective' | 'orthographic';
}

export interface BuildingInput {
    path: string;
    position: Float32Array;
}

/** three.js lights are not normalised any more, so 1 here means "albedo shows at full strength". */
const LIGHT_SCALE = Math.PI;
/** Renders averaged for soft shadows in exports: enough that the penumbra looks smooth at full size. */
const EXPORT_SOFT_SAMPLES = 32;
/** Creases sharper than this (degrees) get a line. */
const EDGE_ANGLE = 20;

export class PanelRenderer {
    /** Largest band (in pixels) drawn at once while averaging soft shadows. Static so tests can shrink it. */
    static softBandPixels = 1_500_000;

    readonly renderer: WebGLRenderer;
    private scene = new Scene();
    private perspective = new PerspectiveCamera(45, 1, 1, 10000);
    private ortho = new OrthographicCamera(-1, 1, 1, -1, 1, 10000);
    private ambientLight = new AmbientLight(0xffffff, 1);
    private sunLight = new DirectionalLight(0xffffff, 1);
    private lineMaterial = new DepthLineMaterial({ color: 0x111111, linewidth: 2, alphaToCoverage: true });
    private silhouetteMaterial = new DepthLineMaterial({ color: 0x111111, linewidth: 2, alphaToCoverage: true });
    private silhouetteLines: LineSegments2 | null = null;
    private edgeSets: EdgeSet[] = [];
    /** Camera pose the silhouettes were last computed for. */
    private silhouetteKey = '';
    private buildingSphere = new Sphere();
    private buildingMeshes = new Map<string, Mesh>();
    private contextMesh: Mesh | null = null;
    /** The context uses one of these two materials depending on `contextMode`; both are owned here. */
    private contextLambert: MeshLambertMaterial | null = null;
    /**
     * Layered-shadow rendering. In a mask pass only the shadows falling on the ground are drawn (buildings
     * stay in as invisible depth blockers); `noShadows` draws the plain scene with no shadows at all.
     */
    private maskPass = false;
    private noShadows = false;
    private maskMaterial = new ShadowMaterial({
        opacity: 1, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    /** A flat ground used for the mask pass when there is no context mesh to catch shadows. */
    private catcher: Mesh | null = null;
    private shadowMaterial = new ShadowMaterial({
        opacity: 0.35, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    private lines: LineSegments2 | null = null;
    private bounds = new Box3();
    private sphere = new Sphere();
    private cameraState: CameraInput | null = null;
    private fov = 45;
    private style: RenderStyle = PRESETS['Clay'];
    private panelColours = new Map<string, string>();
    private sunDir = new Vector3(0.4, -0.6, 0.7).normalize();
    /**
     * While averaging large frames, only a horizontal band of the view is drawn at a time (so the buffers
     * stay small). `y` is the band's first row and `rows` its height, in pixels of the full frame.
     */
    private band: { y: number; rows: number } | null = null;
    /** Direction the light actually comes from: the sun, or a nudged copy while averaging soft shadows. */
    private lightDir = new Vector3(0.4, -0.6, 0.7).normalize();
    /** 0 with the sun below the horizon, rising to 1 by a few degrees of elevation. */
    private sunFade = 1;
    private width = 1;
    private height = 1;
    /** On-screen width in CSS pixels; line weights are defined against this, so exports scale up with the image. */
    private screenWidth = 1;
    /**
     * Width over height of the frame as asked for (16:9, say), kept unrounded so exports come out at
     * exactly that ratio rather than at the ratio of the rounded on-screen pixel size.
     */
    private frameAspect = 1;

    stats = { buildingTriangles: 0, contextTriangles: 0, edgeSegments: 0, smoothEdges: 0, silhouetteSegments: 0 };

    constructor(canvas: HTMLCanvasElement) {
        this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = PCFShadowMap;
        this.perspective.up.set(0, 0, 1);
        this.ortho.up.set(0, 0, 1);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.set(2048, 2048);
        this.sunLight.shadow.bias = -0.0004;
        this.sunLight.shadow.normalBias = 0.3;
        this.scene.add(this.ambientLight, this.sunLight, this.sunLight.target);
    }

    // ---- geometry ----

    private makeGeometry(position: Float32Array): BufferGeometry {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(position, 3));
        geometry.computeVertexNormals(); // non-indexed, so normals are flat per face
        return geometry;
    }

    private makeMesh(position: Float32Array, shadowCaster: boolean): Mesh {
        const material = new MeshLambertMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const mesh = new Mesh(this.makeGeometry(position), material);
        mesh.castShadow = shadowCaster;
        mesh.receiveShadow = true;
        return mesh;
    }

    setBuildings(buildings: BuildingInput[]): void {
        for (const mesh of this.buildingMeshes.values()) this.disposeMesh(mesh);
        this.buildingMeshes.clear();
        if (this.lines) { this.scene.remove(this.lines); this.lines.geometry.dispose(); this.lines = null; }

        this.edgeSets = [];
        this.silhouetteKey = '';
        if (this.silhouetteLines) {
            this.scene.remove(this.silhouetteLines);
            this.silhouetteLines.geometry.dispose();
            this.silhouetteLines = null;
        }
        const edgeChunks: Float32Array[] = [];
        let edgeLength = 0, triangles = 0;
        for (const { path, position } of buildings) {
            if (position.length === 0) continue;
            const mesh = this.makeMesh(position, true);
            this.scene.add(mesh);
            this.buildingMeshes.set(path, mesh);
            triangles += position.length / 9;
            const set = buildEdgeSet(position, EDGE_ANGLE);
            this.edgeSets.push(set);
            edgeChunks.push(set.hard);
            edgeLength += set.hard.length;
        }
        if (edgeLength > 0) {
            const all = new Float32Array(edgeLength);
            let offset = 0;
            for (const chunk of edgeChunks) { all.set(chunk, offset); offset += chunk.length; }
            const geometry = new LineSegmentsGeometry();
            geometry.setPositions(all);
            this.lines = new LineSegments2(geometry, this.lineMaterial);
            this.lines.frustumCulled = false;
            this.scene.add(this.lines);
        }
        this.stats.buildingTriangles = triangles;
        this.stats.edgeSegments = edgeLength / 6;
        this.stats.smoothEdges = this.edgeSets.reduce((n, e) => n + e.smooth.length / 6, 0);
        this.refreshBounds();
        this.applyStyle(this.style, this.panelColours);
    }

    /** Everything that is not a building (terrain, trees, other elements). Pass null to remove. */
    setContext(position: Float32Array | null): void {
        if (this.contextMesh) {
            this.scene.remove(this.contextMesh);
            this.contextMesh.geometry.dispose();
            this.contextLambert?.dispose();
            this.contextMesh = null;
            this.contextLambert = null;
        }
        this.stats.contextTriangles = 0;
        if (position && position.length > 0) {
            this.contextMesh = this.makeMesh(position, false);
            this.contextLambert = this.contextMesh.material as MeshLambertMaterial;
            this.scene.add(this.contextMesh);
            this.stats.contextTriangles = position.length / 9;
        }
        this.refreshBounds();
        this.applyStyle(this.style, this.panelColours);
    }

    private disposeMesh(mesh: Mesh): void {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as MeshLambertMaterial).dispose();
    }

    private refreshBounds(): void {
        // Shadows and clipping are fitted to the buildings; context only stretches the far plane.
        this.bounds.makeEmpty();
        for (const mesh of this.buildingMeshes.values()) {
            mesh.geometry.computeBoundingBox();
            this.bounds.union(mesh.geometry.boundingBox!);
        }
        if (this.bounds.isEmpty() && this.contextMesh) {
            this.contextMesh.geometry.computeBoundingBox();
            this.bounds.copy(this.contextMesh.geometry.boundingBox!);
        }
        if (this.bounds.isEmpty()) this.bounds.set(new Vector3(-50, -50, 0), new Vector3(50, 50, 50));
        this.bounds.getBoundingSphere(this.sphere);
        this.buildingSphere.copy(this.sphere);
        if (this.contextMesh) {
            this.contextMesh.geometry.computeBoundingSphere();
            const cs = this.contextMesh.geometry.boundingSphere!;
            this.sphere.union(cs);
        }
        this.updateSunShadow();
    }

    // ---- style and light ----

    applyStyle(style: RenderStyle, panelColours: Map<string, string>): void {
        this.style = style;
        this.panelColours = panelColours;
        this.renderer.setClearColor(new Color(style.background), style.transparent ? 0 : 1);
        this.ambientLight.intensity = style.ambient * LIGHT_SCALE;
        this.updateSunLight();
        this.lineMaterial.color.set(style.lineColour);
        this.silhouetteMaterial.color.set(style.lineColour);
        if (this.silhouetteLines) this.silhouetteLines.visible = style.silhouettes;
        for (const [path, mesh] of this.buildingMeshes) {
            (mesh.material as MeshLambertMaterial).color.set(
                style.buildingColour ?? panelColours.get(path) ?? '#cccccc',
            );
        }
        if (this.contextMesh && this.contextLambert) {
            this.contextLambert.color.set(style.contextColour);
            this.shadowMaterial.opacity = style.shadowOpacity;
            this.contextMesh.visible = style.contextMode !== 'hidden';
            this.contextMesh.material = style.contextMode === 'shadows' ? this.shadowMaterial : this.contextLambert;
        }
    }

    /** `direction` points from the scene towards the sun. */
    setSunDirection(direction: [number, number, number]): void {
        this.sunDir.set(...direction).normalize();
        this.lightDir.copy(this.sunDir);
        // Direction z is the sine of the elevation: fade the sun out between 0 and 6 degrees.
        const t = Math.max(0, Math.min(1, this.sunDir.z / Math.sin((6 * Math.PI) / 180)));
        this.sunFade = t * t * (3 - 2 * t);
        this.updateSunLight();
        this.updateSunShadow();
    }

    private updateSunLight(): void {
        this.sunLight.intensity = this.style.sunIntensity * this.sunFade * LIGHT_SCALE;
        this.sunLight.castShadow = !this.noShadows && (this.maskPass || this.style.shadows) && this.sunFade > 0;
    }

    /** Sun elevation in degrees implied by the current direction. */
    get sunElevation(): number {
        return (Math.asin(Math.max(-1, Math.min(1, this.sunDir.z))) * 180) / Math.PI;
    }

    /** Longest shadow worth drawing, in metres. Low sun throws very long shadows; past this they are cut off. */
    private shadowCap(): number {
        return Math.min(Math.max(this.buildingSphere.radius * 12, 300), 1500);
    }

    /**
     * Points the sun at the scene and fits its shadow camera around the buildings *and* the ground their
     * shadows reach. Fitting to the buildings alone clips every shadow that runs further than that, which
     * is nearly all of them at low sun.
     */
    private updateSunShadow(): void {
        const centre = this.bounds.getCenter(new Vector3());
        const r = Math.max(this.buildingSphere.radius, 10);
        const position = centre.clone().addScaledVector(this.lightDir, r * 3);
        this.sunLight.target.position.copy(centre);
        this.sunLight.position.copy(position);

        // A camera standing where the shadow camera stands, to measure everything in the light's own view.
        const cam = this.sunLight.shadow.camera;
        const view = new OrthographicCamera();
        view.position.copy(position);
        view.up.copy(cam.up);
        view.lookAt(centre);
        view.updateMatrixWorld();
        const inverse = view.matrixWorldInverse.copy(view.matrixWorld).invert();

        const { min, max } = this.bounds;
        const groundZ = min.z;
        const cap = this.shadowCap();
        const dir = this.lightDir;
        const points: Vector3[] = [];
        for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
            const corner = new Vector3(x, y, z);
            points.push(corner);
            // Where this corner's shadow lands on the ground, no further than the cap.
            const along = dir.z > 0.02 ? Math.min((z - groundZ) / dir.z, cap) : cap;
            points.push(corner.clone().addScaledVector(dir, -along));
        }
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const point of points) {
            const v = point.applyMatrix4(inverse);
            minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
            minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
            minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
        }
        const pad = Math.max(2, r * 0.05);
        const depthSlack = Math.max(r, 50); // room for terrain above or below the lowest building point
        cam.left = minX - pad; cam.right = maxX + pad;
        cam.bottom = minY - pad; cam.top = maxY + pad;
        cam.near = Math.max(0.1, -maxZ - depthSlack);
        cam.far = -minZ + depthSlack;
        cam.updateProjectionMatrix();
        this.sunLight.target.updateMatrixWorld();
        this.sunLight.shadow.needsUpdate = true;
    }

    // ---- view ----

    setView(camera: CameraInput, fovDegrees: number): void {
        this.cameraState = camera;
        this.fov = fovDegrees;
    }

    resize(width: number, height: number, pixelRatio: number): void {
        this.frameAspect = Math.max(1e-3, width) / Math.max(1e-3, height);
        this.width = Math.max(1, Math.round(width));
        this.height = Math.max(1, Math.round(height));
        this.screenWidth = this.width;
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setSize(this.width, this.height, false);
    }

    private activeCamera(aspect: number): PerspectiveCamera | OrthographicCamera | null {
        const s = this.cameraState;
        if (!s) return null;
        const position = new Vector3(s.position.x, s.position.y, s.position.z);
        const target = new Vector3(s.target.x, s.target.y, s.target.z);
        const distance = Math.max(position.distanceTo(target), 1);
        const near = Math.max(0.5, distance * 0.02);
        const far = distance + this.sphere.radius * 2 + 200;
        if (s.type === 'orthographic') {
            const halfH = distance * Math.tan((this.fov * Math.PI) / 360);
            Object.assign(this.ortho, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH, near, far });
            this.ortho.position.copy(position);
            this.ortho.lookAt(target);
            this.ortho.updateProjectionMatrix();
            this.applyBand(this.ortho);
            return this.ortho;
        }
        this.perspective.fov = this.fov;
        this.perspective.aspect = aspect;
        this.perspective.near = near;
        this.perspective.far = far;
        this.perspective.position.copy(position);
        this.perspective.lookAt(target);
        this.perspective.updateProjectionMatrix();
        this.applyBand(this.perspective);
        return this.perspective;
    }

    /** Recomputes silhouette segments when the view has changed since the last time. */
    private updateSilhouettes(camera: PerspectiveCamera | OrthographicCamera): void {
        if (this.maskPass || !this.style.silhouettes || this.edgeSets.every((e) => e.smooth.length === 0)) {
            if (this.silhouetteLines) this.silhouetteLines.visible = false;
            this.stats.silhouetteSegments = 0;
            return;
        }
        const p = camera.position;
        const key = `${camera instanceof PerspectiveCamera ? 'p' : 'o'}${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`
            + `|${this.cameraState?.target.x},${this.cameraState?.target.y},${this.cameraState?.target.z}`;
        if (key === this.silhouetteKey && this.silhouetteLines) {
            this.silhouetteLines.visible = true;
            return;
        }
        this.silhouetteKey = key;
        const look = new Vector3();
        camera.getWorldDirection(look);
        const view = camera instanceof PerspectiveCamera
            ? { kind: 'perspective' as const, x: p.x, y: p.y, z: p.z }
            : { kind: 'orthographic' as const, x: look.x, y: look.y, z: look.z };
        const chunks = this.edgeSets.map((set) => findSilhouettes(set, view));
        const total = chunks.reduce((n, c) => n + c.length, 0);
        this.stats.silhouetteSegments = total / 6;
        if (total === 0) {
            if (this.silhouetteLines) this.silhouetteLines.visible = false;
            return;
        }
        const all = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
        if (!this.silhouetteLines) {
            this.silhouetteLines = new LineSegments2(new LineSegmentsGeometry(), this.silhouetteMaterial);
            this.silhouetteLines.frustumCulled = false;
            this.scene.add(this.silhouetteLines);
        } else {
            this.silhouetteLines.geometry.dispose(); // frees the previous GPU buffers
        }
        this.silhouetteLines.geometry.setPositions(all);
        this.silhouetteLines.visible = true;
    }

    /** Points the camera at the current band of the frame, or at the whole frame when there is no band. */
    private applyBand(camera: PerspectiveCamera | OrthographicCamera): void {
        if (this.band) camera.setViewOffset(this.width, this.height, 0, this.band.y, this.width, this.band.rows);
        else camera.clearViewOffset();
    }

    render(): void {
        const camera = this.activeCamera(this.frameAspect);
        const ratio = this.renderer.getPixelRatio();
        const resolution = new Vector3(this.width * ratio, (this.band ? this.band.rows : this.height) * ratio, 0);
        this.lineMaterial.resolution.set(resolution.x, resolution.y);
        this.silhouetteMaterial.resolution.set(resolution.x, resolution.y);
        // Line widths are in device pixels: weights are CSS px on screen, scaled up in proportion for exports.
        const scale = resolution.x / this.screenWidth;
        this.lineMaterial.linewidth = this.style.lineWeight * scale;
        this.silhouetteMaterial.linewidth = this.style.silhouetteWeight * scale;
        if (!camera) { this.renderer.clear(); return; }

        // Depth weighting: heavy near the camera, light far away, equal at the middle of the buildings.
        const distance = camera.position.distanceTo(this.buildingSphere.center);
        const near = Math.max(0.1, distance - this.buildingSphere.radius);
        const far = Math.max(near + 1, distance + this.buildingSphere.radius);
        const a = this.style.depthWeight;
        this.lineMaterial.depthRange.set(near, far, 1 + a, Math.max(0.1, 1 - a));
        this.silhouetteMaterial.depthRange.copy(this.lineMaterial.depthRange);

        this.updateSilhouettes(camera);
        this.renderer.render(this.scene, camera);
    }

    /** True when shadows should be softened by averaging several renders. */
    private get softShadows(): boolean {
        return !this.noShadows && (this.maskPass || this.style.shadows) && this.style.shadowSoftness > 0 && this.sunFade > 0;
    }

    /**
     * A point on a disk of angular diameter `diameterDeg` around `base`, for sample `i` of `n`. The points
     * follow a sunflower pattern, so any number of samples covers the disk evenly.
     */
    private jitteredDirection(base: Vector3, diameterDeg: number, i: number, n: number): Vector3 {
        const radius = Math.tan((diameterDeg * Math.PI) / 360) * Math.sqrt((i + 0.5) / n);
        const angle = i * 2.399963; // the golden angle
        const helper = Math.abs(base.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
        const u = new Vector3().crossVectors(base, helper).normalize();
        const v = new Vector3().crossVectors(base, u);
        return base.clone().addScaledVector(u, radius * Math.cos(angle)).addScaledVector(v, radius * Math.sin(angle)).normalize();
    }

    /**
     * Renders the current view `samples` times with the sun moved around its apparent disk and averages
     * the results, which gives smooth shadow edges that widen with distance from the occluder.
     *
     * The average is kept in floating point (an 8-bit running mean loses the later samples to rounding).
     * Large frames are drawn in bands of at most `softBandPixels` pixels, so memory stays bounded at any
     * export size. Colours are weighted by alpha, so transparent backgrounds average correctly.
     */
    private renderAveraged(samples: number): HTMLCanvasElement {
        const source = this.renderer.domElement;
        const ratio = this.renderer.getPixelRatio();
        const width = source.width, height = source.height;
        const out = document.createElement('canvas');
        out.width = width;
        out.height = height;
        const outCtx = out.getContext('2d')!;
        const scratch = document.createElement('canvas');
        const scratchCtx = scratch.getContext('2d', { willReadFrequently: true })!;
        const base = this.sunDir.clone();
        // Bands change the renderer size, which is only exact at a pixel ratio of 1 (exports); the
        // on-screen preview is small enough to draw in one go.
        const bandRows = ratio === 1 ? Math.max(64, Math.floor(PanelRenderer.softBandPixels / width)) : height;
        let banded = false;
        try {
            for (let y0 = 0; y0 < height; y0 += bandRows) {
                const rows = Math.min(bandRows, height - y0);
                if (rows !== height) {
                    banded = true;
                    this.band = { y: y0, rows };
                    this.renderer.setSize(width, rows, false);
                }
                scratch.width = width;
                scratch.height = rows;
                const colour = new Float32Array(width * rows * 3);
                const alpha = new Float32Array(width * rows);
                for (let i = 0; i < samples; i++) {
                    this.lightDir.copy(this.jitteredDirection(base, this.style.shadowSoftness, i, samples));
                    this.updateSunShadow();
                    this.render();
                    scratchCtx.clearRect(0, 0, width, rows);
                    scratchCtx.drawImage(source, 0, 0);
                    const px = scratchCtx.getImageData(0, 0, width, rows).data;
                    for (let p = 0, q = 0; p < alpha.length; p++, q += 4) {
                        const a = px[q + 3] / 255;
                        colour[p * 3] += px[q] * a;
                        colour[p * 3 + 1] += px[q + 1] * a;
                        colour[p * 3 + 2] += px[q + 2] * a;
                        alpha[p] += a;
                    }
                }
                const image = outCtx.createImageData(width, rows);
                for (let p = 0, q = 0; p < alpha.length; p++, q += 4) {
                    const a = alpha[p];
                    if (a > 0) {
                        image.data[q] = Math.round(colour[p * 3] / a);
                        image.data[q + 1] = Math.round(colour[p * 3 + 1] / a);
                        image.data[q + 2] = Math.round(colour[p * 3 + 2] / a);
                    }
                    image.data[q + 3] = Math.round((a / samples) * 255);
                }
                outCtx.putImageData(image, 0, y0);
            }
        } finally {
            this.band = null;
            if (banded) this.renderer.setSize(this.width, this.height, false);
            this.lightDir.copy(base);
            this.updateSunShadow();
        }
        return out;
    }

    /**
     * Soft-shadow version of the current on-screen view, or null when shadows are hard. The caller shows
     * it once the camera has been still for a moment; moving the camera falls back to the quick hard render.
     */
    renderSoftPreview(samples = 16): HTMLCanvasElement | null {
        if (!this.softShadows) return null;
        try {
            return this.renderAveraged(samples);
        } finally {
            this.render(); // leave the visible canvas showing the plain render
        }
    }

    /** Renders at `width` pixels wide (same aspect as the screen), returns a PNG, then restores the screen size. */
    async exportPng(width: number): Promise<Blob> {
        const restore = this.useExportSize(width);
        this.render();
        try {
            // Soft shadows are averaged over several renders; hard ones come straight from the canvas.
            const source = this.softShadows ? this.renderAveraged(EXPORT_SOFT_SAMPLES) : this.renderer.domElement;
            return await new Promise<Blob>((resolve, reject) =>
                source.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
        } finally {
            restore();
        }
    }

    /**
     * Switches the renderer to an export frame `width` pixels wide at the frame's aspect ratio and a pixel
     * ratio of 1. Returns a function that puts the on-screen size back and redraws.
     */
    private useExportSize(width: number): () => void {
        const prev = { width: this.width, height: this.height, ratio: this.renderer.getPixelRatio(), aspect: this.frameAspect };
        this.width = width;
        this.height = Math.max(1, Math.round(width / this.frameAspect));
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(this.width, this.height, false);
        return () => {
            this.resize(prev.width, prev.height, prev.ratio);
            this.frameAspect = prev.aspect;
            this.render();
        };
    }

    private copyCanvas(): HTMLCanvasElement {
        const source = this.renderer.domElement;
        const copy = document.createElement('canvas');
        copy.width = source.width;
        copy.height = source.height;
        copy.getContext('2d')!.drawImage(source, 0, 0);
        return copy;
    }

    private getCatcher(): Mesh {
        if (!this.catcher) {
            this.catcher = new Mesh(new PlaneGeometry(1, 1), this.maskMaterial);
            this.catcher.receiveShadow = true;
            this.scene.add(this.catcher);
        }
        const centre = this.bounds.getCenter(new Vector3());
        const size = 2 * (this.buildingSphere.radius + this.shadowCap()) + 100;
        this.catcher.position.set(centre.x, centre.y, this.bounds.min.z - 0.01);
        this.catcher.scale.set(size, size, 1);
        this.catcher.updateMatrixWorld();
        return this.catcher;
    }

    /** Draws only the shadows falling on the ground: transparent everywhere else, and behind buildings. */
    private enterMaskPass(): void {
        this.maskPass = true;
        for (const mesh of this.buildingMeshes.values()) (mesh.material as MeshLambertMaterial).colorWrite = false;
        if (this.lines) this.lines.visible = false;
        if (this.silhouetteLines) this.silhouetteLines.visible = false;
        if (this.contextMesh && this.style.contextMode !== 'hidden') {
            // Real terrain catches the shadows, so they follow the ground's shape.
            this.contextMesh.visible = true;
            this.contextMesh.material = this.maskMaterial;
            if (this.catcher) this.catcher.visible = false;
        } else {
            if (this.contextMesh) this.contextMesh.visible = false;
            this.getCatcher().visible = true;
        }
        this.renderer.setClearColor(new Color(0x000000), 0);
        this.updateSunLight();
    }

    private exitMaskPass(): void {
        this.maskPass = false;
        for (const mesh of this.buildingMeshes.values()) (mesh.material as MeshLambertMaterial).colorWrite = true;
        if (this.lines) this.lines.visible = true;
        if (this.catcher) this.catcher.visible = false;
        this.applyStyle(this.style, this.panelColours); // restores the clear colour, context and sun
    }

    /**
     * For a layered shadow image: one `base` render of the scene with no shadows (lit as step `reference`),
     * and one shadow `mask` per step, transparent except where that step's sun casts a shadow on the ground.
     * The masks respect the buildings, so a shadow behind a building is hidden. Soft shadows are averaged
     * the same way as in exports. `prepare(i)` moves the sun to step `i`; the screen size is restored after.
     */
    captureShadowLayers(
        width: number, steps: number, prepare: (index: number) => void, reference: number,
    ): { base: HTMLCanvasElement; masks: HTMLCanvasElement[] } {
        const restore = this.useExportSize(width);
        const masks: HTMLCanvasElement[] = [];
        let base: HTMLCanvasElement;
        try {
            prepare(reference);
            this.noShadows = true;
            this.updateSunLight();
            this.render();
            base = this.copyCanvas();
            this.noShadows = false;
            this.enterMaskPass();
            for (let i = 0; i < steps; i++) {
                prepare(i);
                this.render();
                masks.push(this.softShadows ? this.renderAveraged(EXPORT_SOFT_SAMPLES) : this.copyCanvas());
            }
        } finally {
            this.noShadows = false;
            if (this.maskPass) this.exitMaskPass();
            restore();
        }
        return { base, masks };
    }

    /**
     * Renders `steps` frames at `width` pixels wide, calling `prepare(i)` before each one (to change the
     * sun, say), and returns a copy of each frame. The screen size is restored at the end.
     */
    captureSequence(width: number, steps: number, prepare: (index: number) => void): HTMLCanvasElement[] {
        const restore = this.useExportSize(width);
        const frameHeight = this.height;
        const frames: HTMLCanvasElement[] = [];
        try {
            for (let i = 0; i < steps; i++) {
                prepare(i);
                this.render();
                if (this.softShadows) {
                    frames.push(this.renderAveraged(EXPORT_SOFT_SAMPLES));
                    continue;
                }
                const copy = document.createElement('canvas');
                copy.width = width;
                copy.height = frameHeight;
                copy.getContext('2d')!.drawImage(this.renderer.domElement, 0, 0);
                frames.push(copy);
            }
        } finally {
            restore();
        }
        return frames;
    }

    /** Width over height of the frame, for planning export layouts. */
    get aspect(): number {
        return this.frameAspect;
    }

    gpuInfo(): string {
        const gl = this.renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';
    }

    dispose(): void {
        for (const mesh of this.buildingMeshes.values()) this.disposeMesh(mesh);
        if (this.contextMesh) {
            this.scene.remove(this.contextMesh);
            this.contextMesh.geometry.dispose();
            this.contextLambert?.dispose();
        }
        this.shadowMaterial.dispose();
        this.maskMaterial.dispose();
        if (this.catcher) { this.scene.remove(this.catcher); this.catcher.geometry.dispose(); }
        this.lines?.geometry.dispose();
        this.lineMaterial.dispose();
        this.silhouetteMaterial.dispose();
        this.silhouetteLines?.geometry.dispose();
        this.renderer.dispose();
    }
}
