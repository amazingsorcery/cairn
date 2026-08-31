// `suncalc` 2.x ships named ESM exports and no default. Importing a default here silently
// yields `undefined`, and the first call fails at runtime rather than at build time.
import { getPosition, getTimes } from "suncalc";

/**
 * Solar geometry, and the inverse problem an investigator actually has.
 *
 * The forward direction — where is the sun, given a place and a time — is arithmetic. The
 * useful direction is backwards: a photograph shows a shadow, the location is known or
 * suspected, and the question is *when was this taken*. That is chronolocation, and it is
 * one of the few techniques that can contradict a claimed capture time using nothing but the
 * image.
 *
 * WHAT THIS CANNOT TELL YOU, stated here because the tool page says the same thing:
 *
 *   - **Shadow length gives you two times a day, not one.** The sun reaches the same
 *     elevation once climbing and once descending. Only the shadow's *direction* separates
 *     morning from afternoon, and that requires knowing which way is north in the frame.
 *   - **It gives a time of day, never a date.** The same elevation recurs on two dates each
 *     year, symmetric about the solstice, and near the equator the annual variation is so
 *     small that almost any date fits.
 *   - **The measurement dominates the error.** A shadow tip that is soft, foreshortened by
 *     the camera angle, or falling on sloping ground can easily be 15% out, and at low sun
 *     elevations a 15% length error is more than an hour.
 *   - **A negative result is weak.** If the shadows do not match the claimed time, the
 *     photograph may be mistimed, or your location may be wrong, or the ground may not be
 *     level. If they do match, you have failed to falsify one claim, which is not the same
 *     as confirming it.
 *
 * Positions come from `suncalc` 2.x, which implements the low-precision solar algorithms in
 * Jean Meeus, *Astronomical Algorithms*. Those are accurate to roughly a minute of arc for
 * the sun — far finer than any shadow measured off a photograph, and not adequate for
 * astronomy. Its altitudes are **apparent**: atmospheric refraction is already applied,
 * which is the right convention here, because a shadow follows where the sun appears to be
 * and not where it geometrically is. Refraction matters only within about a degree of the
 * horizon, where it lifts the sun by roughly half a degree.
 */

const RAD = Math.PI / 180;

export interface SolarPosition {
  /** Degrees above the horizon. Negative when the sun is down. */
  readonly elevationDegrees: number;
  /** Degrees clockwise from true north: 0 = N, 90 = E, 180 = S, 270 = W. */
  readonly azimuthDegrees: number;
  /**
   * Length of the shadow of a vertical object, as a multiple of its height, on level ground.
   * `null` when the sun is at or below the horizon, where the ratio is infinite or undefined.
   */
  readonly shadowRatio: number | null;
  /** Direction the shadow points, degrees clockwise from true north. `null` when sun is down. */
  readonly shadowBearingDegrees: number | null;
}

/**
 * `suncalc` 2.x reports degrees, with azimuth already measured clockwise from north — the
 * same convention as a compass bearing, a map bearing and EXIF `GPSImgDirection`. Version
 * 1.x reported radians measured from **south**, so code written against the older API is
 * 180 degrees out here and silently so. The normalisation below is the only place this
 * convention is asserted.
 */
export function solarPosition(latitude: number, longitude: number, when: Date): SolarPosition {
  const position = getPosition(when, latitude, longitude);
  const elevationDegrees = position.altitude;
  const azimuthDegrees = ((position.azimuth % 360) + 360) % 360;

  const aboveHorizon = elevationDegrees > 0;
  return {
    elevationDegrees,
    azimuthDegrees,
    shadowRatio: aboveHorizon ? 1 / Math.tan(elevationDegrees * RAD) : null,
    // A shadow falls directly away from the sun.
    shadowBearingDegrees: aboveHorizon ? (azimuthDegrees + 180) % 360 : null,
  };
}

/** Elevation, in degrees, whose shadow-to-height ratio is `ratio`. Inverse of `1/tan(e)`. */
export function elevationForShadowRatio(ratio: number): number {
  return Math.atan(1 / ratio) / RAD;
}

/** Shadow-to-height ratio at a given solar elevation. */
export function shadowRatioForElevation(elevationDegrees: number): number {
  return 1 / Math.tan(elevationDegrees * RAD);
}

export interface SunTimes {
  readonly sunrise: Date | null;
  readonly solarNoon: Date;
  readonly sunset: Date | null;
  readonly maximumElevationDegrees: number;
  /** True on days the sun never rises or never sets at this latitude. */
  readonly polarDay: boolean;
  readonly polarNight: boolean;
}

function validDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

