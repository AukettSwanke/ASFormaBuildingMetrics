// Pure modules, run in node. No Forma, no WebGL.

import { check, near, results, test } from '../lib/check';
import { box, graphOf, prism } from '../lib/scene';
import { sunAngles, sunVector } from '../../src/sunPosition';
import { fallbackZone, formatClock, isoDate, parseIsoDate, utcToZoned, zonedToUtc } from '../../src/timeZone';
import { buildEdgeSet, findSilhouettes } from '../../src/silhouette';
import {
    MAX_PRESETS, SavedPreset, mergeImported, parsePresetFile, sanitiseLook, serialisePresets, toLook, uniqueName, withLook,
} from '../../src/presets';
import { PRESETS } from '../../src/panelRender';
import { studyTimes } from '../../src/studySheet';
import { decodeText, parseTable, toCsv } from '../../src/table';
import {
    FLOOR_STACK_ID, GraphBuilding, Placed, copySpaceFunctions, decodeMesh, detectShift, encodeMesh, graphToFloorStack, mapFunction,
    matchBuildings, meshToBlock, ownSpaceProps, parseTransferFile, planCategoryTransfer, planFunctions,
} from '../../src/transfer';

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

    await test('project transfer', () => {
        // Source site, and the same site in a new project whose reference point is 12.3 m east, 4.5 m south.
        const at = (path: string, x: number, y: number, height: number, footprintArea: number): Placed =>
            ({ path, centre: { x, y, z: height / 2 }, height, footprintArea });
        const source = [at('s1', 0, 0, 20, 400), at('s2', 40, 0, 35, 250), at('s3', 0, 50, 12, 900), at('s4', 80, 80, 50, 300)];
        const dx = 12.3, dy = -4.5;
        // s4 is missing in the new project (a building only in that proposal); t9 exists only there.
        const target = [at('t3', dx, 50 + dy, 12, 900), at('t1', dx + 0.4, dy - 0.2, 20.2, 404), at('t2', 40 + dx, dy, 35, 250), at('t9', -200, 0, 20, 400)];
        const zero = matchBuildings(source, target, { x: 0, y: 0 });
        const { shift, matched } = detectShift(source, target);
        check('transfer: with no shift, an offset site matches nothing', zero.length === 0, zero);
        check('transfer: the site offset is found (12.3 m east, 4.5 m south)', near(shift.x, dx, 0.05) && near(shift.y, dy, 0.05) && matched === 3, { shift, matched });
        const pairs = matchBuildings(source, target, shift);
        check('transfer: buildings pair by position, one to one, and the missing one is left out',
            JSON.stringify(pairs.map((p) => [p.source, p.target])) === JSON.stringify([[0, 't1'], [1, 't2'], [2, 't3']]), pairs);
        const same = detectShift(source, source.map((b, i) => ({ ...b, path: `x${i}` })));
        check('transfer: identical sites need no shift', same.shift.x === 0 && same.shift.y === 0 && same.matched === 4, same);
        // A similar building elsewhere must not drag the whole site: here only one pair agrees on any offset.
        const lone = detectShift([at('a', 0, 0, 20, 400), at('b', 100, 0, 30, 200)], [at('c', 0.5, 0, 20, 400), at('d', 500, 500, 30, 200)]);
        check('transfer: a lone look-alike far away does not beat matching in place', lone.shift.x === 0 && lone.matched === 1, lone);

        // Categories: added by name with the source colours; blanks leave the target alone.
        const sourceCats = [{ id: 'a', name: 'Phase', values: [{ id: 'p1', name: 'Phase 1', color: '#123456' }, { id: 'p2', name: 'Phase 2', color: '#654321' }] }];
        const targetCats = [{ id: 'z', name: 'phase', values: [{ id: 'q1', name: 'PHASE 1', color: '#000000' }] }];
        const plan = planCategoryTransfer(sourceCats, [{ values: { Phase: 'Phase 2', Use: 'Office' } }, { values: {} }],
            [{ source: 0, target: 't1' }, { source: 1, target: 't2' }], targetCats, { z: { t2: 'q1' } });
        const phase = plan.categories.find((c) => c.id === 'z')!;
        const p2 = phase.values.find((v) => v.name === 'Phase 2');
        const use = plan.categories.find((c) => c.name === 'Use');
        check('transfer: categories match by name ignoring case, new values keep source colours',
            plan.categories.length === 2 && phase.values.length === 2 && p2?.color === '#654321' && targetCats[0].values.length === 1, plan.categories);
        check('transfer: values set on paired buildings; a blank leaves the existing value',
            plan.assignments.z.t1 === p2?.id && plan.assignments.z.t2 === 'q1' && plan.assignments[use!.id].t1 === use!.values[0].id
            && plan.changedBuildings === 1, plan.assignments);

        // Building functions: matched by name, built-ins keep their IDs.
        const srcFns = [{ id: 'residential', name: 'Residential' }, { id: 'f-retail', name: 'Retail', color: '#ff0000' }, { id: 'f-office', name: 'Office' }];
        const tgtFns = [{ id: 'residential', name: 'Residential' }, { id: 'n-office', name: 'office' }];
        const fp = planFunctions(srcFns, tgtFns);
        check('transfer: only functions missing by name are created', fp.missing.length === 1 && fp.missing[0].name === 'Retail', fp.missing);
        check('transfer: function IDs map by name, built-ins by ID',
            mapFunction('f-office', srcFns, tgtFns) === 'n-office' && mapFunction('residential', srcFns, tgtFns) === 'residential'
            && mapFunction('Office', srcFns, tgtFns) === 'n-office' && mapFunction('f-retail', srcFns, tgtFns) === undefined);

        // Floors: the source has retail on the ground floor's west half; the target is the same building drawn
        // separately (other IDs, other local origin, offset site), all unspecified, with its upper floor wound clockwise.
        const src = graphOf([
            { height: 4, spaces: [{ rect: [0, 0, 10, 20], function: 'f-retail' }, { rect: [10, 0, 20, 20], function: 'f-office' }] },
            { height: 3, spaces: [{ rect: [0, 0, 20, 20], function: 'residential' }] },
        ], 'src') as GraphBuilding;
        const tgt = graphOf([
            { height: 4, spaces: [{ rect: [-10, -10, 0, 10] }, { rect: [0, -10, 10, 10] }] },
            { height: 3, spaces: [{ rect: [-10, -10, 10, 10], clockwise: true }] },
        ], 'tgt') as GraphBuilding;
        const move = (x: number, y: number, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
        // Source element at (100, 200); target local origin is the building centre, so (110 + dx, 210 + dy).
        const copied = copySpaceFunctions({ graph: tgt, transform: move(110 + dx, 210 + dy) }, { graph: src, transform: move(100, 200) }, { x: dx, y: dy });
        const fnOf = (level: number, space: number) => copied.props.get(tgt.levels[level].spaces[space].id)?.function;
        check('transfer: each space takes the function of the source space under it, storey by storey',
            copied.copied === 3 && copied.kept === 0 && fnOf(0, 0) === 'f-retail' && fnOf(0, 1) === 'f-office' && fnOf(1, 0) === 'residential',
            [...copied.props.values()]);
        // Ground 30 m higher in the new project: storeys no longer line up by height.
        const raised = copySpaceFunctions({ graph: tgt, transform: move(110 + dx, 210 + dy, 30) }, { graph: src, transform: move(100, 200) }, { x: dx, y: dy });
        check('transfer: with the ground at another level, same storey count matches storey by storey', raised.copied === 3, raised.copied);
        const taller = graphOf([...[0, 1, 2].map(() => ({ height: 3, spaces: [{ rect: [-10, -10, 10, 10] as [number, number, number, number] }] }))], 'tall') as GraphBuilding;
        const offStorey = copySpaceFunctions({ graph: taller, transform: move(110 + dx, 210 + dy, 30) }, { graph: src, transform: move(100, 200) }, { x: dx, y: dy });
        check('transfer: spaces with no source storey to match keep their own function', offStorey.copied === 0 && offStorey.kept === 3, offStorey);

        const tgtAfter = [...tgtFns, { id: 'n-retail', name: 'Retail' }];
        const stack = graphToFloorStack(tgt, copied.props, (v) => mapFunction(v, srcFns, tgtAfter));
        const area = (plan: (typeof stack.plans)[number], ids: string[]) => {
            const pts = ids.map((id) => plan.vertices.find((v) => v.id === id)!);
            let a = 0;
            pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; });
            return a / 2;
        };
        const units = stack.plans.flatMap((pl) => pl.units.map((u) => ({ fn: u.functionId, a: area(pl, u.polygon) })));
        check('transfer: floor stack keeps storey heights, one plan per storey',
            JSON.stringify(stack.floors) === JSON.stringify([{ planId: 'plan-0', height: 4 }, { planId: 'plan-1', height: 3 }]), stack.floors);
        check('transfer: units carry target function IDs and every outline is counter-clockwise',
            JSON.stringify(units.map((u) => u.fn)) === JSON.stringify(['n-retail', 'n-office', 'residential']) && units.every((u) => u.a > 0)
            && near(units[0].a, 200, 1e-9) && near(units[2].a, 400, 1e-9), units);
        const validIds = (req: typeof stack) => req.plans.every((pl) => FLOOR_STACK_ID.test(pl.id)
            && pl.vertices.every((v) => FLOOR_STACK_ID.test(v.id))
            && pl.units.every((u) => [...u.polygon, ...u.holes.flat()].every((id) => pl.vertices.some((v) => v.id === id))));
        // Forma's own point IDs are long (and the fixture's contain "_"), which createFromFloors refuses.
        check('transfer: plan and vertex IDs follow Forma\'s rule, and every loop refers to a listed vertex',
            validIds(stack) && !FLOOR_STACK_ID.test(Object.keys(tgt.levels[0].points)[0]), stack.plans[0].vertices.slice(0, 3));
        check('transfer: corners shared by neighbouring spaces become one vertex', stack.plans[0].vertices.length === 6,
            stack.plans[0].vertices.length);
        const allIds = stack.plans.flatMap((pl) => pl.vertices.map((v) => v.id));
        check('transfer: vertex IDs are unique across all plans of a building (Forma rejects repeats)',
            stack.plans.length > 1 && new Set(allIds).size === allIds.length, allIds);
        // A loop with a repeated point and a closing point, and a sliver that collapses to two points.
        const messy = graphOf([{ height: 3, spaces: [{ rect: [0, 0, 10, 10] }, { rect: [20, 0, 20, 10] }] }], 'm') as GraphBuilding;
        const outer = messy.levels[0].spaces[0].outerLoop;
        messy.levels[0].spaces[0].outerLoop = [outer[0], outer[0], ...outer.slice(1), outer[0]];
        const cleaned = graphToFloorStack(messy, ownSpaceProps(messy), (v) => v);
        check('transfer: repeated points are dropped and degenerate spaces skipped',
            cleaned.plans[0].units.length === 1 && cleaned.plans[0].units[0].polygon.length === 4 && validIds(cleaned), cleaned.plans[0]);
        const own = graphToFloorStack(src, ownSpaceProps(src), (v) => v);
        check('transfer: a building rebuilt from its own floors keeps its functions',
            JSON.stringify(own.plans.flatMap((pl) => pl.units.map((u) => u.functionId))) === JSON.stringify(['f-retail', 'f-office', 'residential']));

        // A 10 × 6 × 7 box at (100, 200, 5), written as 12 triangles with a diagonal split in each face.
        const boxTris = (x0: number, y0: number, z0: number, w: number, d: number, h: number) => {
            const c = (i: number): [number, number, number] => [x0 + (i & 1 ? w : 0), y0 + (i & 2 ? d : 0), z0 + (i & 4 ? h : 0)];
            const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
            return new Float32Array(quads.flatMap(([a, b, cc, e]) => [...c(a), ...c(b), ...c(cc), ...c(a), ...c(cc), ...c(e)]));
        };
        const block = meshToBlock(boxTris(100, 200, 5, 10, 6, 7), 'f-office');
        const bp = block?.request.plans[0];
        const ring = bp?.units[0].polygon.map((id) => bp.vertices.find((v) => v.id === id)!) ?? [];
        const ringArea = ring.reduce((a, p, i) => a + (p.x * ring[(i + 1) % ring.length].y - ring[(i + 1) % ring.length].x * p.y) / 2, 0);
        check('transfer: a box mesh becomes a block with its outline, height and function',
            !!block && block.floors === 2 && JSON.stringify(block.origin) === '[100,200,5]' && ring.length === 4 && near(ringArea, 60, 1e-6)
            && near(block.request.floors.reduce((a, f) => a + f.height, 0), 7, 1e-9) && bp!.units[0].functionId === 'f-office'
            && FLOOR_STACK_ID.test(bp!.id) && bp!.vertices.every((v) => FLOOR_STACK_ID.test(v.id)), block);
        check('transfer: a mesh with no height gives no block', meshToBlock(boxTris(0, 0, 0, 5, 5, 0.1)) === null);

        const tri = new Float32Array([0, 0, 0, 1.5, -2.25, 3, 1e6, 0.1, -7]);
        check('transfer: mesh survives base64 and back', JSON.stringify([...decodeMesh(encodeMesh(tri))]) === JSON.stringify([...tri]));
        check('transfer: other JSON files are refused with a reason',
            !parseTransferFile('{"a":1}').ok && !parseTransferFile('nope').ok
            && !parseTransferFile(JSON.stringify({ format: 'as-forma-building-transfer', version: 99, buildings: [] })).ok);
    });

    return results;
};
