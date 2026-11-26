// ---- Introspectable property definitions ----
/**
 * The listener bookkeeping, shipped rather than described — the one piece of runtime
 * code in this package.
 *
 * It is a **convenience, not a requirement**: the contract stays structural, so an
 * engine that already owns an emitter satisfies {@link EngineSurface} without this.
 * What it saves is the part everyone gets subtly wrong — iterating a copy, so a
 * listener that unsubscribes mid-emit does not corrupt the loop; de-duplicating a
 * listener registered twice; and keeping one throwing listener from silencing the
 * rest.
 *
 * Hold it **privately** and hand the same instance to every carrier. That is what
 * makes `sdk.on(…)` and `play.on(…)` one channel rather than two, lets a host
 * subscribe before the engine exists, and keeps `emit` out of the public API — a host
 * must not be able to forge an engine event.
 */
export class EventEmitter {
    #listeners = new Map();
    /** @param listeners Registered immediately — what `EngineInit.on` carries. */
    constructor(listeners) {
        for (const type of Object.keys(listeners ?? {})) {
            const listener = listeners?.[type];
            if (listener)
                this.on(type, listener);
        }
    }
    /** Registering the same listener twice registers it once, as `EventTarget` does. */
    on(type, listener) {
        let set = this.#listeners.get(type);
        if (!set)
            this.#listeners.set(type, (set = new Set()));
        set.add(listener);
        return this;
    }
    /**
     * The listener is required, as in `EventTarget`. A convenience `off(type)` dropping
     * every listener for a type is a footgun on a page where two components subscribed
     * independently: one unsubscribing would silence the other.
     */
    off(type, listener) {
        const set = this.#listeners.get(type);
        if (set?.delete(listener) && set.size === 0) {
            this.#listeners.delete(type);
        }
        return this;
    }
    /**
     * Takes the **detail**, and wraps it. The rest tuple is what lets an event with no
     * detail be emitted as `emit('exit')` while still checking the ones that have one.
     */
    emit(type, ...[detail]) {
        const set = this.#listeners.get(type);
        if (!set)
            return;
        // Built once and frozen: every listener gets this same object, so a mutable one
        // would let the first rewrite what the rest read.
        const event = Object.freeze({ type, detail: detail });
        // A copy: a listener may call `off()` — on itself or another — while this runs.
        for (const listener of [...set]) {
            try {
                listener(event);
            }
            catch (thrown) {
                // One bad listener must neither silence the rest nor vanish. Rethrowing on a
                // fresh task puts it in front of `window.onerror` with its stack intact.
                queueMicrotask(() => {
                    throw thrown;
                });
            }
        }
    }
}
/**
 * Wrap a promise of a live engine in the chainable surface.
 *
 * Exported because it is the single most duplicated function in an engine, and an
 * engine that does not extend {@link EnginePlayBase} still needs exactly this.
 *
 * `on` and `off` do **not** go through the chain: they reach the channel now, so a
 * listener is live before the promise settles. Routing them through it would bind
 * after the session opened and lose whatever was emitted while it was opening.
 */
export function hydratePlay(inner, events) {
    const chain = (step) => hydratePlay(inner.then(async (play) => {
        await step(play);
        return play;
    }), events);
    const hydrated = {
        then: (onfulfilled, onrejected) => inner.then(onfulfilled, onrejected),
        catch: (onrejected) => inner.catch(onrejected),
        finally: (onfinally) => inner.finally(onfinally),
        [Symbol.toStringTag]: 'PromisePlay',
        config: ((patch) => patch === undefined
            ? inner.then((play) => play.config())
            : chain((play) => play.config(patch))),
        options: ((patch) => patch === undefined
            ? inner.then((play) => play.options())
            : chain((play) => play.options(patch))),
        assets: ((patch) => patch === undefined
            ? inner.then((play) => play.assets())
            : chain((play) => play.assets(patch))),
        storage: ((patch) => patch === undefined
            ? inner.then((play) => play.storage())
            : chain((play) => play.storage(patch))),
        mount: (target) => chain((play) => play.mount(target)),
        on: (type, listener) => {
            events.on(type, listener);
            return hydrated;
        },
        off: (type, listener) => {
            events.off(type, listener);
            return hydrated;
        },
        restart: (options) => chain((play) => play.restart(options)),
        destroy: () => inner.then((play) => play.destroy()),
    };
    return hydrated;
}
/**
 * The live engine, with everything the contract prescribes already written: state,
 * the cumulative merge, the descriptors, the chainable promise, and the channel.
 *
 * A subclass supplies what only it can know — {@link EnginePlayBase.open} and
 * {@link EnginePlayBase.close}, optionally {@link EnginePlayBase.mounted} and
 * {@link EnginePlayBase.patched} — and its properties as an {@link EngineSpec}.
 *
 * The spec arrives as a **constructor argument**, not an abstract field, and that is
 * not a style choice: a subclass field initialiser runs *after* `super()`, so a
 * `protected abstract spec` would still be `undefined` while this constructor seeded
 * state from it. Passing it up makes the ordering trap impossible rather than merely
 * avoided.
 */
export class EnginePlayBase {
    #spec;
    #state;
    #events;
    #target;
    /** The target {@link EnginePlayBase.mounted} has already been told about. */
    #attached;
    /**
     * @param events The factory's channel. Omitted only when a play is built on its
     * own; the factory always passes its own, which is what makes `sdk.on(…)` and
     * `play.on(…)` one channel rather than two.
     */
    constructor(spec, init, events) {
        this.#spec = spec;
        this.#events = events ?? new EventEmitter(init?.on);
        this.#state = {
            config: seed(spec.config, init?.config),
            options: seed(spec.options, init?.options),
            assets: seed(spec.assets, init?.assets),
            storage: seed(spec.storage, init?.storage),
        };
        // Recorded, not applied. `mounted()` is overridable, and a subclass's own fields
        // are still uninitialised while this constructor runs — so the hook is deferred to
        // the first `restart()`, by which point the subclass is whole.
        this.#target = init?.mount;
    }
    /** The element is already recorded when this runs. */
    mounted(target) {
        void target;
    }
    /** A payload changed on a running engine — apply what is `live`, ignore the rest. */
    patched(kind, patch) {
        void kind;
        void patch;
    }
    /**
     * Emit one of this engine's own events.
     *
     * `protected`, so a typed host cannot forge an engine event — but be exact about
     * what that buys: TypeScript erases `protected`, so this is a compile-time guard,
     * not a capability boundary. Plain JavaScript can still reach it. Only the `#`
     * fields below — the channel and the state — are unreachable at runtime.
     */
    emit(type, ...detail) {
        this.#events.emit(type, ...detail);
    }
    /** Where the picture is, for a subclass that needs the element after `mounted()`. */
    get target() {
        return this.#target;
    }
    config(patch) {
        // `arguments.length`, not `patch === undefined`: `config(undefined)` is a write of
        // nothing, not a read.
        if (arguments.length === 0)
            return Promise.resolve(this.#describe('config'));
        return this.#patch('config', patch);
    }
    options(patch) {
        if (arguments.length === 0)
            return Promise.resolve(this.#describe('options'));
        return this.#patch('options', patch);
    }
    assets(patch) {
        if (arguments.length === 0)
            return Promise.resolve(this.#describe('assets'));
        return this.#patch('assets', patch);
    }
    storage(patch) {
        if (arguments.length === 0)
            return Promise.resolve(this.#describe('storage'));
        return this.#patch('storage', patch);
    }
    mount(target) {
        this.#target = target;
        return this.#run(() => this.#attach());
    }
    on(type, listener) {
        this.#events.on(type, listener);
        return hydratePlay(Promise.resolve(this), this.#events);
    }
    off(type, listener) {
        this.#events.off(type, listener);
        return hydratePlay(Promise.resolve(this), this.#events);
    }
    restart(options) {
        return this.#run(async () => {
            if (options)
                Object.assign(this.#state.options, options);
            // A target supplied to the constructor lands here, which is what makes
            // `new Sdk({ mount: el }).start()` and `new Sdk().mount(el).start()` the same
            // call — the rule the contract states for everything on the surface.
            await this.#attach();
            const opened = { ...this.#state.options };
            await this.open(opened);
            this.#emitCore('start', opened);
        });
    }
    async destroy() {
        await this.#guard(async () => {
            await this.close();
            this.#target = undefined;
            this.#attached = undefined;
            this.#emitCore('exit', undefined);
        });
    }
    /** Tell the engine where it is, once per distinct target. Reparenting is legal. */
    async #attach() {
        if (!this.#target || this.#target === this.#attached)
            return;
        this.#attached = this.#target;
        await this.mounted(this.#target);
    }
    // ---- Shared machinery ----
    /** One getter's answer: the spec, with the current value written into each entry. */
    #describe(kind) {
        const spec = this.#spec[kind];
        const state = this.#state[kind];
        const out = {};
        for (const key of Object.keys(spec)) {
            out[key] = { ...spec[key], value: state[key] };
        }
        return out;
    }
    /** Cumulative, merged flat, one level — `undefined` is a value, not "leave alone". */
    #patch(kind, patch) {
        Object.assign(this.#state[kind], patch);
        return this.#run(async () => {
            await this.patched(kind, patch ?? {});
        });
    }
    /** A step, as a link in the chain — and as an `error` event if it throws. */
    #run(step) {
        return hydratePlay(this.#guard(step), this.#events);
    }
    /**
     * The rule that errors reach a host **both ways**: the promise rejects *and*
     * `error` is emitted. Written once here rather than at every throw site.
     */
    async #guard(step) {
        try {
            await step();
            return this;
        }
        catch (thrown) {
            const error = thrown instanceof Error ? thrown : new Error(String(thrown));
            this.#emitCore('error', error);
            throw error;
        }
    }
    /**
     * The core events, emitted from here rather than by a subclass.
     *
     * The cast is the one thing TypeScript will not check here: `emit` takes a rest
     * tuple that is conditional on the detail type, and that conditional stays
     * unresolved while `P` is still a type parameter. It is sound — `EventsOf<P>`
     * always contains `CoreEvents<P>` by construction — and confining it to this one
     * method is why the three call sites above read plainly.
     */
    #emitCore(type, detail) {
        // Cast the channel, not the method: pulling `emit` out into a variable would call
        // it unbound, and it reads its listeners off `this`.
        const events = this.#events;
        events.emit(type, detail);
    }
}
/** Starting state: every `default` the spec declares, then whatever `init` overrides. */
function seed(spec, patch) {
    const state = {};
    for (const [key, property] of Object.entries(spec)) {
        if (property.default !== undefined)
            state[key] = property.default;
    }
    return Object.assign(state, patch);
}
/**
 * The factory, with everything the contract prescribes already written: the
 * cumulative init, the synchronous chain, the channel that outlives every session,
 * and one live engine per factory.
 *
 * A subclass supplies its static identity and {@link EngineSDKBase.createPlay}.
 */
