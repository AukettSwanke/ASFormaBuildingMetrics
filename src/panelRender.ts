// Panel render engine (option B spike): draws the Forma scene with three.js inside the panel,
// so line weight, lighting and presets are fully ours. Loaded lazily from RenderEngine.tsx.
//
// Forma world space is metres, Z up, so the camera simply uses Z as "up".

import {
    AmbientLight, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, EdgesGeometry,
    Mesh, MeshLambertMaterial, OrthographicCamera, PCFShadowMap, PerspectiveCamera, Scene,
    Sphere, Vector3, WebGLRenderer,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

export interface RenderStyle {
    background: string;
    /** Flat colour for all buildings, or null to use the colours currently applied in the panel. */
    buildingColour: string | null;
    contextColour: string;
    lineColour: string;
    /** Line width in pixels at the on-screen size; scaled up automatically for exports. */
    lineWeight: number;
    /** 0–1 */
    ambient: number;
    /** 0–1 */
    sunIntensity: number;
    shadows: boolean;
}

export const PRESETS: Record<string, RenderStyle> = {
    'Line drawing': {
        background: '#ffffff', buildingColour: '#ffffff', contextColour: '#ffffff', lineColour: '#111111',
        lineWeight: 2, ambient: 1, sunIntensity: 0, shadows: false,
    },
    'Clay': {
        background: '#e9e6df', buildingColour: '#f4f1ea', contextColour: '#d9d5cc', lineColour: '#3a3a3a',
        lineWeight: 1.5, ambient: 0.45, sunIntensity: 0.9, shadows: true,
    },
    'Panel colours': {
        background: '#f5f5f5', buildingColour: null, contextColour: '#e0e0e0', lineColour: '#222222',
        lineWeight: 1.5, ambient: 0.6, sunIntensity: 0.7, shadows: true,
    },
    'Night': {
        background: '#0b1220', buildingColour: '#1c2a44', contextColour: '#121a2b', lineColour: '#8fb4ff',
        lineWeight: 1.5, ambient: 0.25, sunIntensity: 0.35, shadows: true,
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
    private lineMaterial = new LineMaterial({ color: 0x111111, linewidth: 2 });
    private buildingMeshes = new Map<string, Mesh>();
    private contextMesh: Mesh | null = null;
    private lines: LineSegments2 | null = null;
    private bounds = new Box3();
    private sphere = new Sphere();
    private cameraState: CameraInput | null = null;
    private fov = 45;
    private style: RenderStyle = PRESETS['Clay'];
    private panelColours = new Map<string, string>();
    private sunDir = new Vector3(0.4, -0.6, 0.7).normalize();
    private width = 1;
    private height = 1;
    /** On-screen width in CSS pixels; line weights are defined against this, so exports scale up with the image. */
    private screenWidth = 1;

    stats = { buildingTriangles: 0, contextTriangles: 0, edgeSegments: 0 };

    constructor(canvas: HTMLCanvasElement) {
        this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
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

        const edgeChunks: Float32Array[] = [];
        let edgeLength = 0, triangles = 0;
        for (const { path, position } of buildings) {
            if (position.length === 0) continue;
            const mesh = this.makeMesh(position, true);
            this.scene.add(mesh);
            this.buildingMeshes.set(path, mesh);
            triangles += position.length / 9;
            const edges = new EdgesGeometry(mesh.geometry, EDGE_ANGLE);
            const edgePositions = edges.getAttribute('position').array as Float32Array;
            edgeChunks.push(edgePositions);
            edgeLength += edgePositions.length;
            edges.dispose();
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
        this.refreshBounds();
        this.applyStyle(this.style, this.panelColours);
    }

    /** Everything that is not a building (terrain, trees, other elements). Pass null to remove. */
    setContext(position: Float32Array | null): void {
        if (this.contextMesh) { this.disposeMesh(this.contextMesh); this.contextMesh = null; }
        this.stats.contextTriangles = 0;
        if (position && position.length > 0) {
            this.contextMesh = this.makeMesh(position, false);
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
        this.renderer.setClearColor(new Color(style.background), 1);
        this.ambientLight.intensity = style.ambient * LIGHT_SCALE;
        this.sunLight.intensity = style.sunIntensity * LIGHT_SCALE;
        this.sunLight.castShadow = style.shadows;
        this.lineMaterial.color.set(style.lineColour);
        for (const [path, mesh] of this.buildingMeshes) {
            (mesh.material as MeshLambertMaterial).color.set(
                style.buildingColour ?? panelColours.get(path) ?? '#cccccc',
            );
        }
        if (this.contextMesh) (this.contextMesh.material as MeshLambertMaterial).color.set(style.contextColour);
    }

    /** `direction` points from the scene towards the sun. */
    setSunDirection(direction: [number, number, number]): void {
        this.sunDir.set(...direction).normalize();
        this.updateSunShadow();
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

    render(): void {
        const camera = this.activeCamera(this.width / this.height);
        const ratio = this.renderer.getPixelRatio();
        this.lineMaterial.resolution.set(this.width * ratio, this.height * ratio);
        // Line width is in device pixels: weight is CSS px on screen, scaled up in proportion for exports.
        this.lineMaterial.linewidth = this.style.lineWeight * (this.width * ratio) / this.screenWidth;
        if (!camera) { this.renderer.clear(); return; }
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

    gpuInfo(): string {
        const gl = this.renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';
    }

    dispose(): void {
        for (const mesh of this.buildingMeshes.values()) this.disposeMesh(mesh);
        if (this.contextMesh) this.disposeMesh(this.contextMesh);
        this.lines?.geometry.dispose();
        this.lineMaterial.dispose();
        this.renderer.dispose();
    }
}
