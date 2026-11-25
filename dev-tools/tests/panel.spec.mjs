// Drives the whole panel (src/index.tsx) against the Forma stub: tabs, the metrics workflow, that
// the render keeps its loaded scene while other tabs are shown, and copying work to another project.

import { mkdirSync, readFileSync } from 'node:fs';

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
};
const test = async (name, body) => {
    try { await body(); } catch (error) { check(`${name} (threw)`, false, String(error?.message ?? error).split('\n')[0]); }
};
const calls = (page, name) => page.evaluate((n) => globalThis.__formaCalls.filter((c) => c.name === n).length, name);
const selectedTab = (page) => page.$eval('[role="tab"][aria-selected="true"]', (t) => t.textContent);

export const runPanelTests = async ({ openPage }) => {
    const { page, context, errors } = await openPage();
    await page.locator('.building-row[role="button"]').first().waitFor({ timeout: 15000 });

    await test('tabs', async () => {
        const names = await page.getByRole('tab').allTextContents();
        check('tabs: Metrics, Render and Data, Metrics first', names.join('|') === 'Metrics|Render|Data'
            && await selectedTab(page) === 'Metrics', names);
        await page.getByRole('tab', { name: 'Metrics' }).focus();
        await page.keyboard.press('ArrowRight');
        check('tabs: arrow keys move between tabs', await selectedTab(page) === 'Render'
            && await page.locator('#panel-render').isVisible() && !(await page.locator('#panel-metrics').isVisible()));
        await page.keyboard.press('ArrowLeft');
    });

    await test('metrics', async () => {
        check('metrics: one row per building', await page.locator('.building-row[role="button"]').count() === 3);
        await page.locator('.building-row[role="button"]').first().click();
        check('metrics: selecting a row shows its details and moves the camera',
            await page.getByRole('heading', { name: 'Building 1' }).isVisible() && await calls(page, 'camera.move') === 1);

        await page.selectOption('#colour-mode', 'floors');
        check('colour: the legend follows the chosen measure', await page.getByText('15 floors and over').isVisible());
        await page.getByRole('button', { name: 'Apply colours' }).click();
        await page.getByText(/shows colours by floors/).waitFor({ timeout: 5000 });
        check('colour: Apply colours sets element colours and says what is shown', await calls(page, 'elementColors.set') === 1);
        await page.getByRole('button', { name: 'Clear colours' }).click();
        await page.getByText(/No selection needed/).waitFor({ timeout: 5000 });
        check('colour: Clear colours clears them', await calls(page, 'elementColors.clearAll') >= 1
            && await page.getByRole('button', { name: 'Clear colours' }).isDisabled());
    });

    await test('render survives tab switches', async () => {
        await page.getByRole('tab', { name: 'Render' }).click();
        await page.getByRole('button', { name: 'Load scene' }).click();
        await page.getByRole('button', { name: 'Reload', exact: true }).waitFor({ timeout: 20000 });
        await page.getByRole('tab', { name: 'Data' }).click();
        await page.getByRole('tab', { name: 'Render' }).click();
        await page.waitForTimeout(200);
        check('render: the loaded scene is kept when switching tabs',
            await page.getByRole('button', { name: 'Reload', exact: true }).isVisible()
            && await page.getByRole('button', { name: 'Load scene' }).count() === 0);
        const width = await page.$eval('#panel-render canvas', (c) => c.width);
        check('render: the preview is sized again after being hidden', width > 100, { canvasWidth: width });
    });

    await test('data', async () => {
        await page.getByRole('tab', { name: 'Data' }).click();
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.getByRole('button', { name: 'Download CSV' }).click(),
        ]);
        check('data: CSV export downloads', /^building-metrics-\d{4}-\d\d-\d\d\.csv$/.test(download.suggestedFilename()),
            download.suggestedFilename());
        check('data: import is offered to editors', await page.getByRole('button', { name: 'Choose CSV…' }).isVisible());
    });

    check('panel: no page errors', errors.length === 0, errors.join(' | '));
    await context.close();

    await test('transfer', () => transferTests(openPage));
    return results;
};

const BUILT_INS = [
    { id: 'residential', name: 'Residential' }, { id: 'commercial', name: 'Commercial' }, { id: 'unspecified', name: 'Unspecified' },
];

/**
 * Exports a transfer file from one stub project and imports it into another whose site is offset by
 * (7, 3) m and lacks building 3. Building 1 has floors: retail on the west half of the ground floor.
 */
