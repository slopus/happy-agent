import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import type { SessionOutputBlock } from "@slopus/happy-providers";
import {
    newQuickJSWASMModuleFromVariant,
    type QuickJSContext,
    type QuickJSDeferredPromise,
    type QuickJSHandle,
} from "quickjs-emscripten-core";

/** The longest a script may compute without awaiting anything before it is stopped. */
const MAX_UNINTERRUPTED_COMPUTATION_MS = 10_000;

/** The memory one isolate may use. */
const MAX_ISOLATE_MEMORY_BYTES = 256 * 1024 * 1024;

/** The text a script may accumulate before further text is dropped. */
const MAX_ACCUMULATED_TEXT_BYTES = 1024 * 1024;

/** How a cell ended, in Codex's own words for it. */
export type CodexExecCellStatus = "completed" | "failed" | "terminated";

export interface CodexExecCellResult {
    readonly status: CodexExecCellStatus;
    readonly items: readonly SessionOutputBlock[];
    /** What stopped a failed or terminated script, as the model reads it. */
    readonly error?: string;
}

export interface CodexExecCellOptions {
    /** The model's JavaScript, evaluated as an async module. */
    readonly source: string;
    /** Every nested tool as the script sees it in `ALL_TOOLS`. */
    readonly catalog: readonly { readonly name: string; readonly description: string }[];
    /** Run one nested tool and answer with its JSON-serializable result. */
    readonly call: (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
    /** The call's own lifetime; aborting it terminates the script. */
    readonly signal: AbortSignal;
}

/**
 * Evaluate one `exec` script in a fresh QuickJS isolate.
 *
 * Each cell gets its own WebAssembly instance, so nothing one script does can outlive it or reach
 * another, and the instance is simply dropped afterwards rather than torn down handle by handle.
 * The script awaits nested tools through host promises; the host runs each nested call and wakes
 * the isolate when it settles. The cell ends when the module's own evaluation settles, as Codex's
 * does: promises left unawaited are discarded and their nested calls are cancelled.
 */
export async function runCodexExecCell(
    options: CodexExecCellOptions,
): Promise<CodexExecCellResult> {
    const module = await newQuickJSWASMModuleFromVariant(variant);
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(MAX_ISOLATE_MEMORY_BYTES);
    const cell = new AbortController();
    const signal = AbortSignal.any([options.signal, cell.signal]);
    let sliceDeadline = Number.POSITIVE_INFINITY;
    let overran = false;
    runtime.setInterruptHandler(() => {
        if (options.signal.aborted) return true;
        if (Date.now() <= sliceDeadline) return false;
        overran = true;
        return true;
    });
    const vm = runtime.newContext();
    const items: SessionOutputBlock[] = [];
    let textBytes = 0;
    let droppedText = false;
    let outstanding = 0;
    let finished = false;
    let wake: (() => void) | undefined;
    const notify = () => {
        const resume = wake;
        wake = undefined;
        resume?.();
    };
    const timers = new Set<ReturnType<typeof setTimeout>>();
    signal.addEventListener("abort", notify, { once: true });

    const settle = (
        deferred: QuickJSDeferredPromise,
        outcome: () => QuickJSHandle | Error | undefined,
    ) => {
        outstanding -= 1;
        if (!finished && deferred.alive) {
            const value = outcome();
            if (value === undefined) {
                deferred.resolve();
            } else if (value instanceof Error) {
                const error = vm.newError(value.message);
                deferred.reject(error);
                error.dispose();
            } else {
                deferred.resolve(value);
                value.dispose();
            }
        }
        notify();
    };

    define(vm, "__text", (handle) => {
        const text = vm.getString(handle);
        const bytes = Buffer.byteLength(text, "utf8");
        if (textBytes + bytes > MAX_ACCUMULATED_TEXT_BYTES) {
            if (!droppedText) {
                droppedText = true;
                items.push({
                    type: "text",
                    text: "[Further text was dropped: the script produced more than 1 MiB.]",
                });
            }
            return;
        }
        textBytes += bytes;
        items.push({ type: "text", text });
    });
    define(vm, "__image", (handle) => {
        const image = parseImage(JSON.parse(vm.getString(handle)) as unknown);
        if (typeof image === "string") return { error: vm.newError(image) };
        items.push(image);
        return undefined;
    });
    define(vm, "__call", (nameHandle, inputHandle) => {
        const name = vm.getString(nameHandle);
        const input = JSON.parse(vm.getString(inputHandle)) as unknown;
        const deferred = vm.newPromise();
        outstanding += 1;
        void options.call(name, input, signal).then(
            (result) => settle(deferred, () => vm.newString(JSON.stringify(result ?? null))),
            (error: unknown) => settle(deferred, () => new Error(errorMessage(error))),
        );
        return deferred.handle;
    });
    define(vm, "__sleep", (handle) => {
        const delay = Math.max(0, Math.min(2_147_483_647, vm.getNumber(handle) || 0));
        const deferred = vm.newPromise();
        outstanding += 1;
        const timer = setTimeout(() => {
            timers.delete(timer);
            settle(deferred, () => undefined);
        }, delay);
        timers.add(timer);
        return deferred.handle;
    });
    const catalog = vm.newString(JSON.stringify(options.catalog));
    vm.setProp(vm.global, "__catalog", catalog);
    catalog.dispose();
    vm.unwrapResult(vm.evalCode(PRELUDE, "prelude.js")).dispose();

    try {
        sliceDeadline = Date.now() + MAX_UNINTERRUPTED_COMPUTATION_MS;
        const evaluated = vm.evalCode(options.source, "exec.js", { type: "module" });
        if (evaluated.error !== undefined) {
            if (isExit(vm, evaluated.error)) return { status: "completed", items };
            return failed(items, overran ? OVERRAN : describeError(vm, evaluated.error));
        }
        const promise = evaluated.value;
        for (;;) {
            sliceDeadline = Date.now() + MAX_UNINTERRUPTED_COMPUTATION_MS;
            runtime.executePendingJobs();
            if (overran) return failed(items, OVERRAN);
            if (options.signal.aborted) return terminated(items);
            const state = vm.getPromiseState(promise);
            if (state.type === "fulfilled") return { status: "completed", items };
            if (state.type === "rejected") {
                if (isExit(vm, state.error)) return { status: "completed", items };
                return failed(items, describeError(vm, state.error));
            }
            if (outstanding === 0) {
                return failed(
                    items,
                    "The script is awaiting a promise that nothing will ever settle.",
                );
            }
            sliceDeadline = Number.POSITIVE_INFINITY;
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }
    } finally {
        finished = true;
        cell.abort();
        for (const timer of timers) clearTimeout(timer);
        // The whole WebAssembly instance is discarded with this cell. Disposing the runtime would
        // only assert that every guest handle had been released first, which a script that left
        // promises behind cannot promise.
    }
}

const OVERRAN = `The script computed for more than ${String(MAX_UNINTERRUPTED_COMPUTATION_MS / 1_000)} seconds without awaiting anything and was stopped.`;

/** The globals Codex documents, built over the four host functions and then hidden from scripts. */
const PRELUDE = `(() => {
    const g = globalThis;
    const hostText = g.__text, hostImage = g.__image, hostCall = g.__call, hostSleep = g.__sleep;
    const catalog = JSON.parse(g.__catalog);
    for (const name of ["__text", "__image", "__call", "__sleep", "__catalog"]) delete g[name];
    const stringify = (value) => {
        if (typeof value === "string") return value;
        try {
            const text = JSON.stringify(value);
            if (text !== undefined) return text;
        } catch {}
        return String(value);
    };
    const exitSignal = Object.freeze({ __codexExecExit: true });
    g.exit = () => { throw exitSignal; };
    g.text = (value) => { hostText(stringify(value)); };
    g.image = (item, detail) => {
        hostImage(JSON.stringify(typeof item === "string" ? { image_url: item, detail } : { ...item, detail }));
    };
    g.ALL_TOOLS = Object.freeze(catalog.map((entry) => Object.freeze({ ...entry })));
    const tools = {};
    for (const { name } of catalog) {
        tools[name] = async (input) =>
            JSON.parse(await hostCall(name, JSON.stringify(input === undefined ? null : input)));
    }
    g.tools = Object.freeze(tools);
    let nextTimeout = 1;
    const cancelled = new Set();
    g.setTimeout = (callback, delayMs) => {
        const id = nextTimeout++;
        hostSleep(Number(delayMs) || 0).then(() => {
            if (cancelled.delete(id)) return;
            callback();
        });
        return id;
    };
    g.clearTimeout = (id) => { if (id !== undefined) cancelled.add(id); };
})();`;

function define(
    vm: QuickJSContext,
    name: string,
    implementation: Parameters<QuickJSContext["newFunction"]>[1],
): void {
    const handle = vm.newFunction(name, implementation);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
}

function failed(items: readonly SessionOutputBlock[], error: string): CodexExecCellResult {
    return { status: "failed", items, error };
}

function terminated(items: readonly SessionOutputBlock[]): CodexExecCellResult {
    return { status: "terminated", items, error: "The turn was stopped while the script ran." };
}

function isExit(vm: QuickJSContext, error: QuickJSHandle): boolean {
    const value = vm.dump(error) as unknown;
    return typeof value === "object" && value !== null && "__codexExecExit" in value;
}

/** A guest exception as JavaScript prints it: its name and message, then its stack. */
function describeError(vm: QuickJSContext, error: QuickJSHandle): string {
    const value = vm.dump(error) as unknown;
    if (typeof value !== "object" || value === null) return String(value);
    const { name, message, stack } = value as {
        name?: unknown;
        message?: unknown;
        stack?: unknown;
    };
    if (typeof message !== "string") return JSON.stringify(value);
    const heading = `${typeof name === "string" ? name : "Error"}: ${message}`;
    return typeof stack === "string" && stack.trim().length > 0
        ? `${heading}\n${stack.trimEnd()}`
        : heading;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * An image item from what a script handed `image()`: a base64 `data:` URL, `{ image_url }`, or an
 * image block with its data and media type. Anything else is the reason it was refused.
 */
function parseImage(item: unknown): SessionOutputBlock | string {
    if (typeof item !== "object" || item === null)
        return "image() takes a data: URL or an image item.";
    const record = item as Record<string, unknown>;
    if (typeof record.image_url === "string") {
        const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/u.exec(
            record.image_url,
        );
        if (match === null) return "image() supports only base64-encoded data: URLs for images.";
        return { type: "image", mimeType: match[1]!, data: match[2]!.replaceAll(/\s/g, "") };
    }
    const mimeType = record.mimeType ?? record.mime_type;
    if (
        typeof record.data === "string" &&
        typeof mimeType === "string" &&
        mimeType.startsWith("image/")
    ) {
        return { type: "image", mimeType, data: record.data };
    }
    return "image() takes a data: URL or an image item with its data and media type.";
}
