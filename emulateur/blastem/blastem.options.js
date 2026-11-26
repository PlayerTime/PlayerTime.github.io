/** The native picture, which the SDK scales to fit its mount. */
export const BLASTEM_VIDEO = { width: 640, height: 480, aspect: '4:3' };
export const BLASTEM_SPEC = {
    config: {
        region: {
            default: 'auto',
            enum: ['auto', 'us', 'eu', 'jp'],
            live: false,
            description: 'Console region; auto reads it from the ROM header.',
            label: { en: 'Region', es: 'Región' },
            group: 'emulation',
            valueLabels: [{ en: 'Auto', es: 'Automática' }, { en: 'USA', es: 'EE. UU.' }, { en: 'Europe', es: 'Europa' }, { en: 'Japan', es: 'Japón' }],
        },
        renderFilter: {
            default: 'pixelated',
            enum: ['pixelated', 'smooth'],
            live: true,
            description: 'Scaling: crisp pixels or linear filtering.',
            label: { en: 'Smoothing', es: 'Suavizado' },
            group: 'video',
            valueLabels: [{ en: 'Sharp pixels', es: 'Píxeles nítidos' }, { en: 'Smooth', es: 'Suavizado' }],
        },
        shader: {
            default: 'standard',
            enum: ['standard', 'sharp', 'crt', 'ntsc', 'xbrz'],
            live: true,
            description: "BlastEm's shaders: a CRT, the NTSC composite signal, xBRZ smoothing…",
            label: { en: 'Filter', es: 'Filtro' },
            group: 'video',
            valueLabels: [
                { en: 'None', es: 'Ninguno' },
                { en: 'Sharp', es: 'Nítido' },
                { en: 'CRT', es: 'CRT' },
                { en: 'NTSC composite', es: 'NTSC compuesto' },
                { en: 'xBRZ', es: 'xBRZ' },
            ],
        },
        scanlines: {
            default: false,
            live: true,
            description: 'Dark lines between the lines of the picture.',
            label: { en: 'Scanlines', es: 'Líneas de barrido' },
            group: 'video',
        },
        border: {
            default: 'hidden',
            enum: ['standard', 'hidden', 'full'],
            live: true,
            description: "The border around the picture: BlastEm's default (thin), hidden, or all of it.",
            label: { en: 'Border', es: 'Borde' },
            group: 'video',
            valueLabels: [{ en: 'Thin', es: 'Fino' }, { en: 'Hidden', es: 'Oculto' }, { en: 'Full', es: 'Completo' }],
        },
        jsUrl: { live: false, description: 'Emscripten glue URL. Defaults to ./blastem.js.' },
        wasmUrl: { live: false, description: 'WASM URL. Defaults to ./blastem.wasm.' },
    },
    options: {},
    assets: {
        rom: {
            allowedTypes: ['.bin', '.gen', '.md', '.smd'],
            live: false,
            description: 'The Mega Drive / Genesis cartridge. Required to start.',
        },
    },
    storage: {
        namespace: {
            default: 'default',
            live: false,
            description: "Folder for this game's saves, inside the engine's own blastem/ folder (OPFS blastem/<namespace>/).",
        },
        persist: {
            enum: ['opfs', null],
            live: false,
            description: 'null keeps nothing; otherwise saves are mirrored to OPFS.',
        },
    },
};
