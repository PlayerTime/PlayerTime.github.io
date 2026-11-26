/** Fragment (and vertex) shader per `shader` setting, from BlastEm's shaders/. */
const SHADERS = {
    standard: ['default.f.glsl', 'default.v.glsl'],
    sharp: ['sharp.f.glsl', 'default.v.glsl'],
    crt: ['crt.f.glsl', 'crt.v.glsl'],
    ntsc: ['ntsc.f.glsl', 'default.v.glsl'],
    xbrz: ['xBRZ.f.glsl', 'default.v.glsl'],
    // Not offered: bandlimit_pixel.f.glsl needs fwidth() (OES_standard_derivatives) in WebGL.
};
/**
 * Overscan per `border` setting, [top, bottom, left, right] for NTSC and PAL.
 * `standard` is BlastEm's default.cfg; `hidden` its commented-out "no border" values.
 */
const BORDERS = {
    standard: { ntsc: [2, 1, 13, 14], pal: [21, 17, 13, 14] },
    hidden: { ntsc: [11, 8, 13, 14], pal: [30, 24, 13, 14] },
    full: { ntsc: [0, 0, 0, 0], pal: [0, 0, 0, 0] },
};
const SIDES = ['top', 'bottom', 'left', 'right'];
/** The config entries behind the video settings (unknown values fall back to the defaults). */
export function videoEntries(config) {
    const [fragment, vertex] = SHADERS[config.shader ?? 'standard'] ?? SHADERS.standard;
    const border = BORDERS[config.border ?? 'hidden'] ?? BORDERS.hidden;
    const entries = [
        // BlastEm scales the picture to the canvas itself: sharp pixels need nearest here,
        // the canvas' image-rendering alone only sharpens BlastEm's already-smoothed picture.
        ['video/scaling', config.renderFilter === 'smooth' ? 'linear' : 'nearest'],
        ['video/fragment_shader', fragment],
        ['video/vertex_shader', vertex],
        ['video/scanlines', config.scanlines ? 'on' : 'off'],
    ];
    for (const std of ['ntsc', 'pal']) {
        border[std].forEach((value, i) => entries.push([`video/${std}/overscan/${SIDES[i]}`, String(value)]));
    }
    return entries;
}
/** The config keys whose change rebuilds the picture. */
export const VIDEO_KEYS = ['renderFilter', 'shader', 'scanlines', 'border'];
/**
 * Sets entries in a BlastEm config text (`name {` … `}` blocks, `key value` lines, `#`
 * comments). An existing key keeps its place; a missing one, or a missing block, is added
 * at the end of its parent.
 */
export function patchConfig(text, entries) {
    let lines = text.split('\n');
    for (const [path, value] of entries)
        lines = setEntry(lines, path.split('/'), value);
    return lines.join('\n');
}
const OPEN = /^\s*([^\s#{}]+)\s*\{\s*$/;
const CLOSE = /^\s*\}\s*$/;
const ENTRY = /^(\s*)([^\s#{}]+)(\s+)(.*?)\s*$/;
function setEntry(lines, path, value) {
    const stack = [];
    // Where the deepest existing ancestor of the path closes, and how deep it is.
    let parentEnd = -1;
    let parentDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(#|$)/.test(line))
            continue;
        const open = OPEN.exec(line);
        if (open) {
            stack.push(open[1]);
            continue;
        }
        if (CLOSE.test(line)) {
            const depth = stack.length;
            if (depth > parentDepth && isPrefix(stack, path)) {
                parentEnd = i;
                parentDepth = depth;
            }
            stack.pop();
            continue;
        }
        const entry = ENTRY.exec(line);
        if (entry && stack.length === path.length - 1 && isPrefix(stack, path) && entry[2] === path[path.length - 1]) {
            const out = lines.slice();
            out[i] = `${entry[1]}${entry[2]}${entry[3]}${value}`;
            return out;
        }
    }
    // Not there: add the missing blocks and the entry inside the deepest existing one.
    const missing = path.slice(parentDepth);
    const insert = [];
    missing.forEach((name, k) => {
        const indent = '\t'.repeat(parentDepth + k);
        insert.push(k === missing.length - 1 ? `${indent}${name} ${value}` : `${indent}${name} {`);
    });
    for (let k = missing.length - 2; k >= 0; k--)
        insert.push(`${'\t'.repeat(parentDepth + k)}}`);
    const at = parentEnd >= 0 ? parentEnd : lines.length;
    return [...lines.slice(0, at), ...insert, ...lines.slice(at)];
}
function isPrefix(stack, path) {
    return stack.length < path.length && stack.every((name, i) => name === path[i]);
}