export class EngineSDKBase {
    #init;
    #play;
    /**
     * Created before any engine exists and handed to every carrier downstream. That is
     * what lets a host subscribe to an error thrown while the first session opens.
     */
    events;
    constructor(init) {
        this.#init = { ...init };
        this.events = new EventEmitter(init?.on);
    }
    config(patch) {
        if (arguments.length === 0)
            return this.#pending().config();
        return this.#patch('config', patch);
    }
    options(patch) {
        if (arguments.length === 0)
            return this.#pending().options();
        return this.#patch('options', patch);
    }
    assets(patch) {
        if (arguments.length === 0)
            return this.#pending().assets();
        return this.#patch('assets', patch);
    }
    storage(patch) {
        if (arguments.length === 0)
            return this.#pending().storage();
        return this.#patch('storage', patch);
    }
    /** Recorded now, applied when the engine exists — same call as `new Sdk({ mount })`. */
    mount(target) {
        this.#init.mount = target;
        this.#play?.mount(target);
        return this;
    }
    on(type, listener) {
        this.events.on(type, listener);
        return this;
    }
    off(type, listener) {
        this.events.off(type, listener);
        return this;
    }
    /**
     * The only way in. On a live engine it reopens the session rather than building a
     * second one: a factory governs at most one engine.
     */
    start(options) {
        this.#play ??= this.createPlay(this.#init, this.events);
        return this.#play.restart(options);
    }
    /** Answers a read before there is an engine: the settings the next one will use. */
    #pending() {
        return this.#play ?? this.createPlay(this.#init, this.events);
    }
    #patch(kind, patch) {
        this.#init[kind] = { ...this.#init[kind], ...patch };
        // A live engine gets it too, so the factory does not silently describe a state
        // the engine is not in.
        if (this.#play && patch)
            this.#play[kind](patch);
        return this;
    }
}
/** Keyboard → action (`KeyboardEvent.key`). */
export const UI_KEYMAP = Object.freeze({
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Enter: 'accept',
    ' ': 'accept',
    Escape: 'back',
    Backspace: 'back',
    Tab: 'more',
    v: 'more',
    V: 'more',
    ContextMenu: 'more',
    q: 'prev',
    Q: 'prev',
    e: 'next',
    E: 'next',
    F1: 'menu',
});
/**
 * Gamepad button index (W3C "standard" mapping) → action. A = 0, B = 1, X = 2, Y = 3,
 * LB = 4, RB = 5, Select = 8, Start = 9, d-pad = 12–15. Select + Start together is
 * `menu` as well (see {@link createInput}).
 */
export const UI_PADMAP = Object.freeze({
    0: 'accept',
    1: 'back',
    2: 'more',
    3: 'more',
    4: 'prev',
    5: 'next',
    9: 'menu',
    12: 'up',
    13: 'down',
    14: 'left',
    15: 'right',
});
/** Hold-to-repeat for directions: first repeat after `delay` ms, then every `interval` ms. */
export const UI_REPEAT = Object.freeze({ delay: 380, interval: 110, axis: 0.6 });
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const isEditable = (target) => {
    const element = target;
    if (!element)
        return false;
    if (element.isContentEditable)
        return true;
    return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT';
};
/**
 * The scheme's runtime: keyboard and gamepads become {@link UiAction}s.
 *
 * Keyboard: `keydown` mapped through {@link UI_KEYMAP} (keys typed into form fields
 * are left alone). Gamepads: polled each frame through {@link UI_PADMAP} and the left
 * stick; directions repeat with {@link UI_REPEAT}; Select + Start together is `menu`
 * (and then neither fires on its own). While {@link UiInput.suspend | suspended} (in
 * game) the game gets every input except the menu combo: Select + Start and the
 * `menuKeys` (Escape, F1) still arrive, as `menu`, so the pause menu can always open.
 */
export function createInput(options = {}) {
    const target = options.target ?? globalThis;
    const capture = options.capture ?? true;
    const swallow = options.swallow ?? true;
    const keymap = options.keymap ?? UI_KEYMAP;
    const menuKeys = new Set(options.menuKeys ?? ['Escape', 'F1']);
    const padmap = options.padmap ?? UI_PADMAP;
    const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    const gamepads = options.gamepads ??
        (() => (globalThis.navigator?.getGamepads?.() ?? []));
    const schedule = options.schedule === undefined
        ? (globalThis.requestAnimationFrame?.bind(globalThis) ?? null)
        : options.schedule;
    const listeners = new Set();
    const suspendListeners = new Set();
    let suspended = false;
    let destroyed = false;
    let polling = false;
    let muted = 0;
    let aliases = {};
    const held = new Map();
    // Slots (positions in getGamepads()) whose Y was pressed as part of Select + Y.
    const comboY = new Set();
    // A snapshot: a listener that subscribes another one (a screen opening the next)
    // must not hand it the same action — a Set also visits entries added while it is
    // being iterated, so one Enter would open a screen and activate its focused item.
    // A listener removed by an earlier one in the same dispatch is skipped.
    const fire = (action, detail) => {
        for (const listener of [...listeners]) {
            if (listeners.has(listener))
                listener(action, detail);
        }
    };
    const onKey = (event) => {
        if (destroyed || muted > 0)
            return;
        const key = event;
        if (suspended) {
            if (!menuKeys.has(key.key) || key.repeat)
                return;
            key.preventDefault();
            key.stopPropagation();
            fire('menu', { source: 'keyboard', repeat: false });
            return;
        }
        if (isEditable(key.target) && key.key !== 'Escape')
            return;
        const action = keymap[key.key] ?? (key.code ? aliases[key.code] : undefined);
        if (!action)
            return;
        if (swallow) {
            key.preventDefault();
            key.stopPropagation();
        }
        fire(action, { source: 'keyboard', repeat: key.repeat === true });
    };
    const pressed = (pad, slot) => {
        const actions = new Set();
        if (pad.buttons[3]?.pressed !== true)
            comboY.delete(slot);
        const select = pad.buttons[8]?.pressed === true;
        const start = pad.buttons[9]?.pressed === true;
        if (select && start)
            actions.add('menu');
        pad.buttons.forEach((button, index) => {
            if (!button.pressed)
                return;
            if ((index === 8 || index === 9) && select && start)
                return;
            // Select + Y is the fullscreen combo (createFullscreenToggle): Y stays quiet until
            // it is let go, even if Select is let go first.
            if (index === 3 && (select || comboY.has(slot))) {
                comboY.add(slot);
                return;
            }
            const action = padmap[index];
            if (action)
                actions.add(action);
        });
        const [x = 0, y = 0] = pad.axes;
        if (x < -UI_REPEAT.axis)
            actions.add('left');
        if (x > UI_REPEAT.axis)
            actions.add('right');
        if (y < -UI_REPEAT.axis)
            actions.add('up');
        if (y > UI_REPEAT.axis)
            actions.add('down');
        return actions;
    };
    const poll = () => {
        if (destroyed)
            return;
        const t = now();
        const active = new Set();
        gamepads().forEach((pad, slot) => {
            if (pad)
                for (const action of pressed(pad, slot))
                    active.add(action);
        });
        for (const action of active) {
            const state = held.get(action);
            if (!state) {
                held.set(action, { since: t, last: t });
                // In game only the Select + Start combo gets through (plain Start is the game's).
                const combo = action === 'menu' && gamepads().some((p) => p?.buttons[8]?.pressed && p.buttons[9]?.pressed);
                if (muted > 0)
                    continue;
                if (!suspended || combo)
                    fire(action, { source: 'gamepad', repeat: false });
            }
            else if (DIRECTIONS.has(action) &&
                t - state.since >= UI_REPEAT.delay &&
                t - state.last >= UI_REPEAT.interval) {
                state.last = t;
                if (!suspended && muted === 0)
                    fire(action, { source: 'gamepad', repeat: true });
            }
        }
        for (const action of [...held.keys()])
            if (!active.has(action))
                held.delete(action);
    };
    const loop = () => {
        if (destroyed || !schedule)
            return;
        poll();
        schedule(loop);
    };
    const startPolling = () => {
        if (polling || !schedule)
            return;
        polling = true;
        schedule(loop);
    };
    const setSuspended = (value) => {
        if (destroyed || suspended === value)
            return;
        suspended = value;
        for (const listener of [...suspendListeners]) {
            if (suspendListeners.has(listener))
                listener(value);
        }
    };
    target.addEventListener('keydown', onKey, { capture });
    target.addEventListener('gamepadconnected', startPolling);
    if (gamepads().some(Boolean))
        startPolling();
    return {
        on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        suspend() {
            setSuspended(true);
        },
        resume() {
            setSuspended(false);
        },
        get suspended() {
            return suspended;
        },
        onSuspend(listener) {
            suspendListeners.add(listener);
            return () => suspendListeners.delete(listener);
        },
        trigger(action, detail = { source: 'touch', repeat: false }) {
            if (destroyed || muted > 0)
                return;
            if (suspended && action !== 'menu')
                return;
            fire(action, detail);
        },
        poll,
        mute() {
            muted += 1;
            let undone = false;
            return () => {
                if (undone)
                    return;
                undone = true;
                muted -= 1;
            };
        },
        setKeyAliases(next) {
            aliases = { ...next };
        },
        destroy() {
            destroyed = true;
            listeners.clear();
            suspendListeners.clear();
            held.clear();
            target.removeEventListener('keydown', onKey, { capture });
            target.removeEventListener('gamepadconnected', startPolling);
        },
    };
}
/**
 * Spatial navigation: the candidate a direction leads to from `from`, or null.
 *
 * Only candidates whose centre lies ahead in that direction count; among them the
 * nearest wins, with sideways distance weighted double so "down" prefers the item
 * straight below over a closer one off to the side.
 */
