import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";

const MAX_JWKS_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 5_000;
const ON_DEMAND_COOLDOWN_MS = 30_000;
const RETRY_AFTER_FAILURE_MS = 60_000;

const jwksSchema = Type.Object({
    keys: Type.Array(Type.Object({ kty: Type.String({ minLength: 1 }) }), { maxItems: 100 }),
});

export interface RefreshingJwksOptions {
    readonly url: string;
    readonly intervalMs: number;
    /** The `fetch` to download with. Defaults to the global one. */
    readonly fetch?: typeof globalThis.fetch;
    /** The clock, in epoch milliseconds. */
    readonly now?: () => number;
    /** How long to wait after a failed download. Defaults to 60 seconds. */
    readonly retryAfterFailureMs?: number;
}

/**
 * A JWKS the daemon downloads itself and keeps fresh.
 *
 * `run` downloads on a fixed interval, retrying sooner after a failure. A token
 * naming an unknown key triggers one rate-limited download so rotations apply at
 * once. A failed download keeps the last good set; a successful one replaces it.
 */
export class RefreshingJwks {
    readonly #options: RefreshingJwksOptions;
    readonly #fetch: typeof globalThis.fetch;
    readonly #now: () => number;
    #keys: JWTVerifyGetKey | undefined;
    #lastOnDemand = Number.NEGATIVE_INFINITY;
    #inFlight: Promise<boolean> | undefined;

    constructor(options: RefreshingJwksOptions) {
        this.#options = options;
        this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.#now = options.now ?? Date.now;
    }

    /** Resolve a token's verification key, downloading once when the key is unknown. */
    readonly getKey: JWTVerifyGetKey = async (header, token) => {
        const cached = this.#keys;
        if (cached !== undefined) {
            try {
                return await cached(header, token);
            } catch (error: unknown) {
                if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
            }
        }
        if (this.#now() - this.#lastOnDemand < ON_DEMAND_COOLDOWN_MS) {
            throw new errors.JWKSNoMatchingKey();
        }
        this.#lastOnDemand = this.#now();
        await this.refresh();
        const refreshed = this.#keys;
        if (refreshed === undefined || refreshed === cached) throw new errors.JWKSNoMatchingKey();
        return await refreshed(header, token);
    };

    /** Download the set once, sharing a download already in flight. Resolves whether it succeeded. */
    async refresh(signal?: AbortSignal): Promise<boolean> {
        this.#inFlight ??= this.#download(signal).finally(() => {
            this.#inFlight = undefined;
        });
        return await this.#inFlight;
    }

    /** Keep the set fresh until `ctx.lifetime` ends. Failures are logged and retried. */
    async run(ctx: Context): Promise<void> {
        const signal = ctx.lifetime;
        const stopped = (): boolean => signal?.aborted === true;
        while (!stopped()) {
            const succeeded = await this.refresh(signal);
            if (!succeeded && !stopped()) {
                ctx.log.warn("The JWT key set could not be downloaded; the last good set is kept.");
            }
            await sleep(
                succeeded
                    ? this.#options.intervalMs
                    : (this.#options.retryAfterFailureMs ?? RETRY_AFTER_FAILURE_MS),
                signal,
            );
        }
    }

    async #download(signal: AbortSignal | undefined): Promise<boolean> {
        const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        try {
            const response = await this.#fetch(this.#options.url, {
                headers: { accept: "application/json" },
                redirect: "error",
                signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            });
            if (!response.ok || response.body === null) return false;
            const text = await readBounded(response.body, MAX_JWKS_BYTES);
            if (text === undefined) return false;
            const parsed: unknown = JSON.parse(text);
            if (!Value.Check(jwksSchema, parsed)) return false;
            this.#keys = createLocalJWKSet(parsed as JSONWebKeySet);
            return true;
        } catch {
            return false;
        }
    }
}

async function readBounded(
    body: ReadableStream<Uint8Array>,
    limit: number,
): Promise<string | undefined> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            return undefined;
        }
        chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
}

async function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, milliseconds);
        timer.unref?.();
        signal?.addEventListener("abort", done, { once: true });
        function done(): void {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
    });
}