export function sunTimes(latitude: number, longitude: number, when: Date): SunTimes {
  const times = getTimes(when, latitude, longitude);
  const solarNoon = validDate(times.solarNoon) ?? when;
  const maximum = solarPosition(latitude, longitude, solarNoon).elevationDegrees;
  const sunrise = validDate(times.sunrise);
  const sunset = validDate(times.sunset);
  return {
    sunrise,
    solarNoon,
    sunset,
    maximumElevationDegrees: maximum,
    // suncalc reports these itself for a polar day or night. Falling back to the sign of the
    // noon elevation keeps the two fields consistent if the upstream stops setting them.
    polarDay: times.alwaysUp === true || (sunrise === null && maximum > 0),
    polarNight: times.alwaysDown === true || (sunrise === null && maximum <= 0),
  };
}

export interface ShadowMatch {
  readonly time: Date;
  readonly elevationDegrees: number;
  readonly azimuthDegrees: number;
  readonly shadowBearingDegrees: number;
  /** Before or after solar noon — the half of the day this candidate falls in. */
  readonly half: "morning" | "afternoon";
}

export interface InverseShadowResult {
  readonly targetElevationDegrees: number;
  readonly matches: readonly ShadowMatch[];
  /** Populated when no time of day reaches the required elevation. */
  readonly unreachableReason: string | null;
  readonly maximumElevationDegrees: number;
}

/**
 * Which times on a given local day produce the observed shadow ratio.
 *
 * Scans the UTC day around the location's solar noon at one-minute steps, finds every
 * crossing of the target elevation, then bisects each crossing to the second. Two crossings
 * is the normal answer; one means the sun only grazed that elevation at noon; none means the
 * sun never got that high on this date, which is itself a finding — it falsifies either the
 * claimed date or the claimed location.
 *
 * `on` is used for its calendar date. The window searched runs from 24 hours before solar
 * noon to 24 hours after, so a location whose local day straddles the UTC date boundary is
 * still covered.
 */
export function timesForShadowRatio(
  latitude: number,
  longitude: number,
  on: Date,
  shadowRatio: number,
): InverseShadowResult {
  const maximum = sunTimes(latitude, longitude, on).maximumElevationDegrees;

  if (!Number.isFinite(shadowRatio) || shadowRatio <= 0) {
    return {
      targetElevationDegrees: Number.NaN,
      matches: [],
      unreachableReason: "A shadow ratio must be greater than zero. Divide the shadow's length by the height of the object casting it.",
      maximumElevationDegrees: maximum,
    };
  }

  const target = elevationForShadowRatio(shadowRatio);

  if (target > maximum) {
    return {
      targetElevationDegrees: target,
      matches: [],
      unreachableReason:
        `The sun does not reach ${target.toFixed(1)} degrees at this location on this date — it tops out at ${maximum.toFixed(1)} degrees. ` +
        `A shadow this short is impossible here on this day, so either the date or the location is wrong.`,
      maximumElevationDegrees: maximum,
    };
  }

  const noon = sunTimes(latitude, longitude, on).solarNoon;
  const startMs = noon.getTime() - 12 * 3_600_000;
  const stepMs = 60_000;
  const steps = 24 * 60;

  const elevationAt = (ms: number): number =>
    solarPosition(latitude, longitude, new Date(ms)).elevationDegrees;

  const matches: ShadowMatch[] = [];
  let previousMs = startMs;
  let previous = elevationAt(previousMs);

  for (let i = 1; i <= steps; i += 1) {
    const currentMs = startMs + i * stepMs;
    const current = elevationAt(currentMs);
    const crosses = (previous - target) * (current - target) < 0;
    if (crosses) {
      // Bisect to the second. Twelve halvings of a 60-second bracket lands well inside it.
      let lowMs = previousMs;
      let highMs = currentMs;
      let lowValue = previous;
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const midMs = (lowMs + highMs) / 2;
        const midValue = elevationAt(midMs);
        if ((lowValue - target) * (midValue - target) <= 0) {
          highMs = midMs;
        } else {
          lowMs = midMs;
          lowValue = midValue;
        }
      }
      const time = new Date(Math.round((lowMs + highMs) / 2));
      const position = solarPosition(latitude, longitude, time);
      if (position.shadowBearingDegrees !== null) {
        matches.push({
          time,
          elevationDegrees: position.elevationDegrees,
          azimuthDegrees: position.azimuthDegrees,
          shadowBearingDegrees: position.shadowBearingDegrees,
          half: time.getTime() < noon.getTime() ? "morning" : "afternoon",
        });
      }
    }
    previousMs = currentMs;
    previous = current;
  }

  return {
    targetElevationDegrees: target,
    matches,
    unreachableReason:
      matches.length === 0
        ? `The sun crosses ${target.toFixed(1)} degrees nowhere in this day. Check the date, the location and the ratio.`
        : null,
    maximumElevationDegrees: maximum,
  };
}

/**
 * Smallest angle between two bearings, in degrees, ignoring which way round.
 *
 * Used to rank candidate times against an observed shadow direction: a reader who can say
 * which way is north in the frame can usually eliminate one of the two candidates outright,
 * because morning and afternoon shadows point to opposite sides of the meridian.
 */
export function bearingDifference(a: number, b: number): number {
  const difference = Math.abs(((a - b + 540) % 360) - 180);
  return difference;
}
