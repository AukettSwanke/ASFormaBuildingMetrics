// Full-page screenshots of the whole panel against the Forma stub, for reviewing layout and copy.
// Not a test: it writes PNGs to dev-tools/.out/shots/ and lists them. Screenshots come from software
// rendering in headless Chromium, so colours and fonts can differ slightly from Forma's embedded view.

import { join } from 'node:path';

const WIDTH = 380; // about the width of Forma's right-hand extension panel

export const takeShots = async ({ openPage, dir }) => {
    const written = [];
    for (const scheme of ['light', 'dark']) {
        const { page, context, errors } = await openPage({ width: WIDTH, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.getByText(/#1\b|Building 1/).first().waitFor({ timeout: 15000 }).catch(() => undefined);
        await page.waitForTimeout(300);
        const first = join(dir, `panel-${scheme}.png`);
        await page.screenshot({ path: first, fullPage: true });
        written.push(first);

        const load = page.getByRole('button', { name: 'Load scene' });
        if (await load.count()) {
            await load.click();
            await page.getByRole('button', { name: 'Reload geometry' }).waitFor({ timeout: 20000 }).catch(() => undefined);
            await page.waitForTimeout(800);
            const second = join(dir, `panel-${scheme}-render.png`);
            await page.screenshot({ path: second, fullPage: true });
            written.push(second);
        }
        if (errors.length) written.push(`(${scheme}) page errors: ${errors.join(' | ')}`);
        await context.close();
    }
    return written;
};
