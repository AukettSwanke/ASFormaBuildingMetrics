// Where the Render tab's sun is: Forma's own sun, or a date and time chosen in the project's time zone.
// Reads Forma's sun and project location, lights the scene and can move Forma's sun to match.

import { Forma } from 'forma-embedded-view-sdk/auto';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { PanelRenderer } from '../panelRender';
import { sunAngles, sunVector } from '../sunPosition';
import { fallbackZone, formatClock, isoDate, parseIsoDate, utcToZoned, zonedToUtc } from '../timeZone';
import { FormaSun, SunMode, errorText, longDate } from './shared';

export function useSun({ engine, loaded, redraw, onError }: {
    engine: RefObject<PanelRenderer>;
    loaded: boolean;
    /** Redraws the preview after the sun has moved. */
    redraw: () => void;
    onError: (message: string) => void;
}) {
    /** What Forma last reported, read by `read`. */
    const forma = useRef<FormaSun | null>(null);
    const [mode, setMode] = useState<SunMode>('forma');
    const [customDate, setCustomDateState] = useState('2026-06-21');
    const [customMinutes, setCustomMinutes] = useState(12 * 60);
    const [text, setText] = useState<string | null>(null);
    /** Bumped whenever Forma's sun is read again (or the scene's sun must be put back), so the effect re-runs. */
    const [tick, setTick] = useState(0);
    /** Forma's date in the project's time zone when first read, to start a shadow study on. */
    const [formaDate, setFormaDate] = useState<string | null>(null);

    /** Reads Forma's sun date, the project location and its time zone. */
    const read = async () => {
        const [date, location, timezone] = await Promise.all([
            Forma.sun.getDate(), Forma.project.getGeoLocation(), Forma.project.getTimezone(),
        ]);
        forma.current = {
            date,
            location: location ?? null,
            zone: timezone ?? (location ? fallbackZone(location[1]) : 'UTC'),
        };
        setFormaDate((current) => current ?? isoDate(utcToZoned(date, forma.current!.zone)));
        setTick((n) => n + 1);
    };

    /** The instant the panel should light the scene for, in the chosen mode. */
    const instant = (): Date | null => {
        const info = forma.current;
        if (!info) return null;
        if (mode === 'forma') return info.date;
        const day = parseIsoDate(customDate);
        if (!day) return null;
        return zonedToUtc({ ...day, hour: Math.floor(customMinutes / 60), minute: customMinutes % 60 }, info.zone);
    };

    // Light the scene for the chosen moment whenever the mode, date, time or Forma's sun changes.
    useEffect(() => {
        const e = engine.current, info = forma.current;
        if (!e || !loaded || !info) return;
        if (!info.location) { setText('The project has no location, so the sun direction is a default.'); return; }
        const date = instant();
        if (!date) return;
        const angles = sunAngles(date, info.location[0], info.location[1]);
        e.setSunDirection(sunVector(angles));
        const z = utcToZoned(date, info.zone);
        setText(
            `${longDate(z)}, ${formatClock(z.hour * 60 + z.minute)} (${info.zone}) · `
            + (angles.elevation > 0
                ? `azimuth ${angles.azimuth.toFixed(0)}°, elevation ${angles.elevation.toFixed(1)}°`
                : 'sun below the horizon'),
        );
        redraw();
    }, [loaded, mode, customDate, customMinutes, tick]);

    const chooseMode = (next: SunMode) => {
        if (next === 'custom' && forma.current) {
            // Start from where Forma's sun is now, so the slider begins at the current view.
            const z = utcToZoned(forma.current.date, forma.current.zone);
            setCustomDateState(isoDate(z));
            setCustomMinutes(Math.min(1430, Math.round((z.hour * 60 + z.minute) / 10) * 10));
        }
        setMode(next);
    };

    /** Ignores anything that is not a full yyyy-mm-dd date (date inputs report partial edits). */
    const setCustomDate = (value: string) => { if (parseIsoDate(value)) setCustomDateState(value); };

    /** Moves Forma's own sun to the chosen moment, so the Forma view matches the panel. */
    const applyToForma = async () => {
        const date = instant();
        if (!date) return;
        try {
            await Forma.sun.setDate({ date });
            await read();
        } catch (error) {
            console.error(error);
            onError(`Could not set Forma's sun: ${errorText(error)}`);
        }
    };

    return {
        /** Latest reading from Forma (a ref, so work started earlier sees it too). */
        forma,
        formaDate,
        mode,
        chooseMode,
        customDate,
        setCustomDate,
        customMinutes,
        setCustomMinutes,
        text,
        read,
        applyToForma,
        /** Puts the scene's sun back to the chosen mode, after a study has moved it. */
        restore: () => setTick((n) => n + 1),
    };
}

export type SunState = ReturnType<typeof useSun>;
