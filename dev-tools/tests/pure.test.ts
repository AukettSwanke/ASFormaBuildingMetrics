// Pure modules, run in node. No Forma, no WebGL.

import { check, near, results, test } from '../lib/check';
import { box, prism } from '../lib/scene';
import { sunAngles, sunVector } from '../../src/sunPosition';
import { fallbackZone, formatClock, isoDate, parseIsoDate, utcToZoned, zonedToUtc } from '../../src/timeZone';
import { buildEdgeSet, findSilhouettes } from '../../src/silhouette';
import {
    MAX_PRESETS, SavedPreset, mergeImported, parsePresetFile, sanitiseLook, serialisePresets, toLook, uniqueName, withLook,
} from '../../src/presets';
import { PRESETS } from '../../src/panelRender';
import { studyTimes } from '../../src/studySheet';
import { decodeText, parseTable, toCsv } from '../../src/table';

const LONDON: [number, number] = [51.5072, -0.1276];

export const run = async () => {
    await test('sun position', () => {
        // Summer solstice, solar noon in London is about 12:02 UTC: elevation 90 - 51.5 + 23.44 = 61.9.
        const noon = sunAngles(new Date('2026-06-21T12:02:00Z'), ...LONDON);
        check('sun: London solstice noon elevation ~61.9°', near(noon.elevation, 61.94, 0.2), noon);
        check('sun: London solstice noon azimuth ~180°', near(noon.azimuth, 180, 1.5), noon);
        // Published sunrise 04:43 BST (03:43 UTC); geometric elevation then is about -0.8° (refraction ignored).
        const rise = sunAngles(new Date('2026-06-21T03:43:00Z'), ...LONDON);
        check('sun: London solstice sunrise near the horizon', rise.elevation > -1.5 && rise.elevation < 0.5, rise);
        check('sun: London solstice sunrise azimuth ~49° (north-east)', near(rise.azimuth, 49, 2), rise);
        const winter = sunAngles(new Date('2026-12-21T12:00:00Z'), ...LONDON);
        check('sun: London winter solstice noon elevation ~15°', near(winter.elevation, 15.0, 0.4), winter);

        const east = sunVector({ azimuth: 90, elevation: 0 });
        const south = sunVector({ azimuth: 180, elevation: 30 });
        check('sun vector: azimuth 90° points +X (east)', near(east[0], 1, 1e-9) && near(east[1], 0, 1e-9), east);
        check('sun vector: azimuth 180° points -Y (south), z = sin(elevation)',
            near(south[1], -Math.cos(Math.PI / 6), 1e-9) && near(south[2], 0.5, 1e-9), south);
    });

    await test('time zones', () => {
        const at = (zone: string, s: string) => {
            const [d, t] = s.split(' ');
            const day = parseIsoDate(d)!;
            const [hour, minute] = t.split(':').map(Number);
            return zonedToUtc({ ...day, hour, minute }, zone).toISOString();
        };
        check('zone: London summer 12:00 is 11:00Z', at('Europe/London', '2026-06-21 12:00') === '2026-06-21T11:00:00.000Z');
        check('zone: London winter 12:00 is 12:00Z', at('Europe/London', '2026-01-15 12:00') === '2026-01-15T12:00:00.000Z');
        check('zone: New York summer 12:00 is 16:00Z', at('America/New_York', '2026-06-21 12:00') === '2026-06-21T16:00:00.000Z');
        check('zone: Sydney summer 12:00 is 01:00Z', at('Australia/Sydney', '2026-12-21 12:00') === '2026-12-21T01:00:00.000Z');
        // 01:30 on 29 Mar 2026 does not exist in London; it resolves to just after the change (02:30 BST).
        const gap = at('Europe/London', '2026-03-29 01:30');
        check('zone: skipped time resolves after the change', gap === '2026-03-29T01:30:00.000Z', gap);
        // 01:30 on 25 Oct 2026 happens twice; the first one (BST) is used.
        const repeat = at('Europe/London', '2026-10-25 01:30');
        check('zone: repeated time resolves to the first', repeat === '2026-10-25T00:30:00.000Z', repeat);
        // The same rules in the southern hemisphere and in New York.
        const sydRepeat = at('Australia/Sydney', '2026-04-05 02:30');
        const sydGap = at('Australia/Sydney', '2026-10-04 02:30');
        const nyGap = at('America/New_York', '2026-03-08 02:30');
        check('zone: Sydney and New York clock changes',
            sydRepeat === '2026-04-04T15:30:00.000Z' && sydGap === '2026-10-03T16:30:00.000Z' && nyGap === '2026-03-08T07:30:00.000Z',
            [sydRepeat, sydGap, nyGap]);

        let roundTrips = 0, total = 0;
        for (let m = 0; m < 12; m++) for (const minutes of [0, 7 * 60 + 10, 12 * 60, 23 * 60 + 50]) {
            const z = { year: 2026, month: m + 1, day: 10, hour: Math.floor(minutes / 60), minute: minutes % 60 };
            const back = utcToZoned(zonedToUtc(z, 'Europe/Paris'), 'Europe/Paris');
            total++;
            if (JSON.stringify(back) === JSON.stringify(z)) roundTrips++;
        }
        check('zone: clock time round-trips through UTC', roundTrips === total, `${roundTrips}/${total}`);

        check('zone: fallback zones (Etc signs are reversed)',
            fallbackZone(-0.1) === 'UTC' && fallbackZone(151.2) === 'Etc/GMT-10' && fallbackZone(-74) === 'Etc/GMT+5',
            [fallbackZone(-0.1), fallbackZone(151.2), fallbackZone(-74)]);
        check('zone: date and clock formatting',
            isoDate({ year: 2026, month: 3, day: 5 }) === '2026-03-05' && formatClock(9 * 60 + 5) === '09:05'
            && parseIsoDate('2026-3-5') === null);
    });

    await test('silhouettes', () => {
        const cube = buildEdgeSet(box(0, 0, 0, 10, 10, 10), 20);
        check('edges: a box has 12 hard edges', cube.hard.length / 6 === 12, cube.hard.length / 6);
        check('edges: a box\'s face diagonals are smooth, never silhouettes',
            cube.smooth.length / 6 === 6 && findSilhouettes(cube, { kind: 'perspective', x: 50, y: 30, z: 20 }).length === 0);

        const tower = prism(0, 0, 10, 30, 32);
        const set = buildEdgeSet(tower, 20);
        check('edges: a 32-sided prism has 64 hard cap edges', set.hard.length / 6 === 64, set.hard.length / 6);
        const fromEast = findSilhouettes(set, { kind: 'perspective', x: 500, y: 0, z: 15 });
        check('silhouette: 2 vertical edges seen from the side', fromEast.length / 6 === 2, fromEast.length / 6);
        const ortho = findSilhouettes(set, { kind: 'orthographic', x: -1, y: 0, z: 0 });
        check('silhouette: 2 vertical edges in an orthographic side view', ortho.length / 6 === 2, ortho.length / 6);
        const above = findSilhouettes(set, { kind: 'perspective', x: 0, y: 0, z: 500 });
        check('silhouette: none looking straight down', above.length === 0, above.length / 6);

        // Winding: reversing every triangle consistently gives the same result, so only *consistent*
        // winding matters. Mixed winding turns the affected smooth edges into hard (always drawn) lines.
        const reversed = new Float32Array(tower.length);
        for (let t = 0; t < tower.length; t += 9) {
            reversed.set(tower.subarray(t, t + 3), t);
            reversed.set(tower.subarray(t + 6, t + 9), t + 3);
            reversed.set(tower.subarray(t + 3, t + 6), t + 6);
        }
        const flipped = buildEdgeSet(reversed, 20);
        check('silhouette: consistently reversed winding gives the same silhouettes',
            findSilhouettes(flipped, { kind: 'perspective', x: 500, y: 0, z: 15 }).length === fromEast.length
            && flipped.hard.length === set.hard.length);
        const mixed = new Float32Array(tower);
        for (let t = 0; t < tower.length; t += 9 * 6) { // reverse one side triangle in every three faces' worth
            mixed.set(reversed.subarray(t, t + 9), t);
        }
        const mixedSet = buildEdgeSet(mixed, 20);
        check('edges: inconsistent winding adds hard lines (documents current behaviour)',
            mixedSet.hard.length > set.hard.length, { consistent: set.hard.length / 6, mixed: mixedSet.hard.length / 6 });
    });

    await test('presets', () => {
        const clay = PRESETS['Clay'];
        const look = toLook(clay);
        check('presets: a look leaves out the export settings',
            !('transparent' in look) && !('contextMode' in look) && !('shadowOpacity' in look));
        const current = { ...clay, transparent: true, contextMode: 'shadows' as const, shadowOpacity: 0.8 };
        const applied = withLook(current, toLook(PRESETS['Night']));
        check('presets: applying a look keeps transparency, context mode and shadow strength',
            applied.transparent && applied.contextMode === 'shadows' && applied.shadowOpacity === 0.8
            && applied.background === PRESETS['Night'].background);

        const old = { ...look } as any;
        delete old.shadowSoftness;
        check('presets: older saved looks without softness load as hard', sanitiseLook(old)?.shadowSoftness === 0);
        const wild = sanitiseLook({ ...look, lineWeight: 999, ambient: -3, shadowSoftness: 40, background: '#ABCDEF' });
        check('presets: numbers are clamped and colours normalised',
            wild?.lineWeight === 20 && wild?.ambient === 0 && wild?.shadowSoftness === 10 && wild?.background === '#abcdef', wild);
        check('presets: bad colour or missing flag rejects the look',
            sanitiseLook({ ...look, lineColour: 'red' }) === null && sanitiseLook({ ...look, shadows: undefined }) === null);

        const preset = (name: string, id = name): SavedPreset => ({ id, name, look, saved: '2026-01-01T00:00:00.000Z' });
        const file = serialisePresets([preset('A'), preset('B')]);
        const parsed = parsePresetFile(file);
        check('presets: file round-trips', parsed?.presets.length === 2 && parsed.skipped === 0);
        check('presets: non-JSON and wrong shapes are refused', parsePresetFile('nope') === null && parsePresetFile('{"x":1}') === null);
        const partly = parsePresetFile(JSON.stringify([preset('Ok'), { name: 'Broken', look: {} }]));
        check('presets: invalid entries are skipped and counted', partly?.presets.length === 1 && partly.skipped === 1);

        let n = 0;
        const merged = mergeImported([preset('Clay study')], [preset('clay STUDY', 'x'), preset('New', 'y')], () => `id${n++}`);
        check('presets: import never replaces, renames clashes (ignoring case) and re-ids',
            merged.added === 2 && merged.renamed === 1 && merged.presets[1].name === 'clay STUDY (2)'
            && merged.presets[1].id === 'id0', merged.presets.map((p) => p.name));
        const full = Array.from({ length: MAX_PRESETS }, (_, i) => preset(`P${i}`));
        check('presets: import stops at the limit', mergeImported(full, [preset('Extra')], () => 'z').dropped === 1);
        check('presets: unique names count up', uniqueName('A', ['A', 'A (2)']) === 'A (3)');
    });

    await test('study and table helpers', () => {
        const times = studyTimes(9 * 60, 15 * 60, 4);
        check('study: times run from start to end, rounded to 5 minutes',
            times.length === 4 && times[0] === 540 && times[3] === 900 && times.every((t) => t % 5 === 0), times.map(formatClock));

        check('table: comma CSV with quotes', JSON.stringify(parseTable('a,b\n"x, y","say ""hi"""\n'))
            === JSON.stringify([['a', 'b'], ['x, y', 'say "hi"']]));
        check('table: semicolon and tab delimiters are detected from the header',
            parseTable('a;b\n1;2')[1][1] === '2' && parseTable('a\tb\r\n1\t2')[1][1] === '2');
        check('table: CSV out and back', JSON.stringify(parseTable(toCsv([['h', 'i'], ['1,5', 'q"t']])))
            === JSON.stringify([['h', 'i'], ['1,5', 'q"t']]));
        const latin = new Uint8Array([0x41, 0x72, 0x65, 0x61, 0x20, 0x6d, 0xb2]).buffer; // "Area m²" in Windows-1252
        check('table: Windows-1252 bytes decode (Excel plain CSV)', decodeText(latin) === 'Area m²', decodeText(latin));
    });

    return results;
};