const transferTests = async (openPage) => {
    const floors = (fnWest, fnEast, fnUpper) => ({
        levels: [
            { height: 4, spaces: [{ rect: [-30, -10, -20, 10], function: fnWest }, { rect: [-20, -10, -10, 10], function: fnEast }] },
            { height: 26, spaces: [{ rect: [-30, -10, -10, 10], function: fnUpper }] },
        ],
    });
    const source = await openPage({
        scene: {
            functions: [...BUILT_INS, { id: 'f-retail', name: 'Retail', color: '#ff0000' }],
            floors: { 'root/b1': floors('f-retail', 'residential', 'residential') },
        },
        storage: {
            'categories.json': JSON.stringify({ version: 1, categories: [{ id: 'ph', name: 'Phase', values: [{ id: 'p1', name: 'Phase 1', color: '#123456' }] }] }),
            'assignments-proposal-1.json': JSON.stringify({ version: 1, assignments: { ph: { 'root/b1': 'p1', 'root/b3': 'p1' } } }),
        },
    });
    const page = source.page;
    await page.locator('.building-row[role="button"]').first().waitFor({ timeout: 15000 });
    await page.getByRole('tab', { name: 'Data' }).click();
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Export transfer file' }).click(),
    ]);
    const text = readFileSync(await download.path(), 'utf8');
    const file = JSON.parse(text);
    const byPath = Object.fromEntries(file.buildings.map((b) => [b.path, b]));
    check('transfer: export names the file and carries every building',
        /^forma-transfer-\d{4}-\d\d-\d\d\.json$/.test(download.suggestedFilename()) && file.buildings.length === 3, download.suggestedFilename());
    check('transfer: floors and functions exported where Forma has them, a mesh otherwise',
        byPath['root/b1'].floorStacks.length === 1 && !byPath['root/b1'].mesh && byPath['root/b2'].mesh && byPath['root/b3'].floorStacks.length === 0
        && file.buildingFunctions.some((f) => f.name === 'Retail'));
    check('transfer: categories exported by name', byPath['root/b1'].values.Phase === 'Phase 1' && !byPath['root/b2'].values.Phase, byPath['root/b2'].values);
    const triangles = await page.evaluate(() => Object.fromEntries(Object.entries(globalThis.__formaScene.buildings).map(([k, v]) => [k, [...v]])));
    check('transfer: no page errors in the source project', source.errors.length === 0, source.errors.join(' | '));
    await source.context.close();

    // The other project: same site 7 m east and 3 m north, building 3 missing, functions unset, nothing stored.
    const moved = (arr) => arr.map((v, i) => (i % 3 === 0 ? v + 7 : i % 3 === 1 ? v + 3 : v));
    const target = await openPage({
        scene: {
            buildings: { 'root/b1': moved(triangles['root/b1']), 'root/b2': moved(triangles['root/b2']) },
            functions: BUILT_INS,
            floors: { 'root/b1': { ...floors(undefined, undefined, undefined), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 3, 0, 1] } },
            rootUrn: 'urn:adsk-forma-elements:proposal:pro_new:prop-9:1700000001',
        },
        storage: {},
    });
    const tp = target.page;
    await tp.locator('.building-row[role="button"]').first().waitFor({ timeout: 15000 });
    await tp.getByRole('tab', { name: 'Data' }).click();
    await tp.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({ name: 'transfer.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await tp.getByRole('heading', { name: 'Transfer preview' }).waitFor({ timeout: 10000 });
    // Kept for a look after UI changes (not checked).
    const shots = new URL('../.out/shots/', import.meta.url);
    mkdirSync(shots, { recursive: true });
    await tp.locator('#panel-data').screenshot({ path: new URL('panel-transfer-preview.png', shots).pathname });
    const preview = await tp.locator('.import-preview').innerText();
    check('transfer: preview matches 2 of 3 buildings and reports the site offset',
        /2 of 3\s+buildings in the file matched/.test(preview) && /offset .* by 7\.0 m east and 3\.0 m north/.test(preview), preview);
    check('transfer: preview offers functions for the matched building and the missing function',
        /Set functions on 1 matched building/.test(preview) && /Add 1 building function this project lacks \(Retail\)/.test(preview)
        && /Add 1 building from the file that is missing here/.test(preview));
    const callsOf = (name) => tp.evaluate((n) => globalThis.__formaCalls.filter((c) => c.name === n).map((c) => c.args), name);
    check('transfer: nothing changes before Apply', (await callsOf('settings.buildingFunctions.add')).length === 0
        && (await callsOf('elements.replace')).length === 0);

    await tp.getByLabel(/Add 1 building from the file/).check();
    await tp.getByRole('button', { name: 'Apply transfer' }).click();
    await tp.getByText(/^Done:/).waitFor({ timeout: 10000 });
    const done = await tp.getByText(/^Done:/).innerText();
    const added = await callsOf('settings.buildingFunctions.add');
    const stacks = await callsOf('floorStack.createFromFloors');
    const replaced = await callsOf('elements.replace');
    const placed = await callsOf('elements.add');
    const meshes = await callsOf('integrateElements.createElementV2');
    const units = stacks[0]?.plans.flatMap((p) => p.units.map((u) => u.functionId ?? null));
    check('transfer: the missing function is added once', added.length === 1 && added[0].name === 'Retail' && added[0].color === '#ff0000', added);
    check('transfer: building 1 is rebuilt with the copied functions, mapped to this project\'s IDs, in place',
        stacks.length === 1 && JSON.stringify(units) === JSON.stringify(['fn-3', 'residential', 'residential'])
        && replaced.length === 1 && replaced[0].path === 'root/b1', { units, replaced });
    const t = placed[0]?.transform ?? [];
    check('transfer: building 3 is added from its mesh, moved by the site offset, as a building',
        meshes.length === 1 && meshes[0].properties.category === 'building' && placed.length === 1
        && Math.abs(t[12] - (-5 + 7)) < 1e-6 && Math.abs(t[13] - (25 + 3)) < 1e-6 && t[14] === 0, { t, props: meshes[0]?.properties });
    const stored = await tp.evaluate(() => globalThis.__storage);
    const cats = JSON.parse(stored['categories.json'] ?? '{}').categories ?? [];
    const assigned = JSON.parse(stored['assignments-prop-9.json'] ?? '{}').assignments ?? {};
    const phase = cats.find((c) => c.name === 'Phase');
    const p1 = phase?.values.find((v) => v.name === 'Phase 1');
    check('transfer: categories copied, to the matched and the added building, with their colours',
        p1?.color === '#123456' && assigned[phase.id]?.['root/b1'] === p1.id && assigned[phase.id]?.['root/added-2'] === p1.id
        && !assigned[phase.id]?.['root/b2'], { assigned, done });
    check('transfer: no page errors in the target project', target.errors.length === 0, target.errors.join(' | '));
    await target.context.close();
};
