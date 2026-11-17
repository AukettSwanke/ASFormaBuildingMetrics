// Mounts <RenderEngine> on its own against the Forma stub. Exposes mount(canEdit) and unmount().
import { render } from 'preact';
import '../../src/style.css';
import { RenderEngine } from '../../src/render/RenderEngine';
import '../stubs/forma';

const g = globalThis as any;

g.mount = (canEdit = true) => {
    const paths = Object.keys(g.__formaScene.buildings);
    const colours = new Map(paths.map((p, i) => [p, ['#e07a5f', '#3d85c6', '#81b29a'][i % 3]]));
    render(<RenderEngine buildingPaths={paths} panelColours={colours} canEdit={canEdit} disabled={false} />,
        document.getElementById('app')!);
};
g.unmount = () => render(null, document.getElementById('app')!);
