// Full-page screenshots of the whole panel against the Forma stub, for reviewing layout and copy.
// Not a test: it writes PNGs to dev-tools/.out/shots/ and lists them. Screenshots come from software
// rendering in headless Chromium, so colours and fonts can differ slightly from Forma's embedded view.

import { join } from 'node:path';

const WIDTH = 380; // about the width of Forma's right-hand extension panel

/** Scroll to the top (the tab bar is sticky) and let transitions finish before a full-page shot. */
const settle = async (page) => {
    await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
    await page.waitForTimeout(250);
};

export const takeShots = async ({ openPage, dir }) => {
    const written = [];
    for (const scheme of ['light', 'dark']) {
        const { page, context, errors } = await openPage({ width: WIDTH, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.getByText(/#1\b|Building 1/).first().waitFor({ timeout: 15000 }).catch(() => undefined);
        await page.waitForTimeout(300);
        const first = join(dir, `panel-${scheme}.png`);
        await settle(page);
            await page.screenshot({ path: first, fullPage: true });
        written.push(first);

        // A selected building and a category being edited.
        const firstRow = page.locator('.building-row[role="button"]').first();
        if (await firstRow.count() && await page.locator('#colour-mode').count()) {
            await firstRow.click();
            const category = await page.$eval('#colour-mode', (s) => [...s.options].find((o) => o.value.startsWith('category:'))?.value);
            if (category) await page.selectOption('#colour-mode', category);
            await page.waitForTimeout(200);
            const detail = join(dir, `panel-${scheme}-category.png`);
            await settle(page);
            await page.screenshot({ path: detail, fullPage: true });
            written.push(detail);
            await page.selectOption('#colour-mode', 'height');
        }

        await page.getByRole('tab', { name: 'Render' }).click().catch(() => undefined);
        const load = page.getByRole('button', { name: 'Load scene' });
        if (await load.count()) {
            await settle(page);
            await page.screenshot({ path: join(dir, `panel-${scheme}-render-empty.png`), fullPage: true });
            await load.click();
            await page.getByRole('button', { name: 'Reload geometry' }).waitFor({ timeout: 20000 }).catch(() => undefined);
            await page.waitForTimeout(800);
            const second = join(dir, `panel-${scheme}-render.png`);
            await settle(page);
            await page.screenshot({ path: second, fullPage: true });
            written.push(second);
            const study = page.getByRole('button', { name: 'Shadow study' });
            if (await study.count()) {
                await study.click();
                await page.getByRole('button', { name: 'Choose a time' }).click();
                const third = join(dir, `panel-${scheme}-render-study.png`);
                await settle(page);
            await page.screenshot({ path: third, fullPage: true });
                written.push(third);
                await page.getByRole('button', { name: 'Follow Forma' }).click();
                await page.getByRole('button', { name: 'Image', exact: true }).click();
            }
        }
        if (await page.getByRole('tab', { name: 'Data' }).count()) {
            await page.getByRole('tab', { name: 'Data' }).click();
            const data = join(dir, `panel-${scheme}-data.png`);
            await settle(page);
            await page.screenshot({ path: data, fullPage: true });
            written.push(data);
        }
        if (errors.length) written.push(`(${scheme}) page errors: ${errors.join(' | ')}`);
        await context.close();
    }
    return written;
};
