import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** Only pending operations are retained; a settled refresh never caches a secret or a failure. */
export class CredentialRefresh<T> {
    readonly #pending = new Map<string, Promise<T>>();

    async run(path: string, action: (path: string) => Promise<T>): Promise<T> {
        const key = await realpath(path).catch(() => resolve(path));
        let pending = this.#pending.get(key);
        if (pending === undefined) {
            pending = action(key).finally(() => this.#pending.delete(key));
            this.#pending.set(key, pending);
        }
        return await pending;
    }
}

/** Cover discovery, token exchange, and response-body consumption with one bounded deadline. */
export async function credentialRefreshRequest<T>(
    action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(new Error("Credential refresh timed out.")),
        30_000,
    );
    timeout.unref();
    try {
        return await action(controller.signal);
    } finally {
        clearTimeout(timeout);
    }
}

/** Authentication responses are small; never retain an unbounded upstream response. */
export async function readCredentialRefreshJson(response: Response): Promise<unknown> {
    if (response.body === null) throw new Error("Credential refresh returned an empty response.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 256 * 1024) {
                await reader.cancel();
                throw new Error("Credential refresh returned an oversized response.");
            }
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally {
        reader.releaseLock();
    }
}

/** A cancelled observer must not cancel another caller's rotation or discard its new token. */
export function waitForCredentialRefresh<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return pending;
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Credential refresh cancelled."));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
