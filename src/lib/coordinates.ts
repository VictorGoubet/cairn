/**
 * Coordinates typed by hand, in the formats a hiker actually copies around.
 *
 * Geocaching listings publish degrees and decimal minutes with the hemisphere in front
 * (`N 44° 37.908 E 006° 46.512`), map apps hand out decimal degrees, and topo guides use
 * degrees-minutes-seconds with the letter behind. Two grammars are read rather than one
 * catch-all: a bare `44 37.9` is genuinely ambiguous (two degrees, or degrees and minutes?), so
 * the sexagesimal reading requires a symbol or a hemisphere letter to say so. Anything still
 * ambiguous is rejected: sending someone to the wrong valley is worse than saying "not
 * understood".
 *
 * One letter for two numbers stays under-specified (`44.6 O 1.5`: does the O trail the first or
 * lead the second?). It is read as trailing, the DMS convention; west and south are best given
 * with a letter on each axis, or with a minus sign.
 */

import type { LonLat } from './geo';

interface Part {
  /** degrees, then optionally minutes, then optionally seconds */
  numbers: number[];
  hemisphere: string;
}

const HAS_SEXAGESIMAL = /[°º'′"″]|[NSEWO]/i;
const TOKEN = /[NSEWO]|\d+(?:[.,]\d+)?|[°º'′"″]/gi;

/**
 * Reads a pair of coordinates from free text.
 *
 * Args:
 *   text: user input, "44.6318, 6.7752" or "N 44° 37.908 E 006° 46.512" or "44°37'54\"N ...".
 *
 * Returns:
 *   The position, or null when the text is not an unambiguous pair.
 */
export function parseCoordinates(text: string): LonLat | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = HAS_SEXAGESIMAL.test(trimmed) ? sexagesimalParts(trimmed) : decimalParts(trimmed);
  if (parts.length !== 2) return null;

  const values = parts.map(toDegrees);
  if (values.some(v => v === null)) return null;
  const [first, second] = parts.map((part, i) => ({ ...part, value: values[i] as number }));
  // a hemisphere letter decides which axis is which; without one, latitude comes first, as
  // every mapping convention writes it
  const firstIsLat = first.hemisphere
    ? 'NS'.includes(first.hemisphere)
    : !(second.hemisphere && 'EWO'.includes(second.hemisphere));
  const lat = signed(firstIsLat ? first : second, 'S');
  const lon = signed(firstIsLat ? second : first, 'WO');
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

/** "44.63180, 6.77520", the form the app writes back into the search field */
export function formatCoordinates([lon, lat]: LonLat): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** plain decimal degrees: two numbers, separated by whitespace or by a comma */
function decimalParts(text: string): Part[] {
  const bySpace = text.split(/\s+/).filter(Boolean);
  // whitespace first: it survives "44,6318 6,7752", where the comma is a decimal separator
  const chunks = bySpace.length === 2 ? bySpace.map(c => c.replace(/,$/, '')) : text.split(',');
  // a dangling separator leaves an empty chunk, and Number('') is 0: half a coordinate typed
  // must parse as nothing, not as a point off the coast of Africa
  if (chunks.length !== 2 || chunks.some(chunk => chunk.trim() === '')) return [];
  return chunks.map(chunk => ({ numbers: [Number(chunk.trim().replace(',', '.'))], hemisphere: '' }));
}

function sexagesimalParts(text: string): Part[] {
  const parts: Part[] = [];
  let current: Part = { numbers: [], hemisphere: '' };
  const flush = () => {
    if (current.numbers.length > 0) parts.push(current);
    current = { numbers: [], hemisphere: '' };
  };
  for (const token of text.toUpperCase().match(TOKEN) ?? []) {
    if (/[NSEWO]/.test(token)) {
      // a letter after the numbers closes the part it trails, unless that part already has its
      // own letter in front: then this one opens the next axis (the geocaching notation)
      if (current.numbers.length > 0 && !current.hemisphere) {
        current.hemisphere = token;
        flush();
      } else {
        flush();
        current.hemisphere = token;
      }
    } else if (/\d/.test(token)) {
      if (current.numbers.length >= 3) flush();
      current.numbers.push(Number(token.replace(',', '.')));
    }
  }
  flush();
  return parts;
}

function toDegrees({ numbers }: Part): number | null {
  const [degrees, minutes = 0, seconds = 0] = numbers;
  if (!Number.isFinite(degrees) || minutes >= 60 || seconds >= 60) return null;
  const magnitude = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  return degrees < 0 ? -magnitude : magnitude;
}

// an empty hemisphere must not match: `''.includes('')` is true, which silently flipped signs
function signed(part: Part & { value: number }, negatives: string): number {
  return part.hemisphere && negatives.includes(part.hemisphere) ? -Math.abs(part.value) : part.value;
}