export function nextFocus(from, candidates, direction) {
    const centre = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const origin = centre(from);
    let best = null;
    let bestScore = Infinity;
    for (const candidate of candidates) {
        if (candidate === from)
            continue;
        const c = centre(candidate);
        const dx = c.x - origin.x;
        const dy = c.y - origin.y;
        const ahead = direction === 'up' ? -dy : direction === 'down' ? dy : direction === 'left' ? -dx : dx;
        if (ahead <= 0.5)
            continue;
        const side = direction === 'up' || direction === 'down' ? Math.abs(dx) : Math.abs(dy);
        const score = ahead + side * 2;
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}
/**
 * The look every menu shares, as CSS custom properties: the focus ring, radii, type
 * faces, colours and spacing. Apps read them with `var(--wg-…)`; {@link uiTokensCss}
 * writes them into a stylesheet.
 */
export const UI_TOKENS = Object.freeze({
    '--wg-bg': '#07080c',
    '--wg-surface': 'rgb(18 20 28 / 0.78)',
    '--wg-line': 'rgb(255 255 255 / 0.12)',
    '--wg-text': '#f4f6fb',
    '--wg-muted': '#8e97a9',
    '--wg-ok': '#4ade80',
    '--wg-danger': '#f87171',
    '--wg-focus': '#ffffff',
    '--wg-focus-ring': '0 0 0 3px #ffffff',
    '--wg-radius': '22px',
    '--wg-radius-small': '12px',
    '--wg-gap': '16px',
    '--wg-font-display': "'Unbounded Variable', 'Unbounded', system-ui, sans-serif",
    '--wg-font-ui': "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    '--wg-ease': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    '--wg-safe-top': 'env(safe-area-inset-top, 0px)',
    '--wg-safe-bottom': 'env(safe-area-inset-bottom, 0px)',
});
/** `UI_TOKENS` as a CSS rule, e.g. for a `<style>` an app injects. */
export function uiTokensCss(selector = ':root') {
    const body = Object.entries(UI_TOKENS)
        .map(([name, value]) => `  ${name}: ${value};`)
        .join('\n');
    return `${selector} {\n${body}\n}\n`;
}
/** Standard-mapping indices the pad uses. */
const PAD = Object.freeze({ up: 12, down: 13, left: 14, right: 15 });
const PAD_BUTTONS = 17;
const PAD_AXES = 4;
/**
 * One layout per system. Each label presses the standard button that the system's
 * emulator binds to that console button by default, so no emulator is reconfigured:
 *
 * - Mega Drive (BlastEm `default.cfg`): A=0, B=1, C=5 (right shoulder), X=2, Y=3,
 *   Z=4 (left shoulder), Mode=8, Start=9. Six buttons: the launcher plugs 6-button
 *   pads, and a 3-button game ignores X Y Z.
 * - Neo Geo (FBNeo: "fire N" is joystick button N-1): A=0, B=1, C=2, D=3 — drawn
 *   as the Neo Geo CD pad's diamond (A bottom, B right, C left, D top), which is
 *   where those indices sit on a standard pad.
 * - SNES (snes9x, by position): B=0, A=1, Y=2, X=3, L=4, R=5.
 * - GBA / GBC / GB (mGBA): A=0, B=1, L=4, R=5.
 *
 * Everywhere Select = 8 and Start = 9.
 */
export const TOUCH_LAYOUTS = Object.freeze({
    megadrive: {
        system: 'megadrive',
        title: 'Mega Drive',
        aspect: 4 / 3,
        faces: [
            { label: 'X', index: 2, x: 0.18, y: 0.32, size: 0.25 },
            { label: 'Y', index: 3, x: 0.5, y: 0.26, size: 0.25 },
            { label: 'Z', index: 4, x: 0.82, y: 0.2, size: 0.25 },
            { label: 'A', index: 0, x: 0.18, y: 0.7, size: 0.3 },
            { label: 'B', index: 1, x: 0.5, y: 0.64, size: 0.3 },
            { label: 'C', index: 5, x: 0.82, y: 0.58, size: 0.3 },
        ],
        start: { label: 'Start', index: 9 },
    },
    neogeo: {
        system: 'neogeo',
        title: 'Neo Geo',
        aspect: 4 / 3,
        faces: [
            // The Neo Geo CD pad's diamond: D top, C left, B right, A bottom.
            { label: 'D', index: 3, x: 0.5, y: 0.18, size: 0.32, color: '#3b82f6' },
            { label: 'C', index: 2, x: 0.18, y: 0.5, size: 0.32, color: '#22c55e' },
            { label: 'B', index: 1, x: 0.82, y: 0.5, size: 0.32, color: '#facc15' },
            { label: 'A', index: 0, x: 0.5, y: 0.82, size: 0.32, color: '#ef4444' },
        ],
        select: { label: 'Select', index: 8 },
        start: { label: 'Start', index: 9 },
    },
    snes: {
        system: 'snes',
        title: 'Super Nintendo',
        aspect: 4 / 3,
        faces: [
            { label: 'X', index: 3, x: 0.5, y: 0.18, size: 0.32, color: '#3b82f6' },
            { label: 'Y', index: 2, x: 0.18, y: 0.5, size: 0.32, color: '#22c55e' },
            { label: 'A', index: 1, x: 0.82, y: 0.5, size: 0.32, color: '#ef4444' },
            { label: 'B', index: 0, x: 0.5, y: 0.82, size: 0.32, color: '#facc15' },
        ],
        l: { label: 'L', index: 4 },
        r: { label: 'R', index: 5 },
        select: { label: 'Select', index: 8 },
        start: { label: 'Start', index: 9 },
    },
    gba: {
        system: 'gba',
        title: 'Game Boy Advance',
        aspect: 3 / 2,
        faces: [
            { label: 'B', index: 1, x: 0.28, y: 0.64, size: 0.38 },
            { label: 'A', index: 0, x: 0.72, y: 0.4, size: 0.38 },
        ],
        l: { label: 'L', index: 4 },
        r: { label: 'R', index: 5 },
        select: { label: 'Select', index: 8 },
        start: { label: 'Start', index: 9 },
    },
    gbc: {
        system: 'gbc',
        title: 'Game Boy Color',
        aspect: 10 / 9,
        faces: [
            { label: 'B', index: 1, x: 0.28, y: 0.64, size: 0.38 },
            { label: 'A', index: 0, x: 0.72, y: 0.4, size: 0.38 },
        ],
        select: { label: 'Select', index: 8 },
        start: { label: 'Start', index: 9 },
    },
    gb: {
        system: 'gb',
        title: 'Game Boy',
        aspect: 10 / 9,
        faces: [
            { label: 'B', index: 1, x: 0.28, y: 0.64, size: 0.38 },
            { label: 'A', index: 0, x: 0.72, y: 0.4, size: 0.38 },
        ],
        select: { label: 'Select', index: 8 },
        start: { label: 'Start', index: 9 },
    },
});
/** Smallest touch target (UX.md rule 8). */
const TOUCH_MIN = 48;
/** The d-pad is drawn at this fraction of its slot, centred; the buttons fill theirs. */
const DPAD_SCALE = 0.8;
/** A square of `fraction` of `slot`'s side, centred in it. */
const shrink = (slot, fraction) => {
    const side = Math.round(slot.width * fraction);
    return rect(slot.x + (slot.width - side) / 2, slot.y + (slot.height - side) / 2, side, side);
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const rect = (x, y, width, height) => ({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
});
/**
 * Lays a pad out. **Portrait**: the pad takes the bottom half — shoulders and the
 * pause button along its top, the d-pad left, the buttons right, Select / Start
 * along its bottom — and the game gets the top half. **Landscape**: the game is
 * centred and the controls sit on its sides — L and the d-pad and Select on the
 * left; pause, R, the buttons and Start on the right. When sides wide enough would
 * shrink the game below `minGameScale` of the screen's height (a 4:3 tablet), the
 * game keeps the whole screen and the controls overlay its edges.
 */
export function placeTouchPad(layout, viewport, options = {}) {
    const scale = clamp(options.scale ?? 1, 0.75, 1.4);
    const minGameScale = options.minGameScale ?? 0.7;
    const { width: W, height: H } = viewport;
    const safe = viewport.safe ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const faces = (cluster) => layout.faces.map((face) => ({
        label: face.label,
        index: face.index,
        cx: Math.round(cluster.x + face.x * cluster.width),
        cy: Math.round(cluster.y + face.y * cluster.height),
        r: Math.round((face.size * cluster.width) / 2),
        ...(face.color ? { color: face.color } : {}),
    }));
    const key = (id, spec, at) => (spec ? [{ id, label: spec.label, index: spec.index, rect: at }] : []);
    if (H >= W) {
        // ---- portrait: the bottom half
        const half = Math.round(H / 2);
        const zone = rect(0, half, W, H - half);
        const inner = rect(safe.left, half, W - safe.left - safe.right, H - half - safe.bottom);
        const m = Math.round(clamp(inner.width * 0.04, 10, 24));
        const rowH = TOUCH_MIN;
        const top = inner.y + m;
        const bottom = inner.y + inner.height - m - rowH;
        const middleTop = top + rowH + Math.round(m / 2);
        const middleH = bottom - Math.round(m / 2) - middleTop;
        // The d-pad and the cluster are squares of the same side: as big as the half
        // allows, capped for tablets, then scaled — never beyond the room there is.
        const side = Math.round(Math.min(middleH, inner.width * 0.47, Math.min(middleH, inner.width * 0.44, 240) * scale));
        const dpad = shrink(rect(inner.x + m, middleTop + (middleH - side) / 2, side, side), DPAD_SCALE);
        const cluster = rect(inner.x + inner.width - m - side, middleTop + (middleH - side) / 2, side, side);
        const shoulderW = clamp(inner.width * 0.28, 88, 160);
        const pillW = clamp(inner.width * 0.2, 72, 112);
        const pauseW = 56;
        const centre = inner.x + inner.width / 2;
        return {
            orientation: 'portrait',
            overlay: false,
            gameArea: rect(safe.left, safe.top, W - safe.left - safe.right, half - safe.top),
            zones: [zone],
            dpad,
            cluster,
            faces: faces(cluster),
            keys: [
                ...key('l', layout.l, rect(inner.x + m, top, shoulderW, rowH)),
                ...key('r', layout.r, rect(inner.x + inner.width - m - shoulderW, top, shoulderW, rowH)),
                { id: 'pause', label: 'Pause', index: null, rect: rect(centre - pauseW / 2, top, pauseW, rowH) },
                ...key('select', layout.select, rect(centre - 8 - pillW, bottom, pillW, rowH)),
                ...key('start', layout.start, rect(layout.select ? centre + 8 : centre - pillW / 2, bottom, pillW, rowH)),
            ],
        };
    }
    // ---- landscape: the sides
    const fullH = H - safe.top - safe.bottom;
    const usableW = W - safe.left - safe.right;
    const m = Math.round(clamp(fullH * 0.035, 8, 20));
    const rowH = TOUCH_MIN;
    const control = Math.round(clamp(Math.min(fullH * 0.42, 200), 112, 200) * scale);
    const sideNeeded = control + 2 * m;
    const gameWFull = Math.min(usableW, fullH * layout.aspect);
    let gameW = gameWFull;
    let overlay = false;
    if ((usableW - gameWFull) / 2 < sideNeeded) {
        const shrunkW = usableW - 2 * sideNeeded;
        const shrunkScale = shrunkW / layout.aspect / fullH;
        if (shrunkScale >= minGameScale)
            gameW = shrunkW;
        else
            overlay = true;
    }
    const sideW = overlay ? sideNeeded : (usableW - gameW) / 2;
    const gameH = overlay ? fullH : Math.min(fullH, gameW / layout.aspect);
    const gameArea = overlay
        ? rect(safe.left, safe.top, usableW, fullH)
        : rect(safe.left + sideW, safe.top + (fullH - gameH) / 2, gameW, gameH);
    const leftX = safe.left;
    const rightX = W - safe.right - sideW;
    const top = safe.top + m;
    const bottom = H - safe.bottom - m - rowH;
    // The top row always exists — it holds the pause button, and the shoulders when
    // the console has them.
    const middleTop = top + rowH + m;
    const middleH = bottom - m - middleTop;
    const side = Math.round(Math.min(control, middleH, sideW - 2 * m));
    const dpad = shrink(rect(leftX + (sideW - side) / 2, middleTop + (middleH - side) / 2, side, side), DPAD_SCALE);
    const cluster = rect(rightX + (sideW - side) / 2, middleTop + (middleH - side) / 2, side, side);
    const pauseW = 48;
    const shoulderW = clamp(sideW - 2 * m - (pauseW + m), 64, 140);
    const pillW = clamp(sideW * 0.5, 72, 112);
    return {
        orientation: 'landscape',
        overlay,
        gameArea,
        zones: [rect(0, 0, leftX + sideW, H), rect(rightX, 0, W - rightX, H)],
        dpad,
        cluster,
        faces: faces(cluster),
        keys: [
            ...key('l', layout.l, rect(leftX + m, top, shoulderW, rowH)),
            ...key('r', layout.r, rect(rightX + m, top, shoulderW, rowH)),
            { id: 'pause', label: 'Pause', index: null, rect: rect(rightX + sideW - m - pauseW, top, pauseW, rowH) },
            ...key('select', layout.select, rect(leftX + (sideW - pillW) / 2, bottom, pillW, rowH)),
            ...key('start', layout.start, rect(rightX + (sideW - pillW) / 2, bottom, pillW, rowH)),
        ],
    };
}
/** The pad's `Gamepad.id`. */
export const TOUCH_PAD_ID = 'wasm-gaming touch pad (STANDARD GAMEPAD)';
/** A finger landing this close to a key (px) still takes it. */
const KEY_SLOP = 8;
/** Standard d-pad indices for a point, from its angle around the d-pad's centre. */
export function touchDpadAt(dpad, x, y) {
    const dx = x - (dpad.x + dpad.width / 2);
    const dy = y - (dpad.y + dpad.height / 2);
    // A dead zone in the middle: resting the thumb on the hub presses nothing.
    if (Math.hypot(dx, dy) < dpad.width * 0.11)
        return [];
    // Eight sectors of 45°, the cardinal ones centred on their axis.
    const sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
    return [
        [PAD.right],
        [PAD.right, PAD.down],
        [PAD.down],
        [PAD.down, PAD.left],
        [PAD.left],
        [PAD.left, PAD.up],
        [PAD.up],
        [PAD.up, PAD.right],
    ][sector];
}
/**
 * Face buttons under a point. Each takes a circle a little larger than it is drawn
 * (never under the 48 px minimum), so the gap between two neighbours presses both —
 * the arcade "roll" — and a thumb slides from one to the next without lifting.
 */
export function touchFacesAt(placement, x, y) {
    const out = [];
    for (const face of placement.faces) {
        const reach = Math.max(face.r * 1.18, TOUCH_MIN / 2);
        if (Math.hypot(x - face.cx, y - face.cy) <= reach)
            out.push(face.index);
    }
    return out;
}
const inside = (r, x, y, slop = 0) => x >= r.x - slop && x <= r.x + r.width + slop && y >= r.y - slop && y <= r.y + r.height + slop;
const grow = (r, by) => ({
    x: r.x - r.width * by,
    y: r.y - r.height * by,
    width: r.width * (1 + 2 * by),
    height: r.height * (1 + 2 * by),
});
export function createTouchPadCore(options = {}) {
    const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    const minHold = options.minHold ?? 50;
    const gamepad = {
        id: TOUCH_PAD_ID,
        index: 0,
        connected: false,
        mapping: 'standard',
        timestamp: 0,
        buttons: Array.from({ length: PAD_BUTTONS }, () => ({ pressed: false, touched: false, value: 0 })),
        axes: Array.from({ length: PAD_AXES }, () => 0),
        vibrationActuator: null,
    };
    let placement = null;
    const fingers = new Map();
    /** When each pressed index went down. */
    const since = new Map();
    /** Latched: released early, held until then. */
    const latched = new Map();
    const changeListeners = new Set();
    const pauseListeners = new Set();
    const live = () => {
        const set = new Set();
        for (const finger of fingers.values())
            for (const index of finger.indices)
                set.add(index);
        return set;
    };
    const sync = () => {
        const t = now();
        const held = live();
        for (const [index, until] of [...latched])
            if (until <= t || held.has(index))
                latched.delete(index);
        for (const index of [...since.keys()]) {
            if (held.has(index))
                continue;
            const start = since.get(index) ?? t;
            if (t < start + minHold)
                latched.set(index, start + minHold);
            since.delete(index);
        }
        const effective = new Set([...held, ...latched.keys()]);
        const wentDown = [];
        let changed = false;
        gamepad.buttons.forEach((button, index) => {
            const on = effective.has(index);
            if (on === button.pressed)
                return;
            changed = true;
            button.pressed = on;
            button.touched = on;
            button.value = on ? 1 : 0;
            if (on)
                wentDown.push(index);
        });
        for (const index of held)
            if (!since.has(index))
                since.set(index, t);
        if (!changed)
            return;
        gamepad.timestamp = t;
        for (const listener of [...changeListeners])
            listener(wentDown);
    };
    const indicesFor = (control, x, y) => {
        if (!placement)
            return [];
        if (control === 'dpad')
            return touchDpadAt(placement.dpad, x, y);
        if (control === 'cluster')
            return touchFacesAt(placement, x, y);
        const key = placement.keys.find((k) => k.id === control);
        if (!key || key.index === null)
            return [];
        return inside(key.rect, x, y, KEY_SLOP) ? [key.index] : [];
    };
    const controlAt = (x, y) => {
        if (!placement)
            return null;
        for (const key of placement.keys)
            if (inside(key.rect, x, y, KEY_SLOP))
                return key.id;
        const { dpad, cluster } = placement;
        const nearDpad = inside(grow(dpad, 0.2), x, y);
        const nearCluster = inside(grow(cluster, 0.12), x, y) || touchFacesAt(placement, x, y).length > 0;
        if (nearDpad && nearCluster) {
            // On a narrow phone the two margins meet: the nearer one, by its own size.
            const reach = (r) => Math.hypot(x - (r.x + r.width / 2), y - (r.y + r.height / 2)) / (r.width / 2);
            return reach(dpad) <= reach(cluster) ? 'dpad' : 'cluster';
        }
        if (nearDpad)
            return 'dpad';
        if (nearCluster)
            return 'cluster';
        return null;
    };
    return {
        gamepad,
        get placement() {
            return placement;
        },
        place(next) {
            placement = next;
            // A new geometry is a clean slate: nothing latched survives it.
            fingers.clear();
            latched.clear();
            since.clear();
            sync();
        },
        down(pointerId, x, y) {
            const control = controlAt(x, y);
            if (!control)
                return null;
            fingers.set(pointerId, { control, indices: indicesFor(control, x, y) });
            if (control === 'pause')
                for (const listener of [...pauseListeners])
                    listener();
            sync();
            return control;
        },
        move(pointerId, x, y) {
            const finger = fingers.get(pointerId);
            if (!finger || finger.control === 'pause')
                return;
            finger.indices = indicesFor(finger.control, x, y);
            sync();
        },
        up(pointerId) {
            if (!fingers.delete(pointerId))
                return;
            sync();
        },
        releaseAll() {
            fingers.clear();
            latched.clear();
            since.clear();
            sync();
        },
        pressed() {
            const set = new Set();
            gamepad.buttons.forEach((button, index) => button.pressed && set.add(index));
            return set;
        },
        get deadline() {
            return latched.size ? Math.min(...latched.values()) : null;
        },
        tick: sync,
        onChange(listener) {
            changeListeners.add(listener);
            return () => changeListeners.delete(listener);
        },
        onPause(listener) {
            pauseListeners.add(listener);
            return () => pauseListeners.delete(listener);
        },
    };
}
/**
 * Puts the pad in `navigator.getGamepads()`, at the first index no physical pad
 * holds (index 0 when there is none — snes9x and mGBA read only that one), and
 * announces it with `gamepadconnected`. Install it **before** the engine starts, so
 * SDL's start-up enumeration finds it. If a physical pad later takes its index, the
 * pad moves to the next free one (disconnected, then connected again).
 *
 * The events are plain `Event`s carrying a `gamepad` property — a `GamepadEvent`
 * cannot be built around an object that is not a real `Gamepad` — which is the shape
 * Emscripten's handler and `createInput()` read. Returns `release()`, which restores
 * `getGamepads` and announces the pad gone.
 */
export function exposeAsGamepad(source, options = {}) {
    const pad = 'gamepad' in source ? source.gamepad : source;
    const nav = (options.navigator ?? globalThis.navigator);
    const target = options.target ?? globalThis;
    if (!nav)
        return () => { };
    const own = Object.getOwnPropertyDescriptor(nav, 'getGamepads');
    const original = nav.getGamepads ? nav.getGamepads.bind(nav) : () => [];
    const announce = (type) => {
        const event = new Event(type);
        Object.defineProperty(event, 'gamepad', { value: pad, enumerable: true });
        target.dispatchEvent(event);
    };
    const physical = () => Array.from(original() ?? [], (entry) => (entry === pad ? null : entry ?? null));
    const freeIndex = (pads) => {
        let index = 0;
        while (pads[index])
            index++;
        return index;
    };
    let moving = false;
    const wrapped = () => {
        const pads = physical();
        if (pads[pad.index] && !moving) {
            // A physical pad took our slot. Move, announcing outside the caller's poll.
            moving = true;
            queueMicrotask(() => {
                announce('gamepaddisconnected');
                pad.index = freeIndex(physical());
                moving = false;
                announce('gamepadconnected');
            });
        }
        const out = pads.slice();
        if (!moving) {
            while (out.length <= pad.index)
                out.push(null);
            out[pad.index] = pad;
        }
        return out;
    };
    pad.index = freeIndex(physical());
    pad.connected = true;
    Object.defineProperty(nav, 'getGamepads', { value: wrapped, configurable: true, writable: true });
    announce('gamepadconnected');
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        if (own)
            Object.defineProperty(nav, 'getGamepads', own);
        else
            delete nav.getGamepads;
        pad.connected = false;
        announce('gamepaddisconnected');
    };
}
const TOUCH_STYLE_ID = 'wg-touch-pad-style';
const TOUCH_CSS = `
.wg-tp { position: fixed; inset: 0; z-index: 9000; pointer-events: none; display: none;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  font-family: var(--wg-font-ui, system-ui, sans-serif); color: #fff; }
.wg-tp.is-visible { display: block; }
.wg-tp-zone { position: absolute; pointer-events: auto; touch-action: none; overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent; }
.wg-tp-art { position: absolute; inset: 0; opacity: var(--wg-tp-opacity, 0.6); }
.wg-tp.is-overlay .wg-tp-art { opacity: calc(var(--wg-tp-opacity, 0.6) * 0.75); }
.wg-tp-face, .wg-tp-key, .wg-tp-arm, .wg-tp-hub { position: absolute; box-sizing: border-box;
  background: rgb(255 255 255 / 0.12); border: 1.5px solid rgb(255 255 255 / 0.55);
  display: grid; place-items: center; font-weight: 700; letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.6); }
.wg-tp-face { border-radius: 50%; --c: #ffffff; border-color: color-mix(in srgb, var(--c) 70%, white);
  background: color-mix(in srgb, var(--c) 22%, transparent); }
.wg-tp-key { border-radius: 999px; font-size: 13px; font-weight: 600; }
.wg-tp-key.is-shoulder { border-radius: 14px; font-size: 16px; font-weight: 700; }
.wg-tp-key.is-pause::before, .wg-tp-key.is-pause::after { content: ''; position: absolute; top: 34%; bottom: 34%;
  width: 4px; border-radius: 2px; background: currentColor; }
.wg-tp-key.is-pause::before { left: calc(50% - 7px); }
.wg-tp-key.is-pause::after { right: calc(50% - 7px); }
.wg-tp-arm { border-radius: 6px; }
.wg-tp-hub { border-radius: 4px; border-width: 0; background: rgb(255 255 255 / 0.12); }
.wg-tp .is-on { background: rgb(255 255 255 / 0.55); transform: scale(0.96); color: #0b0d12; text-shadow: none; }
.wg-tp-face.is-on { background: color-mix(in srgb, var(--c) 70%, white); }
`;
/**
 * The touch pad: draws {@link TOUCH_LAYOUTS | a console's pad} over `target`'s
 * viewport and turns fingers into a {@link VirtualGamepad}. Pair it with
 * {@link exposeAsGamepad} (the engines) and {@link connectTouchPad} (the shared
 * input). Pointer Events, any number of fingers; a finger keeps the control it
 * landed on — it slides around the d-pad, or across the buttons — and every finger
 * is let go on blur, on a hidden page, and when the pad hides: never a stuck button.
 */
export function createTouchPad(target, options) {
    const doc = target.ownerDocument;
    const win = doc.defaultView ?? globalThis;
    const resolve = (layout) => typeof layout === 'string' ? TOUCH_LAYOUTS[layout] : layout;
    let layout = resolve(options.layout);
    const haptics = options.haptics ?? true;
    const mode = options.mode ?? 'auto';
    const placeOptions = {
        ...(options.scale !== undefined ? { scale: options.scale } : {}),
        ...(options.minGameScale !== undefined ? { minGameScale: options.minGameScale } : {}),
    };
    const core = createTouchPadCore(options.minHold !== undefined ? { minHold: options.minHold } : {});
    if (!doc.getElementById(TOUCH_STYLE_ID)) {
        const style = doc.createElement('style');
        style.id = TOUCH_STYLE_ID;
        style.textContent = TOUCH_CSS;
        doc.head.appendChild(style);
    }
    const root = doc.createElement('div');
    root.className = 'wg-tp';
    root.style.setProperty('--wg-tp-opacity', String(clamp(options.opacity ?? 0.6, 0.2, 1)));
    const art = doc.createElement('div');
    art.className = 'wg-tp-art';
    // Reads `env(safe-area-inset-*)` back as pixels.
    const probe = doc.createElement('div');
    probe.style.cssText =
        'position:fixed;inset:0;visibility:hidden;pointer-events:none;' +
            'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    root.append(art, probe);
    target.appendChild(root);
    let shown = options.shown ?? false;
    let active = mode === 'always' || (win.matchMedia?.('(pointer: coarse)').matches ?? false);
    let destroyed = false;
    let zones = [];
    let arms = null;
    const parts = new Map();
    const layoutListeners = new Set();
    let timer = null;
    const visible = () => shown && active && !destroyed;
    const viewport = () => {
        const css = win.getComputedStyle(probe);
        const px = (value) => Number.parseFloat(value) || 0;
        return {
            width: win.innerWidth,
            height: win.innerHeight,
            safe: { top: px(css.paddingTop), right: px(css.paddingRight), bottom: px(css.paddingBottom), left: px(css.paddingLeft) },
        };
    };
    const gameArea = () => core.placement?.gameArea ?? { x: 0, y: 0, width: win.innerWidth, height: win.innerHeight };
    const box = (el, r) => {
        el.style.left = `${r.x}px`;
        el.style.top = `${r.y}px`;
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
    };
    const register = (index, el) => {
        parts.set(index, [...(parts.get(index) ?? []), el]);
    };
    const paint = () => {
        const on = core.pressed();
        for (const [index, els] of parts)
            for (const el of els)
                el.classList.toggle('is-on', on.has(index));
        if (arms) {
            arms.up.classList.toggle('is-on', on.has(PAD.up));
            arms.down.classList.toggle('is-on', on.has(PAD.down));
            arms.left.classList.toggle('is-on', on.has(PAD.left));
            arms.right.classList.toggle('is-on', on.has(PAD.right));
        }
    };
    const build = (placement) => {
        for (const zone of zones)
            zone.remove();
        art.replaceChildren();
        parts.clear();
        root.classList.toggle('is-overlay', placement.overlay);
        // The d-pad: a cross of four arms around a hub.
        const d = placement.dpad;
        const third = d.width / 3;
        const arm = (dir, x, y) => {
            const el = doc.createElement('div');
            el.className = 'wg-tp-arm';
            box(el, rect(d.x + x * third, d.y + y * third, third, third));
            art.appendChild(el);
            return el;
        };
        arms = { up: arm('up', 1, 0), left: arm('left', 0, 1), right: arm('right', 2, 1), down: arm('down', 1, 2) };
        const hub = doc.createElement('div');
        hub.className = 'wg-tp-hub';
        box(hub, rect(d.x + third, d.y + third, third, third));
        art.appendChild(hub);
        for (const face of placement.faces) {
            const el = doc.createElement('div');
            el.className = 'wg-tp-face';
            el.textContent = face.label;
            el.style.fontSize = `${Math.round(clamp(face.r * 0.7, 14, 28))}px`;
            if (face.color)
                el.style.setProperty('--c', face.color);
            box(el, rect(face.cx - face.r, face.cy - face.r, face.r * 2, face.r * 2));
            art.appendChild(el);
            register(face.index, el);
        }
        for (const key of placement.keys) {
            const el = doc.createElement('div');
            el.className = `wg-tp-key is-${key.id}${key.id === 'l' || key.id === 'r' ? ' is-shoulder' : ''}`;
            if (key.id === 'pause')
                el.setAttribute('aria-label', key.label);
            else
                el.textContent = key.label;
            box(el, key.rect);
            art.appendChild(el);
            if (key.index !== null)
                register(key.index, el);
        }
        zones = placement.zones.map((r) => {
            const zone = doc.createElement('div');
            zone.className = 'wg-tp-zone';
            box(zone, r);
            zone.addEventListener('pointerdown', onDown);
            // Cancelling the touch itself is what stops the browser's click after it.
            zone.addEventListener('touchstart', cancelTouch, { passive: false });
            zone.addEventListener('touchmove', cancelTouch, { passive: false });
            zone.addEventListener('touchend', cancelTouch, { passive: false });
            zone.addEventListener('pointermove', onMove);
            zone.addEventListener('pointerup', onUp);
            zone.addEventListener('pointercancel', onUp);
            zone.addEventListener('lostpointercapture', onUp);
            root.appendChild(zone);
            return zone;
        });
    };
    const relayout = () => {
        if (destroyed)
            return;
        root.classList.toggle('is-visible', visible());
        if (visible()) {
            const placement = placeTouchPad(layout, viewport(), placeOptions);
            core.place(placement);
            build(placement);
        }
        else {
            core.place(null);
        }
        paint();
        const area = gameArea();
        for (const listener of [...layoutListeners])
            listener(area, core.placement);
    };
    const schedule = () => {
        if (timer)
            clearTimeout(timer);
        timer = null;
        const due = core.deadline;
        if (due === null)
            return;
        timer = setTimeout(() => {
            timer = null;
            core.tick();
            paint();
            schedule();
        }, Math.max(0, due - (win.performance?.now() ?? Date.now())));
    };
    /**
     * Where and when the pad last handled a finger. A touch that opens a menu (the pause
     * button) hides the pad, and the click the browser sends after the lift would land on
     * whatever the menu put under the finger — and pick it. Clicks right there, right
     * then, are the pad's and are dropped.
     */
    let lastTouch = { at: -Infinity, x: 0, y: 0 };
    const now = () => win.performance?.now() ?? Date.now();
    const remember = (event) => {
        lastTouch = { at: now(), x: event.clientX, y: event.clientY };
    };
    const cancelTouch = (event) => {
        if (event.cancelable)
            event.preventDefault();
    };
    const dropGhostClick = (event) => {
        if (now() - lastTouch.at > 400)
            return;
        if (Math.hypot(event.clientX - lastTouch.x, event.clientY - lastTouch.y) > TOUCH_MIN)
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    function onDown(event) {
        event.preventDefault();
        remember(event);
        const zone = event.currentTarget;
        if (core.down(event.pointerId, event.clientX, event.clientY) === null)
            return;
        try {
            zone.setPointerCapture(event.pointerId);
        }
        catch {
            /* a synthetic pointer cannot be captured; it still works, minus sliding off the zone */
        }
        paint();
        schedule();
    }
    function onMove(event) {
        core.move(event.pointerId, event.clientX, event.clientY);
        paint();
    }
    function onUp(event) {
        remember(event);
        core.up(event.pointerId);
        paint();
        schedule();
    }
    const releaseAll = () => {
        core.releaseAll();
        paint();
    };
    const onVisibility = () => {
        if (doc.visibilityState === 'hidden')
            releaseAll();
    };
    const onAnyPointer = (event) => {
        if (mode === 'auto' && event.pointerType === 'touch' && !active) {
            active = true;
            relayout();
        }
    };
    const onAnyKey = (event) => {
        // Only a real keyboard hides the pad: an SDK that drives its engine with synthetic key
        // events (jgenesis reads the keyboard only) must not hide the pad it is listening to.
        if (event?.type === 'keydown' && !event.isTrusted)
            return;
        if (mode === 'auto' && active) {
            active = false;
            relayout();
        }
    };
    const onPadConnected = (event) => {
        if (event.gamepad !== core.gamepad)
            onAnyKey();
    };
    let frame = 0;
    const onResize = () => {
        if (frame)
            return;
        frame = win.requestAnimationFrame(() => {
            frame = 0;
            if (visible())
                relayout();
        });
    };
    const preventMenu = (event) => event.preventDefault();
    core.onChange((wentDown) => {
        if (haptics && wentDown.length)
            win.navigator.vibrate?.(8);
    });
    win.addEventListener('blur', releaseAll);
    win.addEventListener('click', dropGhostClick, { capture: true });
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pointerdown', onAnyPointer, { capture: true, passive: true });
    win.addEventListener('keydown', onAnyKey, { capture: true, passive: true });
    win.addEventListener('gamepadconnected', onPadConnected);
    win.addEventListener('resize', onResize);
    win.addEventListener('orientationchange', onResize);
    root.addEventListener('contextmenu', preventMenu);
    relayout();
    return {
        gamepad: core.gamepad,
        get layout() {
            return layout;
        },
        setLayout(next) {
            layout = resolve(next);
            relayout();
        },
        show() {
            if (shown)
                return;
            shown = true;
            relayout();
        },
        hide() {
            if (!shown)
                return;
            shown = false;
            relayout();
        },
        get visible() {
            return visible();
        },
        get placement() {
            return core.placement;
        },
        get gameArea() {
            return gameArea();
        },
        onLayout(listener) {
            layoutListeners.add(listener);
            return () => layoutListeners.delete(listener);
        },
        onPause: (listener) => core.onPause(listener),
        destroy() {
            if (destroyed)
                return;
            destroyed = true;
            core.place(null);
            if (timer)
                clearTimeout(timer);
            if (frame)
                win.cancelAnimationFrame(frame);
            win.removeEventListener('blur', releaseAll);
            win.removeEventListener('click', dropGhostClick, { capture: true });
            doc.removeEventListener('visibilitychange', onVisibility);
            win.removeEventListener('pointerdown', onAnyPointer, { capture: true });
            win.removeEventListener('keydown', onAnyKey, { capture: true });
            win.removeEventListener('gamepadconnected', onPadConnected);
            win.removeEventListener('resize', onResize);
            win.removeEventListener('orientationchange', onResize);
            layoutListeners.clear();
            root.remove();
        },
    };
}
/**
 * The host's one-liner: the pad shows while the game has the controls (the shared
 * input is suspended) and hides while a menu is open, and its pause button opens
 * the menu. Returns the function that undoes it.
 */
export function connectTouchPad(pad, input) {
    const follow = (suspended) => (suspended ? pad.show() : pad.hide());
    follow(input.suspended);
    const offSuspend = input.onSuspend(follow);
    const offPause = pad.onPause(() => input.trigger('menu', { source: 'touch', repeat: false }));
    return () => {
        offSuspend();
        offPause();
    };
}
// ============================================================================
// ---- Languages: English and Spanish, English when in doubt ----
// ============================================================================
//
// Every screen of the ecosystem speaks English and Spanish and falls back to English.
// Code and SDK error messages stay English: they are for developers.
/** The languages every screen speaks. */
export const LOCALES = ['en', 'es'];
/** The text in `locale`, else in English. */
export function localize(text, locale) {
    if (typeof text === 'string')
        return text;
    return text[locale] ?? text.en;
}
const isLocale = (value) => LOCALES.includes(value);
/**
 * The language to speak: `preferred` (the host's) when it is one of {@link LOCALES},
 * else the first of the browser's languages that is (matched on the primary subtag,
 * so `es-419` is `es`), else English.
 */
export function resolveLocale(preferred, languages = globalThis.navigator?.languages ?? []) {
    for (const tag of [preferred, ...languages]) {
        const primary = tag?.toLowerCase().split('-')[0];
        if (isLocale(primary))
            return primary;
    }
    return 'en';
}
/** What engine-specs' own screens say. Apps may reuse these keys. */
export const UI_STRINGS = Object.freeze({
    'settings.title': { en: 'Settings', es: 'Ajustes' },
    'settings.group.video': { en: 'Video', es: 'Vídeo' },
    'settings.group.audio': { en: 'Audio', es: 'Audio' },
    'settings.group.emulation': { en: 'Emulation', es: 'Emulación' },
    'settings.group.game': { en: 'Game', es: 'Juego' },
    'settings.group.controls': { en: 'Controls', es: 'Controles' },
    'settings.yes': { en: 'Yes', es: 'Sí' },
    'settings.no': { en: 'No', es: 'No' },
    'settings.restart': { en: 'Applies on restart', es: 'Se aplica al reiniciar' },
    'settings.reset': { en: 'Reset to defaults', es: 'Restablecer' },
    'settings.resetAsk': { en: 'Put every setting back to its default?', es: '¿Volver a dejar todos los ajustes como venían?' },
    'settings.hints': { en: 'A / ◀ ▶ Change · Y Details · B Back', es: 'A / ◀ ▶ Cambiar · Y Detalles · B Volver' },
    'controls.capture': { en: 'Press a key or a button… (Escape cancels)', es: 'Pulsa una tecla o un botón… (Escape cancela)' },
    'controls.none': { en: '—', es: '—' },
    'fullscreen.toggle': { en: 'Fullscreen', es: 'Pantalla completa' },
    'perf.fps': { en: '{fps} fps', es: '{fps} fps' },
    'perf.frame': { en: '{avg} ms (worst {worst})', es: '{avg} ms (peor {worst})' },
    'perf.dropped': { en: '{dropped} dropped', es: '{dropped} perdidos' },
});
/** One of {@link UI_STRINGS} in `locale`, with `{name}` placeholders filled. */
export function uiText(key, locale, params = {}) {
    return localize(UI_STRINGS[key], locale).replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
}
// ============================================================================
// ---- Settings: the player-facing properties, a model, storage and a screen ----
// ============================================================================
//
// A setting is a property with a `label` (see PropertyDefinition). The model turns
// the descriptors an SDK already returns into rows; the screen draws the rows and
// follows UX.md; the app applies a live change and saves (per engine, in OPFS
// `settings/<engineId>.json`, shared by all its games).
/** The settings screen's sections, in the order they are shown. */
export const SETTING_GROUPS = ['video', 'audio', 'emulation', 'game', 'controls'];
const settingChoices = (descriptor) => {
    if (descriptor.enum && descriptor.enum.length > 0)
        return descriptor.enum;
    const sample = descriptor.value ?? descriptor.default;
    return typeof sample === 'boolean' ? [false, true] : undefined;
};
const choiceLabel = (descriptor, value, index, locale) => {
    const named = descriptor.valueLabels?.[index];
    if (named !== undefined)
        return localize(named, locale);
    if (typeof value === 'boolean')
        return uiText(value ? 'settings.yes' : 'settings.no', locale);
    return String(value);
};
/**
 * The settings screen's content: every property with a `label` and something to step
 * through (an `enum`, or a boolean), grouped in {@link SETTING_GROUPS} order. The
 * current value is the saved one, else the descriptor's `value`, else its `default`.
 * Properties without a `label`, or that cannot be stepped, are left out.
 */
export function settingsModel(described, saved = {}, locale = 'en') {
    const sections = new Map();
    for (const [key, descriptor] of Object.entries(described)) {
        if (descriptor.label === undefined)
            continue;
        const choices = settingChoices(descriptor);
        if (!choices)
            continue;
        const group = descriptor.group ?? 'game';
        const current = key in saved ? saved[key] : (descriptor.value ?? descriptor.default ?? choices[0]);
        const choiceLabels = choices.map((choice, index) => choiceLabel(descriptor, choice, index, locale));
        const at = choices.indexOf(current);
        const row = {
            key,
            label: localize(descriptor.label, locale),
            group,
            value: current,
            valueLabel: choiceLabels[at] ?? String(current),
            choices,
            choiceLabels,
            live: descriptor.live === true,
            ...(descriptor.description ? { description: descriptor.description } : {}),
        };
        sections.set(group, [...(sections.get(group) ?? []), row]);
    }
    return SETTING_GROUPS.filter((group) => sections.has(group)).map((group) => ({
        group,
        title: uiText(`settings.group.${group}`, locale),
        rows: sections.get(group),
    }));
}
/**
 * The value a step takes a row to: `+1` forward, `-1` back. Enums and booleans wrap
 * around; an enum of numbers (a volume) stops at its ends.
 */
export function stepSetting(row, direction) {
    const { choices } = row;
    if (choices.length === 0)
        return row.value;
    const at = choices.indexOf(row.value);
    if (at === -1)
        return choices[0];
    const numeric = choices.every((choice) => typeof choice === 'number');
    const next = at + direction;
    if (numeric)
        return choices[Math.min(choices.length - 1, Math.max(0, next))];
    return choices[(next + choices.length) % choices.length];
}
/** A row with another value, its label updated. */
export function withSettingValue(row, value) {
    const at = row.choices.indexOf(value);
    return { ...row, value, valueLabel: row.choiceLabels[at] ?? String(value) };
}
/** The defaults of every setting (the properties with a `label` and a `default`), for "Reset". */
export function settingsDefaults(described) {
    const defaults = {};
    for (const [key, descriptor] of Object.entries(described)) {
        if (descriptor.label !== undefined && descriptor.default !== undefined)
            defaults[key] = descriptor.default;
    }
    return defaults;
}
/**
 * The settings engine-specs itself provides, for an app to merge into what it shows:
 * the screen Wake Lock ({@link createWakeLock}) and the counter ({@link createPerfCounter}).
 */
export const SHARED_SETTINGS = Object.freeze({
    keepScreenOn: {
        default: true,
        live: true,
        group: 'video',
        label: { en: 'Keep the screen on', es: 'Mantener la pantalla encendida' },
        description: 'Holds a screen Wake Lock while the game runs, released when it is paused or hidden.',
    },
    showPerformance: {
        default: false,
        live: true,
        group: 'video',
        label: { en: 'Show performance', es: 'Mostrar rendimiento' },
        description: 'An overlay with frames per second, frame time and dropped frames.',
    },
});
/** For an engine whose frame loop the app drives: what paces it ({@link createFrameClock}). */
export const FRAME_SYNC_SETTING = Object.freeze({
    frameSync: {
        default: 'display',
        enum: ['display', 'audio'],
        valueLabels: [
            { en: 'Display', es: 'Pantalla' },
            { en: 'Audio', es: 'Audio' },
        ],
        live: true,
        group: 'emulation',
        label: { en: 'Sync', es: 'Sincronización' },
        description: 'What paces the frames: the display refresh, or the audio clock (steady on 120 Hz screens).',
    },
});
const emptySettings = () => ({ version: 1, values: {}, controls: {} });
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A settings file's text, read leniently: missing or broken reads as "nothing saved". */
export function parseSettings(text) {
    if (!text)
        return emptySettings();
    try {
        const data = JSON.parse(text);
        if (!isRecord(data))
            return emptySettings();
        const controls = {};
        if (isRecord(data.controls)) {
            for (const [id, binding] of Object.entries(data.controls)) {
                if (!isRecord(binding))
                    continue;
                controls[id] = {
                    ...(typeof binding.key === 'string' ? { key: binding.key } : {}),
                    ...(typeof binding.code === 'string' ? { code: binding.code } : {}),
                    ...(Number.isInteger(binding.button) ? { button: binding.button } : {}),
                };
            }
        }
        return { version: 1, values: isRecord(data.values) ? { ...data.values } : {}, controls };
    }
    catch {
        return emptySettings();
    }
}
const ENGINE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const settingsRoot = async (root) => {
    if (root)
        return root;
    const storage = globalThis.navigator?.storage;
    if (!storage?.getDirectory)
        throw new Error('OPFS is not available');
    return (await storage.getDirectory());
};
/** The player's settings for an engine (OPFS `settings/<engineId>.json`). Never throws. */
export async function loadSettings(engineId, root) {
    if (!ENGINE_ID.test(engineId))
        throw new Error(`Invalid engine id: ${engineId}`);
    try {
        const dir = await (await settingsRoot(root)).getDirectoryHandle('settings');
        const file = await (await dir.getFileHandle(`${engineId}.json`)).getFile();
        return parseSettings(await file.text());
    }
    catch {
        return emptySettings();
    }
}
/** Writes the player's settings for an engine. */
export async function saveSettings(engineId, settings, root) {
    if (!ENGINE_ID.test(engineId))
        throw new Error(`Invalid engine id: ${engineId}`);
    const dir = await (await settingsRoot(root)).getDirectoryHandle('settings', { create: true });
    const writable = await (await dir.getFileHandle(`${engineId}.json`, { create: true })).createWritable();
    await writable.write(JSON.stringify({ version: 1, values: settings.values, controls: settings.controls }, null, 2));
    await writable.close();
}
/** The standard-mapping gamepad buttons by index, as UX.md names them. */
export const PAD_BUTTON_NAMES = Object.freeze([
    'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', '↑', '↓', '←', '→', 'Home',
]);
const KEY_NAMES = Object.freeze({
    ' ': 'Space',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
});
const CODE_NAMES = Object.freeze({
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
    ShiftLeft: 'Shift (L)',
    ShiftRight: 'Shift (R)',
    ControlLeft: 'Ctrl (L)',
    ControlRight: 'Ctrl (R)',
    AltLeft: 'Alt (L)',
    AltRight: 'Alt (R)',
    MetaLeft: 'Meta (L)',
    MetaRight: 'Meta (R)',
});
/** How a physical key (`KeyboardEvent.code`) is written on screen: `KeyX` → `X`. */
export function codeLabel(code) {
    if (code === undefined)
        return '';
    const named = CODE_NAMES[code];
    if (named !== undefined)
        return named;
    const match = /^(?:Key|Digit)(.)$/.exec(code);
    if (match?.[1])
        return match[1];
    if (code.startsWith('Numpad'))
        return `Num ${code.slice(6)}`;
    return code;
}
/** The `key` a physical key types on a US layout, as far as the menus' keymap needs it. */
function keyOfCode(code) {
    const letter = /^Key([A-Z])$/.exec(code)?.[1];
    if (letter)
        return letter.toLowerCase();
    const digit = /^Digit(\d)$/.exec(code)?.[1];
    if (digit)
        return digit;
    if (code === 'Space')
        return ' ';
    if (code === 'NumpadEnter')
        return 'Enter';
    return code; // Enter, Escape, Backspace, Tab, ArrowUp…, F1… are their own key
}
/**
 * The keys a player bound to the pad buttons the menus use, for
 * {@link UiInput.setKeyAliases}: a pause menu's hints say "A" and "B", and the key bound to
 * the game's A should then accept like the pad's A.
 *
 * `controls` are the game's buttons, each with its current key (`code`) and the pad button
 * the menus read it as (`button`): the engine's default layout, which is what an engine
 * that remaps the pad shows the menus. A key the menus already use (`keymap`: Enter, Space,
 * Escape, Q, E, V, the arrows…) keeps its meaning and is left out.
 */
export function menuKeyAliases(controls, options = {}) {
    const keymap = options.keymap ?? UI_KEYMAP;
    const padmap = options.padmap ?? UI_PADMAP;
    const out = {};
    for (const { code, button } of controls) {
        if (!code || button === undefined)
            continue;
        const action = padmap[button];
        if (!action)
            continue;
        const key = keyOfCode(code);
        if (key !== undefined && (keymap[key] !== undefined || keymap[key.toUpperCase()] !== undefined))
            continue;
        out[code] = action;
    }
    return out;
}
/**
 * The key a hint shows next to a pad button ("B · S"): the key bound to the game button the
 * menus read as `button` (see {@link menuKeyAliases}), when it works in the menus; `''` if none.
 */
export function menuKeyHint(controls, button, options = {}) {
    const list = [...controls];
    const aliases = menuKeyAliases(list, options);
    const found = list.find((control) => control.button === button && control.code && aliases[control.code]);
    return found?.code ? codeLabel(found.code) : '';
}
/** How a binding's key is written: by its `code` when it has one, else by its `key`. */
export function bindingKeyLabel(binding) {
    return binding.code !== undefined ? codeLabel(binding.code) : keyLabel(binding.key);
}
/** How a key is written on screen. */
export function keyLabel(key) {
    if (key === undefined)
        return '';
    const named = KEY_NAMES[key];
    if (named !== undefined)
        return named;
    return key.length === 1 ? key.toUpperCase() : key;
}
/** The controls rows: each button with its binding (saved, else default). */
export function controlsModel(buttons, defaults, saved = {}, locale = 'en') {
    const none = uiText('controls.none', locale);
    return buttons.map(({ id, label }) => {
        const binding = { ...(defaults[id] ?? {}), ...(saved[id] ?? {}) };
        return {
            id,
            label: localize(label, locale),
            binding,
            keyLabel: bindingKeyLabel(binding) || none,
            buttonLabel: binding.button === undefined ? none : (PAD_BUTTON_NAMES[binding.button] ?? `#${binding.button}`),
        };
    });
}
/**
 * The bindings with `id` given a new key and / or button. Another button that had it
 * gets `id`'s old one in exchange, so no two buttons ever share a key or a button.
 * Keys are the same key when their `code`s match (or, without codes, their `key`s);
 * `key` and `code` move together.
 */
export function bindControl(bindings, id, change) {
    const next = {};
    for (const [other, binding] of Object.entries(bindings))
        next[other] = { ...binding };
    const mine = (next[id] ??= {});
    const keyOf = (binding) => ({
        ...(binding.key !== undefined ? { key: binding.key } : {}),
        ...(binding.code !== undefined ? { code: binding.code } : {}),
    });
    const sameKey = (a, b) => a.code !== undefined && b.code !== undefined ? a.code === b.code : a.key !== undefined && a.key === b.key;
    const setKey = (binding, value) => {
        delete binding.key;
        delete binding.code;
        Object.assign(binding, value);
    };
    if (change.key !== undefined || change.code !== undefined) {
        const old = keyOf(mine);
        const value = keyOf(change);
        for (const [other, binding] of Object.entries(next)) {
            if (other !== id && sameKey(binding, value))
                setKey(binding, old);
        }
        setKey(mine, value);
    }
    if (change.button !== undefined) {
        const old = mine.button;
        for (const [other, binding] of Object.entries(next)) {
            if (other === id || binding.button !== change.button)
                continue;
            if (old === undefined)
                delete binding.button;
            else
                binding.button = old;
        }
        mine.button = change.button;
    }
    return next;
}
/**
 * The next key or gamepad button pressed, for a binding. Escape cancels (resolves
 * `undefined`), as does `signal`. Buttons held when it starts are ignored until let
 * go. The shared `input` is muted meanwhile ({@link UiInput.mute}), so the press
 * neither moves a menu nor opens one.
 */
export function captureBinding(input, options = {}) {
    const target = options.target ?? globalThis;
    const gamepads = options.gamepads ??
        (() => (globalThis.navigator?.getGamepads?.() ?? []));
    const schedule = options.schedule === undefined ? (globalThis.requestAnimationFrame?.bind(globalThis) ?? null) : options.schedule;
    const unmute = input?.mute?.() ?? (() => undefined);
    return new Promise((resolve) => {
        let done = false;
        const ignored = new Set();
        for (const pad of gamepads())
            pad?.buttons.forEach((button, index) => button.pressed && ignored.add(index));
        const finish = (binding) => {
            if (done)
                return;
            done = true;
            target.removeEventListener('keydown', onKey, { capture: true });
            options.signal?.removeEventListener('abort', onAbort);
            unmute();
            resolve(binding);
        };
        const onKey = (event) => {
            const key = event;
            key.preventDefault();
            key.stopPropagation();
            if (key.repeat)
                return;
            finish(key.key === 'Escape' ? undefined : { key: key.key, ...(key.code ? { code: key.code } : {}) });
        };
        const onAbort = () => finish(undefined);
        const poll = () => {
            if (done)
                return;
            const down = new Set();
            for (const pad of gamepads())
                pad?.buttons.forEach((button, index) => button.pressed && down.add(index));
            for (const index of [...ignored])
                if (!down.has(index))
                    ignored.delete(index);
            const fresh = [...down].find((index) => !ignored.has(index));
            if (fresh !== undefined)
                return finish({ button: fresh });
            schedule?.(poll);
        };
        if (options.signal?.aborted)
            return finish(undefined);
        options.signal?.addEventListener('abort', onAbort);
        target.addEventListener('keydown', onKey, { capture: true });
        schedule?.(poll);
    });
}
const SETTINGS_STYLE_ID = 'wg-settings-style';
const SETTINGS_CSS = `
.wg-settings { box-sizing: border-box; width: min(560px, 100%); max-height: 100%; overflow-y: auto;
  display: grid; gap: var(--wg-gap, 16px); padding: 20px; color: var(--wg-text, #f4f6fb);
  background: var(--wg-surface, rgb(18 20 28 / 0.92)); border: 1px solid var(--wg-line, rgb(255 255 255 / 0.12));
  border-radius: var(--wg-radius, 22px); font: 16px/1.4 var(--wg-font-ui, system-ui, sans-serif); }
.wg-settings * { box-sizing: border-box; }
.wg-settings h2 { margin: 0; font: 600 22px/1.2 var(--wg-font-display, system-ui, sans-serif); }
.wg-settings h3 { margin: 4px 0 0; color: var(--wg-muted, #8e97a9); font-size: 13px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase; }
.wg-settings-list { display: grid; gap: 6px; }
.wg-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;
  min-height: 48px; padding: 8px 14px; border: 1px solid transparent; border-radius: var(--wg-radius-small, 12px);
  background: rgb(255 255 255 / 0.05); color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: transform 120ms var(--wg-ease, ease), box-shadow 120ms var(--wg-ease, ease); }
.wg-settings-row:focus { outline: none; }
.wg-settings-row.is-focused { box-shadow: var(--wg-focus-ring, 0 0 0 3px #fff); transform: scale(1.01); }
.wg-settings-label { display: grid; gap: 2px; min-width: 0; }
.wg-settings-note, .wg-settings-desc { color: var(--wg-muted, #8e97a9); font-size: 13px; }
.wg-settings-value { flex: none; font-weight: 600; }
.wg-settings-value::before { content: '◀ '; opacity: 0.5; }
.wg-settings-value::after { content: ' ▶'; opacity: 0.5; }
.wg-settings-binding { flex: none; display: flex; gap: 8px; font-weight: 600; }
.wg-settings-binding span { min-width: 2.5em; padding: 2px 8px; border-radius: 8px; background: rgb(255 255 255 / 0.08); text-align: center; }
.wg-settings-reset { color: var(--wg-danger, #f87171); }
.wg-settings-ask { display: grid; gap: 10px; padding: 12px 14px; border-radius: var(--wg-radius-small, 12px); background: rgb(255 255 255 / 0.05); }
.wg-settings-ask div { display: flex; gap: 8px; }
.wg-settings-ask .wg-settings-row { justify-content: center; }
.wg-settings-capture { padding: 10px 14px; border-radius: var(--wg-radius-small, 12px); background: rgb(255 255 255 / 0.08); }
.wg-settings-hints { margin: 0; color: var(--wg-muted, #8e97a9); font-size: 13px; }
`;
/**
 * The settings screen, following UX.md: one row always focused; `up` / `down` move;
 * `left` / `right` / `accept` change a value (`accept` on a control row waits for the
 * new key or button); `more` shows a row's description; `back` closes. A last row
 * resets to the defaults after asking (No first). A tap on a row acts as `accept`.
 *
 * It changes nothing but its own rows: the app applies, saves and, after a reset,
 * calls `update()`.
 */
export function createSettingsScreen(target, options) {
    const doc = target.ownerDocument;
    const locale = options.locale ?? 'en';
    const capture = options.capture ?? ((input) => captureBinding(input));
    if (!doc.getElementById(SETTINGS_STYLE_ID)) {
        const style = doc.createElement('style');
        style.id = SETTINGS_STYLE_ID;
        style.textContent = SETTINGS_CSS;
        doc.head.appendChild(style);
    }
    const root = doc.createElement('section');
    root.className = 'wg-settings';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', uiText('settings.title', locale));
    target.appendChild(root);
    let sections = options.sections;
    let controls = options.controls ?? [];
    let focusAt = 0;
    let asking = false;
    let capturing = false;
    let details = false;
    let destroyed = false;
    let targets = [];
    const el = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className)
            node.className = className;
        if (text !== undefined)
            node.textContent = text;
        return node;
    };
    const render = () => {
        const focused = targets[focusAt];
        const focusKey = focused ? (focused.kind === 'setting' || focused.kind === 'control' ? focused.row.label : focused.kind) : undefined;
        root.replaceChildren();
        targets = [];
        root.append(el('h2', undefined, uiText('settings.title', locale)));
        const rowButton = (onClick) => {
            const button = el('button', 'wg-settings-row');
            button.type = 'button';
            button.tabIndex = -1;
            button.addEventListener('click', () => {
                if (capturing)
                    return;
                focusAt = targets.findIndex((t) => t.el === button);
                onClick();
            });
            return button;
        };
        for (const section of sections) {
            root.append(el('h3', undefined, section.title));
            const list = el('div', 'wg-settings-list');
            for (const row of section.rows) {
                const button = rowButton(() => change(1));
                const label = el('span', 'wg-settings-label');
                label.append(el('span', undefined, row.label));
                if (!row.live)
                    label.append(el('span', 'wg-settings-note', uiText('settings.restart', locale)));
                button.append(label, el('span', 'wg-settings-value', row.valueLabel));
                button.setAttribute('aria-label', `${row.label}: ${row.valueLabel}`);
                list.append(button);
                targets.push({ kind: 'setting', row, el: button });
                if (details && focusKey === row.label && row.description)
                    list.append(el('p', 'wg-settings-desc', row.description));
            }
            root.append(list);
        }
        if (controls.length > 0) {
            root.append(el('h3', undefined, uiText('settings.group.controls', locale)));
            const list = el('div', 'wg-settings-list');
            for (const row of controls) {
                const button = rowButton(() => void rebind(row));
                const binding = el('span', 'wg-settings-binding');
                binding.append(el('span', undefined, row.keyLabel), el('span', undefined, row.buttonLabel));
                button.append(el('span', 'wg-settings-label', row.label), binding);
                list.append(button);
                targets.push({ kind: 'control', row, el: button });
                if (capturing && focusKey === row.label)
                    list.append(el('p', 'wg-settings-capture', uiText('controls.capture', locale)));
            }
            root.append(list);
        }
        const reset = rowButton(() => ask());
        reset.classList.add('wg-settings-reset');
        reset.textContent = uiText('settings.reset', locale);
        root.append(reset);
        targets.push({ kind: 'reset', el: reset });
        if (asking) {
            const box = el('div', 'wg-settings-ask');
            box.append(el('span', undefined, uiText('settings.resetAsk', locale)));
            const buttons = el('div');
            const no = rowButton(() => answer(false));
            no.textContent = uiText('settings.no', locale);
            const yes = rowButton(() => answer(true));
            yes.textContent = uiText('settings.yes', locale);
            buttons.append(no, yes);
            box.append(buttons);
            root.append(box);
            targets.push({ kind: 'no', el: no }, { kind: 'yes', el: yes });
        }
        root.append(el('p', 'wg-settings-hints', uiText('settings.hints', locale)));
        // Keep the focus on the same row across a repaint.
        if (focusKey !== undefined) {
            const again = targets.findIndex((t) => t.kind === 'setting' || t.kind === 'control' ? t.row.label === focusKey : t.kind === focusKey);
            if (again !== -1)
                focusAt = again;
        }
        focusAt = Math.min(Math.max(0, focusAt), targets.length - 1);
        paintFocus();
    };
    const paintFocus = () => {
        targets.forEach((t, index) => t.el.classList.toggle('is-focused', index === focusAt));
        const current = targets[focusAt]?.el;
        current?.focus({ preventScroll: true });
        current?.scrollIntoView?.({ block: 'nearest' });
    };
    const change = (direction) => {
        const current = targets[focusAt];
        if (current?.kind !== 'setting')
            return;
        const value = stepSetting(current.row, direction);
        if (value === current.row.value)
            return;
        const row = withSettingValue(current.row, value);
        sections = sections.map((section) => ({ ...section, rows: section.rows.map((r) => (r.key === row.key ? row : r)) }));
        render();
        options.onChange(row.key, value, row);
    };
    const rebind = async (row) => {
        if (capturing)
            return;
        capturing = true;
        render();
        const binding = await capture(options.input);
        capturing = false;
        if (destroyed)
            return;
        if (binding) {
            const bindings = Object.fromEntries(controls.map((c) => [c.id, c.binding]));
            const next = bindControl(bindings, row.id, binding);
            controls = controls.map((c) => {
                const b = next[c.id] ?? {};
                const none = uiText('controls.none', locale);
                return {
                    ...c,
                    binding: b,
                    keyLabel: bindingKeyLabel(b) || none,
                    buttonLabel: b.button === undefined ? none : (PAD_BUTTON_NAMES[b.button] ?? `#${b.button}`),
                };
            });
            options.onControl?.(row.id, next[row.id] ?? {}, next);
        }
        render();
    };
    const ask = () => {
        asking = true;
        render();
        focusAt = targets.findIndex((t) => t.kind === 'no');
        paintFocus();
    };
    const answer = (yes) => {
        asking = false;
        render();
        focusAt = targets.findIndex((t) => t.kind === 'reset');
        paintFocus();
        if (yes)
            options.onReset();
    };
    const move = (direction) => {
        const next = focusAt + direction;
        if (asking) {
            const kinds = targets[next]?.kind;
            if (kinds === 'yes' || kinds === 'no')
                focusAt = next;
        }
        else if (targets[next] && targets[next].kind !== 'yes' && targets[next].kind !== 'no') {
            focusAt = next;
            if (details) {
                details = false;
                render();
                return;
            }
        }
        paintFocus();
    };
    const off = options.input.on((action) => {
        if (destroyed || capturing)
            return;
        const current = targets[focusAt];
        switch (action) {
            case 'up':
                return move(-1);
            case 'down':
                return move(1);
            case 'left':
            case 'right':
                if (asking)
                    return move(action === 'left' ? -1 : 1);
                return change(action === 'left' ? -1 : 1);
            case 'accept':
                return current?.el.click();
            case 'more':
                if (current?.kind === 'setting' && current.row.description) {
                    details = !details;
                    render();
                }
                return;
            case 'back':
                if (asking)
                    return answer(false);
                if (details) {
                    details = false;
                    return render();
                }
                return options.onClose();
            default:
                return;
        }
    });
    render();
    return {
        element: root,
        update(nextSections, nextControls) {
            sections = nextSections;
            if (nextControls)
                controls = nextControls;
            render();
        },
        destroy() {
            destroyed = true;
            off();
            root.remove();
        },
    };
}
/** macOS (and iPadOS) or anything else, from the user agent's platform. */
export function platformOf(nav = globalThis.navigator) {
    const name = nav?.userAgentData?.platform || nav?.platform || '';
    return /mac|iphone|ipad|ipod/i.test(name) ? 'mac' : 'other';
}
/** The fullscreen key: Cmd+Enter on macOS, Alt+Enter elsewhere (the owner's choice). */
export function fullscreenShortcut(platform = platformOf()) {
    return platform === 'mac' ? { key: 'Enter', meta: true } : { key: 'Enter', alt: true };
}
/** Select + Y (standard mapping 8 + 3). Select + Start stays the menu. */
export const FULLSCREEN_PAD_COMBO = Object.freeze([8, 3]);
/** Whether a keydown is `shortcut` (exact modifiers; never inside a text field). */
export function isShortcut(event, shortcut) {
    if (isEditable(event.target ?? null))
        return false;
    return (event.key === shortcut.key &&
        event.altKey === Boolean(shortcut.alt) &&
        event.metaKey === Boolean(shortcut.meta) &&
        event.ctrlKey === Boolean(shortcut.ctrl) &&
        event.shiftKey === Boolean(shortcut.shift));
}
/**
 * The fullscreen toggle of an engine app: {@link fullscreenShortcut} on the keyboard
 * and {@link FULLSCREEN_PAD_COMBO} on any gamepad, in game and in menus. Browsers
 * allow fullscreen only from a user gesture; a pad press counts in Chromium but not
 * everywhere, which is why the pause menu has the entry too.
 */
