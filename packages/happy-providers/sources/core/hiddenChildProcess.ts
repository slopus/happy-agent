import * as childProcess from "node:child_process";
import { promisify } from "node:util";

/*
 * Every program Happy Agent starts is started through these, never through `node:child_process`
 * directly. On Windows a console program started without `windowsHide` gets a console window of
 * its own whenever the process starting it has none, which is always true of the detached daemon,
 * so the person sees a window flash open. These always pass `windowsHide: true`, and no caller can
 * turn it off. Everywhere else they behave exactly like the Node functions they wrap.
 *
 * This file is copied verbatim into each package that starts programs, because the published
 * packages cannot share code with one another; `scripts/windows` checks the copies stay identical
 * and that nothing else starts a program.
 */

/** `child_process.spawn` that never opens a console window on Windows. */
export const spawnHidden = hideWindow("spawn");

/** `child_process.spawnSync` that never opens a console window on Windows. */
export const spawnSyncHidden = hideWindow("spawnSync");

/** `child_process.execFile` that never opens a console window on Windows, `promisify` included. */
export const execFileHidden: typeof childProcess.execFile = Object.assign(hideWindow("execFile"), {
    [promisify.custom]: withHiddenWindowCall(() => promisify(childProcess.execFile)),
});

/** `child_process.execFileSync` that never opens a console window on Windows. */
export const execFileSyncHidden = hideWindow("execFileSync");

type Launcher = "execFile" | "execFileSync" | "spawn" | "spawnSync";

function hideWindow<Name extends Launcher>(name: Name): (typeof childProcess)[Name] {
    return withHiddenWindowCall(() => childProcess[name]) as unknown as (typeof childProcess)[Name];
}

/** The Node function is looked up on each call, so one replaced in a test is the one called. */
function withHiddenWindowCall(launcher: () => unknown) {
    return (file: unknown, ...rest: unknown[]) =>
        (launcher() as (...args: unknown[]) => unknown)(file, ...withHiddenWindow(rest));
}

/**
 * Node's launchers all take `(file, args?, options?, callback?)`, where `args` is the only array
 * and the options may be left out, `undefined`, or `null` before a callback.
 */
export function withHiddenWindow(rest: readonly unknown[]): unknown[] {
    const at = Array.isArray(rest[0]) ? 1 : 0;
    const options = rest[at];
    const before = rest.slice(0, at);
    if (typeof options === "object" && options !== null) {
        return [...before, { ...options, windowsHide: true }, ...rest.slice(at + 1)];
    }
    const after = options === undefined || options === null ? rest.slice(at + 1) : rest.slice(at);
    return [...before, { windowsHide: true }, ...after];
}
