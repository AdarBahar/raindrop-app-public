import { RequestError } from './util.js';

// Dates in the user's time zone. The server compares UTC instants only.
// The zone is an IANA name, for example Europe/Berlin. Missing means UTC.

// The zone name, or UTC when none is given. An unknown name is refused.
export function zoneOf(name) {
  if (!name) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    throw new RequestError(400, `Unknown time zone: ${name}.`);
  }
}

// The local date and time of an instant in a zone, as numbers.
function partsIn(instant, zone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const parts = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, Number(p.value)]));
  return parts;
}

// The local calendar date of an instant, as [year, month, day].
export function dateOf(instant, zone) {
  const p = partsIn(instant, zone);
  return [p.year, p.month, p.day];
}

// The date that is a number of days from a calendar date. Calendar arithmetic only.
export function addDays([y, m, d], days) {
  const x = new Date(Date.UTC(y, m - 1, d + days));
  return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()];
}

// A date from the browser, as YYYY-MM-DD. Other text is refused.
export function parseDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
  if (!match || new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d || m < 1 || m > 12) {
    throw new RequestError(400, `A date must look like 2026-10-18: ${text}`);
  }
  return [y, m, d];
}

// The first instant of a calendar date in a zone. Local midnight may not exist on that day,
// when the clocks skip it. This finds the first instant whose local date is the day, without
// assuming that midnight exists. Local dates never go backwards as time passes, so a search works.
export function startOfDay(y, m, d, zone) {
  const target = y * 10000 + m * 100 + d;
  const dayKey = (instant) => {
    const [yy, mm, dd] = dateOf(instant, zone);
    return yy * 10000 + mm * 100 + dd;
  };
  // Search in seconds. The guess is two days either side of the date. Both ends are outside the day.
  const center = Math.floor(Date.UTC(y, m - 1, d) / 1000);
  let low = center - 2 * 86400;
  let high = center + 2 * 86400;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dayKey(new Date(mid * 1000)) < target) low = mid + 1;
    else high = mid;
  }
  return new Date(low * 1000);
}