export function createFullscreenToggle(root, options = {}) {
    const doc = root.ownerDocument;
    const target = options.target ?? globalThis;
    const shortcut = options.shortcut ?? fullscreenShortcut();
    const combo = options.combo ?? FULLSCREEN_PAD_COMBO;
    const gamepads = options.gamepads ??
        (() => (globalThis.navigator?.getGamepads?.() ?? []));
    const schedule = options.schedule === undefined ? (globalThis.requestAnimationFrame?.bind(globalThis) ?? null) : options.schedule;
    const keyboard = options.keyboard === undefined
        ? (globalThis.navigator?.keyboard ?? null)
        : options.keyboard;
    const giveBackEscape = options.giveBackEscape ?? true;
    const listeners = new Set();
    let destroyed = false;
    let polling = false;
    let held = false;
    let leaving = false; // this toggle asked to leave
    let locked = false; // Escape is locked (it reaches the page)
    let wasActive = false;
    const active = () => doc.fullscreenElement === root;
    const toggle = async () => {
        try {
            if (active()) {
                leaving = true;
                await doc.exitFullscreen();
            }
            else
                await root.requestFullscreen();
        }
        catch {
            // Refused (no user gesture, or not allowed): nothing changes.
            leaving = false;
        }
    };
    /** The Escape the browser kept, back to the page: what the player pressed. */
    const escapeEvent = () => {
        const init = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
        if (typeof KeyboardEvent === 'function')
            return new KeyboardEvent('keydown', init);
        return Object.assign(new Event('keydown', init), { key: 'Escape', code: 'Escape', repeat: false });
    };
    const entered = () => {
        if (!keyboard)
            return;
        keyboard.lock(['Escape']).then(() => {
            // Still fullscreen? (it may have ended while the lock was being granted)
            if (active() && !destroyed)
                locked = true;
            else
                keyboard.unlock();
        }, () => {
            locked = false; // refused: the browser keeps Escape, it is given back on leaving
        });
    };
    const left = () => {
        const byUs = leaving;
        const hadLock = locked;
        leaving = false;
        locked = false;
        if (keyboard && hadLock)
            keyboard.unlock();
        if (!byUs && !hadLock && giveBackEscape && !destroyed)
            target.dispatchEvent(escapeEvent());
    };
    const onKey = (event) => {
        const key = event;
        if (destroyed || key.repeat || !isShortcut(key, shortcut))
            return;
        key.preventDefault();
        key.stopPropagation();
        void toggle();
    };
    const onChange = () => {
        const now = active();
        if (now && !wasActive)
            entered();
        else if (!now && wasActive)
            left();
        wasActive = now;
        for (const listener of [...listeners])
            listener(now);
    };
    const poll = () => {
        if (destroyed)
            return;
        const down = gamepads().some((pad) => pad && combo.every((index) => pad.buttons[index]?.pressed));
        if (down && !held)
            void toggle();
        held = down;
    };
    const loop = () => {
        if (destroyed || !schedule)
            return;
        poll();
        schedule(loop);
    };
    const startPolling = () => {
        if (polling || !schedule)
            return;
        polling = true;
        schedule(loop);
    };
    target.addEventListener('keydown', onKey, { capture: true });
    target.addEventListener('gamepadconnected', startPolling);
    doc.addEventListener('fullscreenchange', onChange);
    if (gamepads().some(Boolean))
        startPolling();
    return {
        toggle,
        get active() {
            return active();
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        poll,
        destroy() {
            destroyed = true;
            listeners.clear();
            if (locked)
                keyboard?.unlock();
            locked = false;
            target.removeEventListener('keydown', onKey, { capture: true });
            target.removeEventListener('gamepadconnected', startPolling);
            doc.removeEventListener('fullscreenchange', onChange);
        },
    };
}
/**
 * The screen kept on while playing: a Wake Lock held while `setActive(true)` and the
 * page is visible, taken again when it comes back into view (the browser drops it on
 * hide). Without the API it does nothing.
 */
export function createWakeLock(options = {}) {
    const api = options.wakeLock ?? globalThis.navigator?.wakeLock;
    const doc = options.document ?? globalThis.document;
    let wanted = false;
    let destroyed = false;
    let sentinel = null;
    let pending = false;
    const visible = () => !doc || doc.visibilityState === 'visible';
    const acquire = async () => {
        if (!api || sentinel || pending || !wanted || !visible() || destroyed)
            return;
        pending = true;
        try {
            const lock = await api.request('screen');
            sentinel = lock;
            lock.addEventListener('release', () => {
                if (sentinel === lock)
                    sentinel = null;
            });
            if (!wanted || destroyed)
                await release();
        }
        catch {
            // Refused (battery saver, not visible): try again on the next chance.
        }
        finally {
            pending = false;
        }
    };
    const release = async () => {
        const lock = sentinel;
        sentinel = null;
        await lock?.release().catch(() => undefined);
    };
    const onVisibility = () => {
        if (visible())
            void acquire();
    };
    doc?.addEventListener('visibilitychange', onVisibility);
    return {
        setActive(active) {
            wanted = active;
            if (active)
                void acquire();
            else
                void release();
        },
        get held() {
            return sentinel !== null;
        },
        destroy() {
            destroyed = true;
            wanted = false;
            doc?.removeEventListener('visibilitychange', onVisibility);
            void release();
        },
    };
}
/** The stats of frame timestamps (ms, ascending) — usually the last second's. */
export function frameStats(times, expectedFps = 60) {
    if (times.length < 2)
        return { fps: 0, avg: 0, worst: 0, dropped: 0 };
    const expected = 1000 / expectedFps;
    let worst = 0;
    let dropped = 0;
    for (let i = 1; i < times.length; i++) {
        const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
        worst = Math.max(worst, gap);
        if (gap > expected * 1.5)
            dropped += Math.round(gap / expected) - 1;
    }
    const span = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
    const avg = span / (times.length - 1);
    return { fps: avg > 0 ? 1000 / avg : 0, avg, worst, dropped };
}
/**
 * The "Show performance" overlay: frames per second, frame time (mean and worst over
 * the last second) and dropped frames, in a corner of `target`.
 */
export function createPerfCounter(target, options = {}) {
    const doc = target.ownerDocument;
    const locale = options.locale ?? 'en';
    const expectedFps = options.expectedFps ?? 60;
    const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    const schedule = options.schedule === undefined ? (globalThis.requestAnimationFrame?.bind(globalThis) ?? null) : options.schedule;
    const box = doc.createElement('div');
    box.className = 'wg-perf';
    box.style.cssText =
        'position:absolute;top:calc(8px + var(--wg-safe-top, 0px));left:8px;z-index:10;padding:4px 8px;border-radius:8px;' +
            'background:rgb(0 0 0 / 0.65);color:#fff;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;white-space:pre';
    box.hidden = true;
    target.appendChild(box);
    let times = [];
    let fed = false;
    let lastPaint = 0;
    let stats = { fps: 0, avg: 0, worst: 0, dropped: 0 };
    let destroyed = false;
    let looping = false;
    const paint = () => {
        if (box.hidden)
            return;
        box.textContent = [
            uiText('perf.fps', locale, { fps: stats.fps.toFixed(0) }),
            uiText('perf.frame', locale, { avg: stats.avg.toFixed(1), worst: stats.worst.toFixed(1) }),
            uiText('perf.dropped', locale, { dropped: stats.dropped }),
        ].join('\n');
    };
    const record = (t) => {
        times.push(t);
        const from = t - 1000;
        let cut = 0;
        while (cut < times.length && (times[cut] ?? 0) < from)
            cut++;
        if (cut > 0)
            times = times.slice(cut);
        if (t - lastPaint >= 250) {
            lastPaint = t;
            stats = frameStats(times, expectedFps);
            paint();
        }
    };
    const loop = () => {
        if (destroyed || box.hidden || !schedule) {
            looping = false;
            return;
        }
        if (!fed)
            record(now());
        schedule(loop);
    };
    return {
        frame() {
            fed = true;
            record(now());
        },
        show() {
            box.hidden = false;
            lastPaint = -Infinity;
            paint();
            if (!looping && schedule) {
                looping = true;
                schedule(loop);
            }
        },
        hide() {
            box.hidden = true;
        },
        get visible() {
            return !box.hidden;
        },
        get stats() {
            return stats;
        },
        destroy() {
            destroyed = true;
            box.remove();
        },
    };
}
/** How many frames are due after `elapsed` ms at `fps`, and the remainder carried to the next call. */
export function framesDue(elapsed, fps, carried = 0) {
    const frame = 1000 / fps;
    const total = Math.max(0, elapsed) + carried;
    const frames = Math.floor(total / frame);
    return { frames, carried: total - frames * frame };
}
/**
 * The frame loop of an engine the app drives. `'display'` counts time on the page
 * clock; `'audio'` on the `AudioContext`'s, so the game runs at `fps` whatever the
 * screen's refresh rate, and stays in step with its sound.
 */
export function createFrameClock(options = {}) {
    const fps = options.fps ?? 60;
    const maxFrames = options.maxFrames ?? 4;
    const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    const schedule = options.schedule === undefined ? (globalThis.requestAnimationFrame?.bind(globalThis) ?? null) : options.schedule;
    let mode = options.mode ?? 'display';
    let tick = null;
    let last = null;
    let carried = 0;
    let source = mode;
    const clock = () => {
        const audio = options.audioContext;
        if (mode === 'audio' && audio && audio.state === 'running')
            return { at: audio.currentTime * 1000, source: 'audio' };
        return { at: now(), source: 'display' };
    };
    const step = () => {
        if (!tick)
            return;
        const reading = clock();
        // A switch of clock (audio started or stopped, or the mode changed) restarts the count.
        if (last === null || reading.source !== source) {
            last = reading.at;
            source = reading.source;
            carried = 0;
            tick(0);
            return;
        }
        const due = framesDue(reading.at - last, fps, carried);
        last = reading.at;
        if (due.frames > maxFrames) {
            carried = 0;
            tick(maxFrames);
        }
        else {
            carried = due.carried;
            tick(due.frames);
        }
    };
    const loop = () => {
        if (!tick)
            return;
        step();
        schedule?.(loop);
    };
    return {
        start(next) {
            const running = tick !== null;
            tick = next;
            last = null;
            if (!running)
                schedule?.(loop);
        },
        stop() {
            tick = null;
        },
        get mode() {
            return mode;
        },
        set mode(value) {
            mode = value;
        },
        step,
    };
}
