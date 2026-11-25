#!/usr/bin/env node
// Test harness runner. See dev-tools/README.md.
//
//   node dev-tools/run.mjs                 all suites: pure, engine, component, panel
//   node dev-tools/run.mjs pure engine     only those suites
//   node dev-tools/run.mjs shots           screenshots of the whole panel into dev-tools/.out/shots/
//
// Exits non-zero when any check fails.

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, '.out');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const suites = args.length ? args : ['pure', 'engine', 'component', 'panel'];
const known = ['pure', 'engine', 'component', 'panel', 'shots'];
for (const s of suites) if (!known.includes(s)) { console.error(`Unknown suite "${s}". Use: ${known.join(', ')}`); process.exit(2); }

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** Bundles one entry; the Forma SDK is replaced by the stub everywhere. */
const bundle = async (entry, outfile, options = {}) => {
    await build({
        entryPoints: [join(here, entry)],
        outfile: join(out, outfile),
        bundle: true,
        absWorkingDir: root,
        nodePaths: [join(root, 'node_modules')],
        alias: { 'forma-embedded-view-sdk/auto': join(here, 'stubs/forma.ts') },
        jsx: 'automatic',
        jsxImportSource: 'preact',
        target: 'es2022',
        logLevel: 'warning',
        ...options,
    });
    return join(out, outfile);
};

let failures = 0;
const report = (suite, results) => {
    console.log(`\n== ${suite} ==`);
    for (const r of results) {
        if (!r.ok) failures++;
        console.log(`${r.ok ? '  ok  ' : '  FAIL'} ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
    }
    const passed = results.filter((r) => r.ok).length;
    console.log(`${passed}/${results.length} passed`);
};

const loadPlaywright = () => {
    try {
        return require('playwright');
    } catch {
        console.error('Playwright is not installed. Install it with: npm install --no-save playwright && npx playwright install chromium');
        process.exit(2);
    }
};

const browserSuites = suites.filter((s) => s !== 'pure');
let browser;
if (browserSuites.length) {
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

/** A blank page with an #app element, the given CSS and script, served from about:blank. */
const openPage = async (script, css, viewport = { width: 420, height: 900 }, init = {}) => {
    const context = await browser.newContext({ viewport, acceptDownloads: true, locale: 'en-GB', timezoneId: 'Europe/London' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8">${css ? `<style>${readFileSync(css, 'utf8')}</style>` : ''}</head><body><div id="app"></div></body></html>`);
    // Starting scene and storage for the stub (see stubs/forma.ts), e.g. to stand in for another project.
    if (init.scene || init.storage) {
        await page.evaluate(({ scene, storage }) => {
            if (scene) globalThis.__formaScene = scene;
            if (storage) globalThis.__storage = storage;
        }, init);
    }
    await page.addScriptTag({ path: script });
    return { page, context, errors };
};

try {
    for (const suite of suites) {
        if (suite === 'pure') {
            const file = await bundle('tests/pure.test.ts', 'pure.cjs', { platform: 'node', format: 'cjs' });
            report('pure', await require(file).run());
        }

        if (suite === 'engine') {
            const file = await bundle('tests/engine.page.ts', 'engine.js', { format: 'iife' });
            const { page, context, errors } = await openPage(file);
            const results = await page.evaluate(() => globalThis.runEngineTests());
            results.push({ name: 'engine: no page errors', ok: errors.length === 0, detail: errors.join(' | ') });
            report('engine', results);
            await context.close();
        }

        if (suite === 'component') {
            const file = await bundle('tests/component.page.tsx', 'component.js', { format: 'iife' });
            const { runComponentTests } = await import('./tests/component.spec.mjs');
            report('component', await runComponentTests({ openPage: () => openPage(file, file.replace(/\.js$/, '.css')) }));
        }

        if (suite === 'panel') {
            const file = await bundle('tests/panel.page.tsx', 'panel.js', { format: 'iife' });
            const { runPanelTests } = await import('./tests/panel.spec.mjs');
            report('panel', await runPanelTests({ openPage: (init) => openPage(file, file.replace(/\.js$/, '.css'), undefined, init) }));
        }

        if (suite === 'shots') {
            const file = await bundle('tests/panel.page.tsx', 'panel.js', { format: 'iife' });
            const { takeShots } = await import('./tests/shots.mjs');
            const dir = join(out, 'shots');
            mkdirSync(dir, { recursive: true });
            const written = await takeShots({ openPage: (viewport) => openPage(file, file.replace(/\.js$/, '.css'), viewport), dir });
            console.log(`\n== shots ==\n${written.map((f) => `  ${f}`).join('\n')}`);
        }
    }
} finally {
    await browser?.close();
}

writeFileSync(join(out, 'last-run.txt'), `${new Date().toISOString()} failures=${failures}\n`);
if (failures) console.log(`\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
