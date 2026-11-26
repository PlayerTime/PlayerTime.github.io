/**
 * The engine package's entry point: an `EngineSDK` for BlastEm, the Sega Mega Drive /
 * Genesis emulator.
 *
 * ```js
 * import BlastemSDK from '@wasm-gaming/blastem-wasm';
 *
 * const play = await new BlastemSDK()
 *   .assets({ rom: () => readRom() })        // bytes, or a thunk
 *   .storage({ namespace: 'old-towers' })    // → OPFS blastem/old-towers/
 *   .mount(document.querySelector('#stage'))
 *   .start();
 *
 * play.pause('menu'); play.resume('menu');
 * await play.restart();                       // soft reset
 * await play.destroy();                       // saves flushed, loop stopped, audio closed
 * ```
 *
 * Everything a host drives is the contract's (`@wasm-gaming/engine-specs`); what is
 * this engine's own: {@link BlastemConfig} and friends, owner-aware
 * {@link BlastemPlay.pause} / {@link BlastemPlay.resume}, {@link BlastemPlay.storagePath}
 * and the `saves` event.
 *
 * Saves: the wasm build writes every save of the running game to MEMFS `/save`
 * (upstream's `save_path`, patched). The SDK seeds it from OPFS `blastem/<namespace>/`
 * before boot and mirrors it back after asking BlastEm to flush (`web_persist_save`):
 * every 10 s, on pause, when the page is hidden and on destroy. Upstream only flushed
 * at exit, which a web page never reaches.
 */
import { EnginePlayBase, EngineSDKBase, EventEmitter, } from './engine-specs.js';
import { patchConfig, videoEntries, VIDEO_KEYS } from './blastem.video.js';
import { controlTables, keyCodeOf, remapPad } from './blastem.controls.js';
import { BLASTEM_SPEC, BLASTEM_VIDEO, } from './blastem.options.js';
export { BLASTEM_SPEC, BLASTEM_VIDEO } from './blastem.options.js';
export { patchConfig, videoEntries } from './blastem.video.js';
export { BLASTEM_CONTROLS, controlTables, remapPad } from './blastem.controls.js';
const ENGINE_ID = 'blastem';
const DEFAULT_STORAGE_NAMESPACE = 'default';
const SAVE_DIR = '/save';
const ROM_DIR = '/rom';
/** The config BlastEm reads at boot: upstream's default.cfg, embedded in the wasm. */
const CONFIG_FILE = '/default.cfg';
const SAVE_INTERVAL_MS = 10_000;
const REGION_FLAG = { us: 'U', eu: 'E', jp: 'J' };
/**
 * Where an engine keeps one namespace: `<engineId>/<namespace>`, relative to the OPFS
 * root. Identical to rsdkv4's, written to move verbatim into engine-specs: segments
 * cleaned, `.` and `..` dropped, anything outside `[A-Za-z0-9._-]` → `_`, nothing
 * usable → `default`; a leading `<engineId>/` is stripped once.
 */
