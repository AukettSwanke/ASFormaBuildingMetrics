// Clock time <-> UTC instants for an IANA time zone, using Intl only. Pure, no Forma calls.

export interface Zoned {
    year: number;
    month: number; // 1-12
    day: number;
    hour: number; // 0-23
    minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
    let f = formatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
        });
        formatters.set(timeZone, f);
    }
    return f;
};

/** Wall-clock fields of an instant in the given zone. */
export const utcToZoned = (date: Date, timeZone: string): Zoned => {
    const parts: Record<string, number> = {};
    for (const p of formatterFor(timeZone).formatToParts(date)) {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
    }
    return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
};

/** Minutes the zone is ahead of UTC at that instant (daylight saving included). */
const offsetMinutes = (date: Date, timeZone: string): number => {
    const z = utcToZoned(date, timeZone);
    const wallAsUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute);
    return (wallAsUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000;
};

/**
 * The instant at which a wall clock in the zone shows the given time. Times skipped by a
 * clock change resolve to just after it; repeated times resolve to the first occurrence.
 */
export const zonedToUtc = (z: Zoned, timeZone: string): Date => {
    const wall = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute);
    let t = wall - offsetMinutes(new Date(wall), timeZone) * 60000;
    t = wall - offsetMinutes(new Date(t), timeZone) * 60000; // re-check near a clock change
    return new Date(t);
};

/** A fixed-offset zone close to solar time, for projects with no time zone set. */
export const fallbackZone = (longitude: number): string => {
    const hours = Math.max(-12, Math.min(14, Math.round(longitude / 15)));
    // The Etc/GMT zones use the opposite sign to the usual convention.
    return hours === 0 ? 'UTC' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
};

export const isoDate = (z: Pick<Zoned, 'year' | 'month' | 'day'>): string =>
    `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;

export const parseIsoDate = (value: string): Pick<Zoned, 'year' | 'month' | 'day'> | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
};

export const formatClock = (minutes: number): string =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
