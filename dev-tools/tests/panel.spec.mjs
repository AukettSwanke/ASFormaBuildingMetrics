// Drives the whole panel (src/index.tsx) against the Forma stub: tabs, the metrics workflow, and that
// the render keeps its loaded scene while other tabs are shown.

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
    return results;
};