export function storagePath(engineId, namespace) {
    const segments = typeof namespace === 'string'
        ? namespace
            .split('/')
            .map((segment) => segment.trim())
            .filter((segment) => segment && segment !== '.' && segment !== '..')
            .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
        : [];
    const prefixed = segments.length > 1 && segments[0] === engineId;
    if (prefixed)
        segments.shift();
    const cleaned = segments.join('/') || DEFAULT_STORAGE_NAMESPACE;
    return { namespace: cleaned, path: `${engineId}/${cleaned}`, prefixed };
}
async function opfsDir(path, create) {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory)
        return null;
    try {
        let dir = await navigator.storage.getDirectory();
        for (const segment of path.split('/').filter(Boolean)) {
            dir = await dir.getDirectoryHandle(segment, { create });
        }
        return dir;
    }
    catch {
        return null;
    }
}
async function resolveAsset(asset) {
    const value = typeof asset === 'function' ? await asset() : asset;
    if (value == null)
        return null;
    if (value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    throw new TypeError('blastem: an asset must be a Uint8Array, an ArrayBuffer or a thunk returning one');
}
function sameBytes(a, b) {
    if (!a || a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
/** The ROM's extension, so BlastEm sees the file the way the player named it. */
function romName(bytes) {
    // SMD-interleaved dumps start with a 512-byte header; BlastEm detects them by content.
    return bytes.length % 0x4000 === 512 ? 'game.smd' : 'game.bin';
}
/** The player's save-state slots: 0-3 (BlastEm numbers 0-9). */
export const STATE_SLOTS = 4;
/**
 * The *unsaved* suspend point (Classic Mini style): written when the player leaves,
 * offered when they come back, and saved into a numbered slot only when they ask.
 */
export const AUTO_STATE_SLOT = 9;
const STATE_EXTS = ['state', 'gst'];
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const mtimeOf = (value) => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : 0;
/** The live engine: one booted BlastEm and its session. */
export class BlastemPlay extends EnginePlayBase {
    #module = null;
    #destroyed = false;
    #pauseOwner = null;
    #canvas = null;
    #ownsCanvas = false;
    #box = null;
    #boxObserver = null;
    #namespace = DEFAULT_STORAGE_NAMESPACE;
    #storagePath = `${ENGINE_ID}/${DEFAULT_STORAGE_NAMESPACE}`;
    #persist = true;
    #saveTimer = null;
    #lastSaved = new Map();
    #flushing = null;
    #onHidden = () => {
        if (document.visibilityState === 'hidden')
            void this.flushSaves();
    };
    #controls = {};
    #tables = controlTables();
    #getGamepads = null;
    /**
     * The keyboard, remapped (see `blastem.controls.ts`): a physical key bound to a control
     * reaches BlastEm as that control's default key; a default key no control has any more is
     * swallowed. Real presses only: the ones replayed here pass through.
     */
    #onKey = (event) => {
        if (!event.isTrusted || this.#pauseOwner || !this.#module)
            return;
        const control = this.#tables.keys.get(event.code);
        if (!control && !this.#tables.blocked.has(event.code))
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!control || event.repeat)
            return;
        const replay = new KeyboardEvent(event.type, { code: control.code, key: control.key, bubbles: true, cancelable: true });
        for (const name of ['keyCode', 'which'])
            Object.defineProperty(replay, name, { get: () => keyCodeOf(control) });
        (this.#canvas ?? window).dispatchEvent(replay);
    };
    constructor(init, events) {
        super(BLASTEM_SPEC, init, events);
    }
    /** The normalised namespace this session uses. */
    get namespace() {
        return this.#namespace;
    }
    /** Where this session's saves live, relative to the OPFS root: `blastem/<namespace>`. */
    get storagePath() {
        return this.#storagePath;
    }
    /**
     * The current frame as a PNG, read inside an animation frame (the picture is only
     * there right after the game drew it): take it *before* pausing. Null when there is
     * nothing to read.
     */
    async snapshot() {
        const canvas = this.#canvas;
        if (!canvas || !this.#module)
            return null;
        await nextFrame();
        const copy = document.createElement('canvas');
        copy.width = BLASTEM_VIDEO.width;
        copy.height = BLASTEM_VIDEO.height;
        copy.getContext('2d')?.drawImage(canvas, 0, 0, copy.width, copy.height);
        return new Promise((resolve) => copy.toBlob((blob) => resolve(blob), 'image/png'));
    }
    /** Save states — see {@link BlastemStates}. */
    get states() {
        const Module = this.#requireModule();
        const { FS } = Module;
        const file = (name) => `${SAVE_DIR}/${name}`;
        const exists = (name) => {
            try {
                FS.stat(file(name));
                return true;
            }
            catch {
                return false;
            }
        };
        const stateFile = (slot) => {
            for (const ext of STATE_EXTS) {
                const name = `slot_${slot}.${ext}`;
                try {
                    return { name, mtime: mtimeOf(FS.stat(file(name)).mtime) };
                }
                catch {
                    /* not this one */
                }
            }
            return null;
        };
        const checkSlot = (slot) => {
            if (slot === AUTO_STATE_SLOT || (Number.isInteger(slot) && slot >= 0 && slot < STATE_SLOTS))
                return slot;
            throw new RangeError(`blastem: a state slot is 0-${STATE_SLOTS - 1} or ${AUTO_STATE_SLOT}, not ${slot}`);
        };
        const isLocked = (slot) => exists(`slot_${slot}.lock`);
        const refuseLocked = (slot) => {
            if (isLocked(slot))
                throw new Error(`blastem: state slot ${slot} is locked`);
        };
        const unlink = (name) => {
            try {
                FS.unlink(file(name));
            }
            catch {
                /* not there */
            }
        };
        // Removed files have to leave OPFS too: the mirror only ever writes.
        const forget = async (names) => {
            for (const name of names) {
                unlink(name);
                this.#lastSaved.delete(name);
            }
            const dir = this.#persist ? await opfsDir(this.#storagePath, false) : null;
            for (const name of names)
                await dir?.removeEntry(name).catch(() => { });
        };
        const get = (slot) => {
            checkSlot(slot);
            const state = stateFile(slot);
            let thumbnail = null;
            if (state && exists(`slot_${slot}.png`)) {
                thumbnail = new Blob([new Uint8Array(FS.readFile(file(`slot_${slot}.png`)))], { type: 'image/png' });
            }
            return { slot, savedAt: state ? new Date(state.mtime) : null, thumbnail, locked: isLocked(slot) };
        };
        return {
            list: () => Array.from({ length: STATE_SLOTS }, (_, slot) => get(slot)),
            get,
            save: async (slot, options = {}) => {
                checkSlot(slot);
                refuseLocked(slot);
                const before = stateFile(slot);
                if (!Module._web_save_state(slot))
                    throw new Error('blastem: no game running to save');
                // A paused game has to run for the request to reach a sync point — and BlastEm
                // paces itself on the audio callback, so the sound has to run too: routed
                // through a silent gain for those few frames.
                const owner = this.#pauseOwner;
                const muted = owner ? await this.#runMuted() : null;
                try {
                    const deadline = performance.now() + 3000;
                    let after = stateFile(slot);
                    while (!(after && (!before || after.mtime !== before.mtime)) && performance.now() < deadline) {
                        await nextFrame();
                        after = stateFile(slot);
                    }
                    if (!after)
                        throw new Error('blastem: the state was not written');
                }
                finally {
                    await muted?.();
                }
                if (options.thumbnail) {
                    FS.writeFile(file(`slot_${slot}.png`), new Uint8Array(await options.thumbnail.arrayBuffer()));
                }
                else
                    await forget([`slot_${slot}.png`]);
                await this.flushSaves();
            },
            load: (slot) => {
                checkSlot(slot);
                if (!stateFile(slot))
                    return false;
                return Module._web_load_state(slot) !== 0;
            },
            copy: async (from, to) => {
                checkSlot(from);
                checkSlot(to);
                refuseLocked(to);
                const state = stateFile(from);
                if (!state)
                    throw new Error(`blastem: state slot ${from} is empty`);
                const ext = state.name.slice(state.name.lastIndexOf('.') + 1);
                await forget(STATE_EXTS.map((e) => `slot_${to}.${e}`).concat(`slot_${to}.png`));
                FS.writeFile(file(`slot_${to}.${ext}`), new Uint8Array(FS.readFile(file(state.name))));
                if (exists(`slot_${from}.png`)) {
                    FS.writeFile(file(`slot_${to}.png`), new Uint8Array(FS.readFile(file(`slot_${from}.png`))));
                }
                await this.flushSaves();
            },
            lock: async (slot, locked) => {
                checkSlot(slot);
                if (locked) {
                    if (!stateFile(slot))
                        throw new Error(`blastem: state slot ${slot} is empty`);
                    FS.writeFile(file(`slot_${slot}.lock`), new Uint8Array([1]));
                    await this.flushSaves();
                }
                else {
                    await forget([`slot_${slot}.lock`]);
                    this.emit('saves', { files: [`slot_${slot}.lock`] });
                }
            },
            remove: async (slot) => {
                checkSlot(slot);
                refuseLocked(slot);
                const names = [...STATE_EXTS.map((ext) => `slot_${slot}.${ext}`), `slot_${slot}.png`];
                await forget(names);
                this.emit('saves', { files: names });
            },
        };
    }
    /** Run the paused loop with the sound going nowhere; returns the undo. */
    async #runMuted() {
        const Module = this.#requireModule();
        const context = Module.SDL2?.audioContext;
        const node = Module.SDL2?.audio?.scriptProcessorNode;
        let gain = null;
        if (context && node) {
            gain = context.createGain();
            gain.gain.value = 0;
            gain.connect(context.destination);
            node.disconnect();
            node.connect(gain);
            await context.resume().catch(() => { });
        }
        Module._emscripten_resume_main_loop();
        return async () => {
            // Still paused by the same owner (nobody resumed meanwhile): freeze again.
            if (this.#pauseOwner) {
                Module._emscripten_pause_main_loop();
                await context?.suspend().catch(() => { });
            }
            if (context && node && gain) {
                node.disconnect();
                node.connect(context.destination);
                gain.disconnect();
            }
        };
    }
    #requireModule() {
        if (!this.#module)
            throw new Error('blastem: the engine is not running — start() it first');
        return this.#module;
    }
    /** Who holds the pause, or null while running. */
    get pausedBy() {
        return this.#pauseOwner;
    }
    /**
     * Rebind the Mega Drive pad (ids from {@link BLASTEM_CONTROLS}): player 1's physical keys
     * (`KeyboardEvent.code`) and every pad's buttons (standard mapping). What is left out keeps
     * BlastEm's default. Live.
     */
    setControls(controls) {
        this.#controls = controls;
        this.#tables = controlTables(controls);
    }
    /**
     * Freeze emulation and sound. The first caller owns the pause, and only that
     * owner's {@link resume} lifts it, so an overlay cannot resume a game the host had
     * already frozen. Saves are flushed, since a paused game is often a closed one.
     */
    pause(owner = 'host') {
        const Module = this.#module;
        if (!Module || this.#pauseOwner)
            return;
        this.#pauseOwner = owner;
        Module._emscripten_pause_main_loop();
        void Module.SDL2?.audioContext?.suspend();
        void this.flushSaves();
        this.emit('pause', { owner });
    }
    resume(owner = 'host') {
        const Module = this.#module;
        if (!Module || this.#pauseOwner !== owner)
            return;
        this.#pauseOwner = null;
        void Module.SDL2?.audioContext?.resume();
        Module._emscripten_resume_main_loop();
        this.emit('resume', { owner });
    }
    /**
     * Ask BlastEm to write its saves, then copy whatever changed in `/save` to OPFS
     * `blastem/<namespace>/`. Emits `saves` with the files that moved. Safe to call any
     * time; overlapping calls share one flush.
     */
    flushSaves() {
        this.#flushing ??= this.#flush().finally(() => {
            this.#flushing = null;
        });
        return this.#flushing;
    }
    // ---- Contract hooks ----
    mounted(target) {
        if (target instanceof HTMLCanvasElement) {
            this.#canvas = target;
            this.#ownsCanvas = false;
            this.#box = target.parentElement;
        }
        else {
            this.#canvas = document.createElement('canvas');
            this.#ownsCanvas = true;
            this.#box = target;
            target.appendChild(this.#canvas);
        }
        const canvas = this.#canvas;
        // Emscripten's SDL2 finds its window by id, and measures the element: no border or
        // padding on the canvas itself, or SDL creates a tiny window.
        canvas.id = 'canvas';
        canvas.width = BLASTEM_VIDEO.width;
        canvas.height = BLASTEM_VIDEO.height;
        canvas.tabIndex = 0;
        canvas.style.border = '0';
        canvas.style.padding = '0';
        canvas.style.display = 'block';
        canvas.addEventListener('contextmenu', (event) => event.preventDefault());
        void this.#applyFilter();
        if (this.#box && this.#ownsCanvas) {
            this.#boxObserver?.disconnect();
            this.#boxObserver = new ResizeObserver(() => this.#fit());
            this.#boxObserver.observe(this.#box);
            this.#fit();
        }
    }
    async open(_options) {
        if (this.#destroyed) {
            throw new Error('blastem: this engine has been destroyed and cannot be started again in this page — build a new BlastemSDK in a new page');
        }
        if (this.#module) {
            // Already running: a restart is BlastEm's soft reset.
            if (this.#pauseOwner)
                this.resume(this.#pauseOwner);
            this.#module._web_soft_reset();
            return;
        }
        await this.#boot();
    }
    patched(kind, patch) {
        if (kind === 'config' && 'renderFilter' in patch)
            void this.#applyFilter();
        if (kind === 'config' && VIDEO_KEYS.some((key) => key in patch))
            void this.#applyVideo();
    }
    async close() {
        window.removeEventListener('keydown', this.#onKey, true);
        window.removeEventListener('keyup', this.#onKey, true);
        if (this.#getGamepads)
            navigator.getGamepads = this.#getGamepads;
        this.#getGamepads = null;
        if (this.#saveTimer)
            clearInterval(this.#saveTimer);
        this.#saveTimer = null;
        document.removeEventListener('visibilitychange', this.#onHidden);
        window.removeEventListener('pagehide', this.#onHidden);
        const Module = this.#module;
        if (Module) {
            await this.flushSaves();
            try {
                Module._emscripten_pause_main_loop();
            }
            catch {
                /* already gone */
            }
            try {
                await Module.SDL2?.audioContext?.close();
            }
            catch {
                /* already closed */
            }
        }
        this.#boxObserver?.disconnect();
        this.#boxObserver = null;
        if (this.#ownsCanvas)
            this.#canvas?.remove();
        this.#canvas = null;
        this.#module = null;
        this.#pauseOwner = null;
        this.#destroyed = true;
    }
    // ---- Boot ----
    async #boot() {
        const config = await this.#values('config');
        const assets = await this.#values('assets');
        const storage = await this.#values('storage');
        if (!this.#canvas) {
            throw new Error('blastem: mount() an element (or a canvas) before start()');
        }
        const rom = await resolveAsset(assets.rom);
        if (!rom)
            throw new Error('blastem: no ROM — hand one over as assets.rom (bytes or a thunk)');
        const resolved = storagePath(ENGINE_ID, storage.namespace);
        this.#namespace = resolved.namespace;
        this.#storagePath = resolved.path;
        this.#persist = storage.persist !== null;
        const jsUrl = config.jsUrl ?? new URL('./blastem.js', import.meta.url).href;
        const wasmUrl = config.wasmUrl ?? new URL('./blastem.wasm', import.meta.url).href;
        const { default: createBlastem } = (await import(/* @vite-ignore */ jsUrl));
        let failed = null;
        const Module = await createBlastem({
            canvas: this.#canvas,
            noInitialRun: true,
            locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : new URL(path, jsUrl).href),
            print: (text) => console.log('[blastem]', text),
            printErr: (text) => console.warn('[blastem]', text),
            onAbort: (what) => failed?.(new Error(`blastem: aborted — ${String(what)}`)),
        });
        this.#module = Module;
        failed = (error) => this.emit('error', error);
        const { FS } = Module;
        for (const dir of [ROM_DIR, SAVE_DIR]) {
            try {
                FS.mkdir(dir);
            }
            catch {
                /* exists */
            }
        }
        const name = romName(rom);
        FS.writeFile(`${ROM_DIR}/${name}`, rom);
        // The video settings, in the config BlastEm reads at boot (the bundled default.cfg).
        const cfg = new TextDecoder().decode(FS.readFile(CONFIG_FILE));
        FS.writeFile(CONFIG_FILE, new TextEncoder().encode(patchConfig(cfg, videoEntries(config))));
        if (this.#persist)
            await this.#restoreSaves();
        const args = [];
        if (config.region && config.region !== 'auto')
            args.push('-r', REGION_FLAG[config.region]);
        args.push(`${ROM_DIR}/${name}`, String(BLASTEM_VIDEO.width), String(BLASTEM_VIDEO.height));
        // The player's bindings sit in front of SDL: keys on the window (capture), pads through
        // a wrapped navigator.getGamepads().
        this.#tables = controlTables(this.#controls);
        window.addEventListener('keydown', this.#onKey, true);
        window.addEventListener('keyup', this.#onKey, true);
        const nav = navigator;
        if (nav.getGamepads) {
            const original = nav.getGamepads.bind(nav);
            this.#getGamepads = nav.getGamepads;
            nav.getGamepads = () => original().map((pad) => (pad ? remapPad(pad, this.#tables.pad) : pad));
        }
        Module.callMain(args);
        if (this.#persist) {
            this.#saveTimer = setInterval(() => void this.flushSaves(), SAVE_INTERVAL_MS);
            document.addEventListener('visibilitychange', this.#onHidden);
            window.addEventListener('pagehide', this.#onHidden);
        }
        this.#fit();
    }
    /** The plain values behind one payload's descriptors. */
    async #values(kind) {
        const described = (await this[kind]());
        const out = {};
        for (const [key, property] of Object.entries(described))
            out[key] = property.value;
        return out;
    }
    // ---- Saves ----
    async #restoreSaves() {
        const dir = await opfsDir(this.#storagePath, false);
        if (!dir || !this.#module)
            return;
        const iterable = dir;
        for await (const [name, handle] of iterable.entries()) {
            if (handle.kind !== 'file')
                continue;
            const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
            this.#module.FS.writeFile(`${SAVE_DIR}/${name}`, bytes);
            this.#lastSaved.set(name, bytes);
        }
    }
    async #flush() {
        const Module = this.#module;
        if (!Module || !this.#persist)
            return;
        try {
            Module._web_persist_save();
        }
        catch (e) {
            console.warn('[blastem] persist_save failed', e);
            return;
        }
        const changed = [];
        for (const name of Module.FS.readdir(SAVE_DIR)) {
            if (name === '.' || name === '..')
                continue;
            const path = `${SAVE_DIR}/${name}`;
            if (!Module.FS.isFile(Module.FS.stat(path).mode))
                continue;
            const bytes = new Uint8Array(Module.FS.readFile(path));
            if (!sameBytes(this.#lastSaved.get(name), bytes))
                changed.push([name, bytes]);
        }
        if (changed.length === 0)
            return;
        const dir = await opfsDir(this.#storagePath, true);
        if (!dir)
            return;
        const written = [];
        for (const [name, bytes] of changed) {
            try {
                const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
                await writable.write(bytes);
                await writable.close();
                this.#lastSaved.set(name, bytes);
                written.push(name);
            }
            catch (e) {
                console.warn(`[blastem] could not persist ${name}`, e);
            }
        }
        if (written.length)
            this.emit('saves', { files: written });
    }
    // ---- Picture ----
    #fit() {
        const canvas = this.#canvas;
        const box = this.#box;
        if (!canvas || !box || !this.#ownsCanvas)
            return;
        const { width, height } = box.getBoundingClientRect();
        if (!width || !height)
            return;
        const scale = Math.min(width / BLASTEM_VIDEO.width, height / BLASTEM_VIDEO.height);
        canvas.style.width = `${Math.floor(BLASTEM_VIDEO.width * scale)}px`;
        canvas.style.height = `${Math.floor(BLASTEM_VIDEO.height * scale)}px`;
    }
    /** The video settings while the game runs: into BlastEm's config, then the renderer rebuilt. */
    async #applyVideo() {
        const Module = this.#module;
        if (!Module?._web_apply_video)
            return; // not booted yet (the boot writes them), or an older wasm
        const config = await this.#values('config');
        for (const [path, value] of videoEntries(config)) {
            Module.ccall('web_set_config', 'number', ['string', 'string'], [path, value]);
        }
        Module._web_apply_video();
        this.#fit();
    }
    async #applyFilter() {
        const canvas = this.#canvas;
        if (!canvas)
            return;
        const { renderFilter } = await this.#values('config');
        canvas.style.imageRendering = renderFilter === 'smooth' ? 'auto' : 'pixelated';
    }
}
/**
 * The factory a host constructs: static identity, the configuration chain, and a
 * `start()` that boots BlastEm and opens a session.
 */
export class BlastemSDK extends EngineSDKBase {
    static id = ENGINE_ID;
    /** Kept in step with package.json by `node scripts/sync-version.mjs`. */
    static version = '0.3.1';
    static name = 'BlastEm';
    static description = 'BlastEm, the Sega Mega Drive / Genesis emulator by Michael Pavone, compiled to WebAssembly. Ships no games: the player provides the ROM, and it never leaves their browser.';
    createPlay(init, events) {
        return new BlastemPlay(init, events);
    }
}
/** CI's conformance line: if this class stops satisfying the contract, `make test` fails. */
export const BLASTEM_ENGINE = BlastemSDK;
export default BlastemSDK;
