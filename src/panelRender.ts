// Panel render engine (option B spike): draws the Forma scene with three.js inside the panel,
// so line weight, lighting and presets are fully ours. Loaded lazily from RenderEngine.tsx.
//
// Forma world space is metres, Z up, so the camera simply uses Z as "up".

import {
    AmbientLight, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight,
    Mesh, MeshLambertMaterial, OrthographicCamera, PCFShadowMap, PerspectiveCamera, Scene,
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
}

export const PRESETS: Record<string, RenderStyle> = {
    'Line drawing': {
        background: '#ffffff', transparent: false, contextMode: 'shown', shadowOpacity: 0.35, buildingColour: '#ffffff', contextColour: '#ffffff', lineColour: '#111111',
        lineWeight: 1, silhouettes: true, silhouetteWeight: 2.5, depthWeight: 0.5,
        ambient: 1, sunIntensity: 0, shadows: false,
    },
    'Clay': {
        background: '#e9e6df', transparent: false, contextMode: 'shown', shadowOpacity: 0.35, buildingColour: '#f4f1ea', contextColour: '#d9d5cc', lineColour: '#3a3a3a',
        lineWeight: 1, silhouettes: true, silhouetteWeight: 2, depthWeight: 0.4,
        ambient: 0.45, sunIntensity: 0.9, shadows: true,
    },
    'Panel colours': {
        background: '#f5f5f5', transparent: false, contextMode: 'shown', shadowOpacity: 0.35, buildingColour: null, contextColour: '#e0e0e0', lineColour: '#222222',
        lineWeight: 1, silhouettes: true, silhouetteWeight: 2, depthWeight: 0.4,
        ambient: 0.6, sunIntensity: 0.7, shadows: true,
    },
    'Night': {
        background: '#0b1220', transparent: false, contextMode: 'shown', shadowOpacity: 0.35, buildingColour: '#1c2a44', contextColour: '#121a2b', lineColour: '#8fb4ff',
        lineWeight: 1, silhouettes: true, silhouetteWeight: 1.8, depthWeight: 0.3,
        ambient: 0.25, sunIntensity: 0.35, shadows: true,
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
/** Creases sharper than this (degrees) get a line. */
const EDGE_ANGLE = 20;

export class PanelRenderer {
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
    /** 0 with the sun below the horizon, rising to 1 by a few degrees of elevation. */
    private sunFade = 1;
    private width = 1;
    private height = 1;
    /** On-screen width in CSS pixels; line weights are defined against this, so exports scale up with the image. */
    private screenWidth = 1;

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
        // Direction z is the sine of the elevation: fade the sun out between 0 and 6 degrees.
        const t = Math.max(0, Math.min(1, this.sunDir.z / Math.sin((6 * Math.PI) / 180)));
        this.sunFade = t * t * (3 - 2 * t);
        this.updateSunLight();
        this.updateSunShadow();
    }

    private updateSunLight(): void {
        this.sunLight.intensity = this.style.sunIntensity * this.sunFade * LIGHT_SCALE;
        this.sunLight.castShadow = this.style.shadows && this.sunFade > 0;
    }

    /** Sun elevation in degrees implied by the current direction. */
    get sunElevation(): number {
        return (Math.asin(Math.max(-1, Math.min(1, this.sunDir.z))) * 180) / Math.PI;
    }

    private updateSunShadow(): void {
        const centre = this.bounds.getCenter(new Vector3());
        const r = Math.max(this.bounds.getBoundingSphere(new Sphere()).radius, 10);
        this.sunLight.target.position.copy(centre);
        this.sunLight.position.copy(centre).addScaledVector(this.sunDir, r * 3);
        const cam = this.sunLight.shadow.camera;
        cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
        cam.near = r * 0.5; cam.far = r * 6;
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
            return this.ortho;
        }
        this.perspective.fov = this.fov;
        this.perspective.aspect = aspect;
        this.perspective.near = near;
        this.perspective.far = far;
        this.perspective.position.copy(position);
        this.perspective.lookAt(target);
        this.perspective.updateProjectionMatrix();
        return this.perspective;
    }

    /** Recomputes silhouette segments when the view has changed since the last time. */
    private updateSilhouettes(camera: PerspectiveCamera | OrthographicCamera): void {
        if (!this.style.silhouettes || this.edgeSets.every((e) => e.smooth.length === 0)) {
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

    render(): void {
        const camera = this.activeCamera(this.width / this.height);
        const ratio = this.renderer.getPixelRatio();
        const resolution = new Vector3(this.width * ratio, this.height * ratio, 0);
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

    /** Renders at `width` pixels wide (same aspect as the screen), returns a PNG, then restores the screen size. */
    async exportPng(width: number): Promise<Blob> {
        const aspect = this.width / this.height;
        const prevWidth = this.width, prevHeight = this.height, prevRatio = this.renderer.getPixelRatio();
        const exportHeight = Math.round(width / aspect);
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(width, exportHeight, false);
        this.width = width;
        this.height = exportHeight;
        this.render();
        try {
            return await new Promise<Blob>((resolve, reject) =>
                this.renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
        } finally {
            this.resize(prevWidth, prevHeight, prevRatio);
            this.render();
        }
    }

    /**
     * Renders `steps` frames at `width` pixels wide, calling `prepare(i)` before each one (to change the
     * sun, say), and returns a copy of each frame. The screen size is restored at the end.
     */
    captureSequence(width: number, steps: number, prepare: (index: number) => void): HTMLCanvasElement[] {
        const aspect = this.width / this.height;
        const prevWidth = this.width, prevHeight = this.height, prevRatio = this.renderer.getPixelRatio();
        const frameHeight = Math.round(width / aspect);
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(width, frameHeight, false);
        this.width = width;
        this.height = frameHeight;
        const frames: HTMLCanvasElement[] = [];
        try {
            for (let i = 0; i < steps; i++) {
                prepare(i);
                this.render();
                const copy = document.createElement('canvas');
                copy.width = width;
                copy.height = frameHeight;
                copy.getContext('2d')!.drawImage(this.renderer.domElement, 0, 0);
                frames.push(copy);
            }
        } finally {
            this.resize(prevWidth, prevHeight, prevRatio);
            this.render();
        }
        return frames;
    }

    /** Width and height of the on-screen view, for planning export layouts. */
    get aspect(): number {
        return this.width / this.height;
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
        this.lines?.geometry.dispose();
        this.lineMaterial.dispose();
        this.silhouetteMaterial.dispose();
        this.silhouetteLines?.geometry.dispose();
        this.renderer.dispose();
    }
}
