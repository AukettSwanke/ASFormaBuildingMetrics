// Drives <RenderEngine> (mounted against the Forma stub) with Playwright, as a user would.
// Locators use labels, roles and visible text where they are stable, ids otherwise.

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
};
const test = async (name, body) => {
    try { await body(); } catch (error) { check(`${name} (threw)`, false, String(error?.message ?? error).split('\n')[0]); }
};

/** Sets a range or other input the way a drag would (Preact listens for `input`). */
const setInput = (page, selector, value) => page.$eval(selector, (el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

const loadScene = async (page) => {
    await page.getByRole('button', { name: /^(Load scene|Reload geometry)$/ }).click();
    await page.getByRole('button', { name: 'Reload geometry' }).waitFor({ timeout: 20000 });
};

/** PNG width and height straight from the file header. */
const pngSize = async (download) => {
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

export const runComponentTests = async ({ openPage }) => {
    const { page, context, errors } = await openPage();
    await page.evaluate(() => globalThis.mount(true));

    await test('load', async () => {
        await loadScene(page);
        const info = await page.getByText(/building triangles/).textContent();
        check('load: geometry loads and stats are shown', /36 building triangles/.test(info), info);
        const variance = await page.$eval('canvas', (c) => {
            const copy = document.createElement('canvas');
            copy.width = c.width; copy.height = c.height;
            const ctx = copy.getContext('2d');
            ctx.drawImage(c, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            const seen = new Set();
            for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
            return seen.size;
        });
        check('load: the canvas shows a rendered scene (not blank)', variance > 5, { distinctColours: variance });
    });

    await test('presets keep export settings', async () => {
        await page.getByLabel('Transparent background').check();
        check('transparent: switching it on sets context to shadows only', await page.$eval('#re-context', (s) => s.value) === 'shadows');
        await page.getByRole('button', { name: 'Line drawing' }).click();
        check('preset: choosing a preset keeps transparency and context mode',
            await page.getByLabel('Transparent background').isChecked() && await page.$eval('#re-context', (s) => s.value) === 'shadows');
        await page.getByLabel('Transparent background').uncheck();
        await page.selectOption('#re-context', 'shown');
    });

    await test('saved presets', async () => {
        await page.getByText(/^Saved presets/).click();
        await page.getByLabel('Name for the new preset').fill('Test look');
        await page.getByRole('button', { name: 'Save current look' }).click();
        await page.getByText('Saved "Test look".').waitFor();
        const stored = await page.evaluate(() => globalThis.__storage['render-presets.json']);
        check('saved: preset written to project storage', stored && JSON.parse(stored).presets[0]?.name === 'Test look');
        await page.getByLabel('Name for the new preset').fill('test LOOK');
        check('saved: a duplicate name (any case) cannot be saved',
            await page.getByRole('button', { name: 'Save current look' }).isDisabled());
        await page.getByLabel('Name for the new preset').fill('');

        // Reload the panel: the preset comes back from storage.
        await page.evaluate(() => { globalThis.unmount(); globalThis.mount(true); });
        await loadScene(page);
        check('saved: preset survives a panel reload', await page.getByRole('button', { name: 'Test look' }).isVisible());

        // View-only users can apply but not change presets.
        await page.evaluate(() => { globalThis.unmount(); globalThis.mount(false); });
        await loadScene(page);
        await page.getByText(/^Saved presets/).click();
        check('view-only: no save, update, delete or import',
            await page.getByRole('button', { name: 'Save current look' }).count() === 0
            && await page.getByRole('button', { name: /^(Update|Delete|Import file…)$/ }).count() === 0);
        await page.getByRole('button', { name: 'Test look' }).click();
        check('view-only: a saved preset can still be applied',
            !(await page.getByRole('button', { name: 'Test look' }).getAttribute('class'))?.includes('button-ghost'));
        await page.evaluate(() => { globalThis.unmount(); globalThis.mount(true); });
        await loadScene(page);
    });

    await test('soft shadows', async () => {
        await page.getByRole('button', { name: 'Clay' }).click();
        await setInput(page, '#re-soft', 2);
        await page.locator('[data-role="soft-shadow-preview"]').waitFor({ timeout: 15000 });
        check('soft: averaged preview appears once the view is still', true);
        await page.evaluate(() => globalThis.__moveCamera({
            position: { x: 140, y: -120, z: 100 }, target: { x: 0, y: 10, z: 10 }, type: 'perspective',
        }));
        check('soft: moving the camera removes the preview at once',
            await page.locator('[data-role="soft-shadow-preview"]').count() === 0);
        await page.locator('[data-role="soft-shadow-preview"]').waitFor({ timeout: 15000 });
        check('soft: the preview comes back after the camera stops', true);
        await setInput(page, '#re-soft', 0);
    });

    await test('sun', async () => {
        check('sun: follows Forma, in the project time zone',
            await page.getByText(/2026-06-21 13:00 \(Europe\/London\)/).isVisible());
        await page.getByLabel('Sun source').selectOption('custom');
        await page.getByRole('button', { name: '21 Dec' }).first().click();
        await page.getByText(/2026-12-21 13:00 \(Europe\/London\)/).waitFor({ timeout: 5000 });
        check('sun: custom date shows', true);
        await page.getByRole('button', { name: "Set Forma's sun to this" }).click();
        const calls = await page.evaluate(() => globalThis.__formaCalls.filter((c) => c.name === 'sun.setDate').map((c) => c.args));
        check("sun: Set Forma's sun sends the chosen instant (13:00 GMT)", calls.at(-1) === '2026-12-21T13:00:00.000Z', calls);
        await page.getByLabel('Sun source').selectOption('forma');
    });

    await test('shadow study', async () => {
        await page.getByRole('button', { name: 'Create shadow study' }).click();
        await page.getByAltText('Shadow study').waitFor({ timeout: 60000 });
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.getByRole('button', { name: 'Download PNG' }).first().click(),
        ]);
        check('study: sheet created and downloadable', /^forma-shadow-study-\d{4}-\d\d-\d\d\.png$/.test(download.suggestedFilename()),
            download.suggestedFilename());

        await page.selectOption('#re-slayout', 'layered');
        await page.getByRole('button', { name: 'Create layered image' }).click();
        await page.waitForFunction(() => document.querySelector('img[alt="Shadow study"]') && !document.body.textContent.includes('Rendering the shadow study'), null, { timeout: 60000 });
        const [layered] = await Promise.all([
            page.waitForEvent('download'),
            page.getByRole('button', { name: 'Download PNG' }).first().click(),
        ]);
        check('study: layered image created', /^forma-shadow-layers-/.test(layered.suggestedFilename()), layered.suggestedFilename());
        await page.selectOption('#re-slayout', 'separate');
    });

    await test('export', async () => {
        await page.getByLabel('Transparent background').check();
        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 60000 }),
            page.getByRole('button', { name: 'Download PNG' }).last().click(),
        ]);
        const size = await pngSize(download);
        check('export: transparent PNG named and sized as chosen (2560 wide, 16:9)',
            download.suggestedFilename() === 'forma-panel-render-transparent.png' && size.width === 2560 && size.height === 1440,
            { name: download.suggestedFilename(), ...size });
        await page.getByLabel('Transparent background').uncheck();
    });

    await test('no location', async () => {
        await page.evaluate(() => { globalThis.unmount(); globalThis.__formaScene.location = null; globalThis.mount(true); });
        await loadScene(page);
        await page.getByText(/no location/).waitFor({ timeout: 5000 });
        check('no location: says so, and the study is disabled',
            true
            && await page.getByRole('button', { name: 'Create shadow study' }).isDisabled());
    });

    check('component: no page errors', errors.length === 0, errors.join(' | '));
    await context.close();
    return results;
};
