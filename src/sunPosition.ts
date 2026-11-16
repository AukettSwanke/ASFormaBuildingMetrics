// Solar position (NOAA low-precision algorithm, good to about 0.01°). Pure, no Forma calls.

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export interface SunAngles {
    /** Degrees clockwise from north. */
    azimuth: number;
    /** Degrees above the horizon (negative = below). */
    elevation: number;
}

/** Sun position for an instant (a JS Date is already UTC-based) at latitude/longitude in degrees (east positive). */
export const sunAngles = (date: Date, latitude: number, longitude: number): SunAngles => {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const t = (jd - 2451545) / 36525;
    const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const c = Math.sin(rad(m)) * (1.914602 - t * (0.004817 + 0.000014 * t))
        + Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * t)
        + Math.sin(rad(3 * m)) * 0.000289;
    const omega = 125.04 - 1934.136 * t;
    const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(rad(omega));
    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(rad(omega));
    const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));

    const y = Math.tan(rad(eps / 2)) ** 2;
    const eqTime = 4 * deg(
        y * Math.sin(2 * rad(l0)) - 2 * e * Math.sin(rad(m))
        + 4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0))
        - 0.5 * y * y * Math.sin(4 * rad(l0)) - 1.25 * e * e * Math.sin(2 * rad(m)),
    );
    const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    const solarTime = (((utcMinutes + eqTime + 4 * longitude) % 1440) + 1440) % 1440;
    const hour = rad(solarTime / 4 - 180);

    const lat = rad(latitude);
    const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hour);
    const elevation = deg(Math.asin(Math.max(-1, Math.min(1, sinEl))));
    const azimuth = (deg(Math.atan2(
        Math.sin(hour), Math.cos(hour) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat),
    ) + Math.PI) + 360) % 360;
    return { azimuth, elevation };
};

/**
 * Unit vector pointing from the scene towards the sun, assuming Forma's local axes are
 * X = east, Y = north, Z = up. `rotationDeg` rotates the sun about Z to test that assumption.
 */
export const sunVector = ({ azimuth, elevation }: SunAngles, rotationDeg = 0): [number, number, number] => {
    const az = rad(azimuth + rotationDeg), el = rad(elevation);
    return [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
};
