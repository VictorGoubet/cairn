// Two circular arrows, like the orbit cursor of a CAD tool: holding the right button
// rotates and tilts the camera, which is not discoverable without a hint.
// White halo under a dark stroke keeps it readable over any base map.
const ROTATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24">
<g fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
<path d="M4.5 9.5A8 8 0 0 1 18 6.5"/><path d="M19.5 14.5A8 8 0 0 1 6 17.5"/>
<path d="M18 2.5v4.2h-4.2"/><path d="M6 21.5v-4.2h4.2"/></g>
<g fill="none" stroke="#1a1a1a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<path d="M4.5 9.5A8 8 0 0 1 18 6.5"/><path d="M19.5 14.5A8 8 0 0 1 6 17.5"/>
<path d="M18 2.5v4.2h-4.2"/><path d="M6 21.5v-4.2h4.2"/></g></svg>`;

/** css cursor value, hotspot centered, with a native fallback if the data URI is refused */
export const ROTATE_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(ROTATE_SVG)}") 13 13, grabbing`;

// Eraser mode: a red disc with a white cross, so hovering the map says "this click removes".
const DELETE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">
<circle cx="12" cy="12" r="9.5" fill="#e34948" stroke="#fff" stroke-width="2"/>
<path d="M8.5 8.5l7 7M15.5 8.5l-7 7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`;

/** css cursor value, hotspot centered, with a native fallback if the data URI is refused */
export const DELETE_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(DELETE_SVG)}") 11 11, not-allowed`;
