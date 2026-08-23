import { randomBytes } from "node:crypto";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { StoredHappyCredentials } from "./HappyCredentials.js";
import { decryptHappyAuthBundle } from "./crypto/happyEncryption.js";
import { nobleBoxKeyPairFromSecretKey } from "./crypto/nobleNaCl.js";

export const HAPPY_PAIRING_LIFETIME_MS = 120_000;
const HAPPY_PAIRING_POLL_INTERVAL_MS = 1_000;
const HAPPY_PAIRING_REQUEST_TIMEOUT_MS = 15_000;
const HAPPY_PAIRING_RESPONSE_MAX_BYTES = 64 * 1_024;
const HAPPY_AUTHORIZATION_BUNDLE_MAX_LENGTH = 4_096;
const HAPPY_AUTHORIZATION_TOKEN_MAX_LENGTH = 16_384;

const happyAuthResponseSchema = Type.Union([
    Type.Object({ state: Type.Literal("requested") }),
    Type.Object({
        response: Type.String({
            minLength: 1,
            maxLength: HAPPY_AUTHORIZATION_BUNDLE_MAX_LENGTH,
        }),
        state: Type.Literal("authorized"),
        token: Type.String({ minLength: 1, maxLength: HAPPY_AUTHORIZATION_TOKEN_MAX_LENGTH }),
    }),
]);

type HappyAuthResponse = typeof happyAuthResponseSchema.static;

export type HappyPairingErrorCode =
    | "authorization_expired"
    | "cancelled"
    | "happy_unavailable"
    | "invalid_response";

/** A pairing failure safe for the owning module to project into public state. */
export class HappyPairingError extends Error {
    readonly code: HappyPairingErrorCode;

    constructor(code: HappyPairingErrorCode, message: string) {
        super(message);
        this.name = "HappyPairingError";
        this.code = code;
    }
}

export interface HappyPairingOptions {
    readonly fetch?: typeof fetch;
    readonly expiresInMs?: number;
    readonly now?: () => number;
    readonly pollIntervalMs?: number;
    readonly randomBytes?: (size: number) => Uint8Array;
    readonly requestTimeoutMs?: number;
    readonly serverUrl: string;
    readonly version: string;
}

/** One ephemeral phone-authorization attempt. */
export class HappyPairing {
    readonly authorization: {
        readonly data: string;
        readonly expiresAt: number;
        readonly kind: "qr";
    };
    readonly result: Promise<StoredHappyCredentials>;

    readonly #controller = new AbortController();
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    readonly #pollIntervalMs: number;
    readonly #publicKeyBase64: string;
    readonly #randomBytes: (size: number) => Uint8Array;
    readonly #requestTimeoutMs: number;
    readonly #secretKey: Uint8Array;
    readonly #serverUrl: string;
    readonly #version: string;
    readonly #resolve: (credentials: StoredHappyCredentials) => void;
    readonly #reject: (error: HappyPairingError) => void;
    #settled = false;

    private constructor(
        options: HappyPairingOptions,
        keyPair: { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array },
    ) {
        this.#fetch = options.fetch ?? fetch;
        this.#now = options.now ?? Date.now;
        this.#pollIntervalMs = options.pollIntervalMs ?? HAPPY_PAIRING_POLL_INTERVAL_MS;
        this.#randomBytes = options.randomBytes ?? ((size) => new Uint8Array(randomBytes(size)));
        this.#requestTimeoutMs = options.requestTimeoutMs ?? HAPPY_PAIRING_REQUEST_TIMEOUT_MS;
        this.#secretKey = keyPair.secretKey;
        this.#serverUrl = options.serverUrl.replace(/\/+$/u, "");
        this.#version = options.version;
        this.#publicKeyBase64 = Buffer.from(keyPair.publicKey).toString("base64");
        this.authorization = {
            data: `happy://terminal?${Buffer.from(keyPair.publicKey).toString("base64url")}`,
            expiresAt: this.#now() + (options.expiresInMs ?? HAPPY_PAIRING_LIFETIME_MS),
            kind: "qr",
        };
        let resolve!: (credentials: StoredHappyCredentials) => void;
        let reject!: (error: HappyPairingError) => void;
        this.result = new Promise<StoredHappyCredentials>((resultResolve, resultReject) => {
            resolve = resultResolve;
            reject = resultReject;
        });
        this.#resolve = resolve;
        this.#reject = reject;
    }

    /** Creates the server-side request before exposing a QR code that cannot work. */
    static async start(options: HappyPairingOptions): Promise<HappyPairing> {
        const random = options.randomBytes ?? ((size: number) => new Uint8Array(randomBytes(size)));
        const secretKey = random(32);
        if (secretKey.byteLength !== 32) {
            secretKey.fill(0);
            throw new Error("Happy pairing randomness must return exactly 32 bytes.");
        }
        const keyPair = nobleBoxKeyPairFromSecretKey(secretKey);
        secretKey.fill(0);
        const pairing = new HappyPairing(options, keyPair);
        try {
            const response = await pairing.#request();
            void pairing.#run(response);
            return pairing;
        } catch (error: unknown) {
            pairing.#secretKey.fill(0);
            if (error instanceof HappyPairingError) throw error;
            throw new HappyPairingError(
                "happy_unavailable",
                "Happy is unavailable. Please try again.",
            );
        }
    }

    /** Cancels this process-local attempt and erases its ephemeral secret. */
    close(): void {
        if (this.#settled) return;
        this.#controller.abort();
        this.#finishError(new HappyPairingError("cancelled", "Happy pairing was cancelled."));
    }

    async #run(initial: HappyAuthResponse): Promise<void> {
        let response = initial;
        try {
            while (!this.#settled) {
                this.#throwIfExpired();
                if (response.state === "authorized") {
                    this.#finish(this.#credentials(response));
                    return;
                }
                await wait(
                    Math.min(
                        this.#pollIntervalMs,
                        Math.max(0, this.authorization.expiresAt - this.#now()),
                    ),
                    this.#controller.signal,
                );
                response = await this.#request();
            }
        } catch (error: unknown) {
            if (error instanceof HappyPairingError) {
                this.#finishError(error);
            } else if (this.#controller.signal.aborted) {
                this.#finishError(
                    new HappyPairingError("cancelled", "Happy pairing was cancelled."),
                );
            } else {
                this.#finishError(
                    new HappyPairingError(
                        "happy_unavailable",
                        "Happy is unavailable. Please try again.",
                    ),
                );
            }
        }
    }

    async #request(): Promise<HappyAuthResponse> {
        const remainingLifetimeMs = this.authorization.expiresAt - this.#now();
        if (remainingLifetimeMs <= 0) throw this.#expired();
        const deadlineBoundsRequest = remainingLifetimeMs <= this.#requestTimeoutMs;
        const timeoutSignal = AbortSignal.timeout(
            Math.max(0, Math.ceil(Math.min(this.#requestTimeoutMs, remainingLifetimeMs))),
        );
        let response: Response;
        try {
            response = await this.#fetch(`${this.#serverUrl}/v1/auth/request`, {
                body: JSON.stringify({ publicKey: this.#publicKeyBase64, supportsV2: true }),
                headers: {
                    "Content-Type": "application/json",
                    "X-Happy-Client": `rig-daemon/${this.#version}`,
                },
                method: "POST",
                signal: AbortSignal.any([this.#controller.signal, timeoutSignal]),
            });
        } catch {
            throw this.#requestFailure(timeoutSignal, deadlineBoundsRequest);
        }
        this.#throwIfExpired();
        if (!response.ok) {
            throw new HappyPairingError(
                "happy_unavailable",
                "Happy is unavailable. Please try again.",
            );
        }
        let body: unknown;
        try {
            body = await readBoundedJson(response);
        } catch {
            const interruption = this.#requestInterruption(timeoutSignal, deadlineBoundsRequest);
            if (interruption !== undefined) throw interruption;
            throw new HappyPairingError(
                "invalid_response",
                "Happy returned an authorization response Happy Agent could not read.",
            );
        }
        this.#throwIfExpired();
        if (!Value.Check(happyAuthResponseSchema, body)) {
            throw new HappyPairingError(
                "invalid_response",
                "Happy returned an authorization response Happy Agent could not read.",
            );
        }
        return body;
    }

    #throwIfExpired(): void {
        if (this.#now() >= this.authorization.expiresAt) throw this.#expired();
    }

    #expired(): HappyPairingError {
        return new HappyPairingError(
            "authorization_expired",
            "Happy authorization expired. Start again to show a new QR code.",
        );
    }

    #requestFailure(timeoutSignal: AbortSignal, deadlineBoundsRequest: boolean): HappyPairingError {
        return (
            this.#requestInterruption(timeoutSignal, deadlineBoundsRequest) ??
            new HappyPairingError("happy_unavailable", "Happy is unavailable. Please try again.")
        );
    }

    #requestInterruption(
        timeoutSignal: AbortSignal,
        deadlineBoundsRequest: boolean,
    ): HappyPairingError | undefined {
        if (this.#controller.signal.aborted) {
            return new HappyPairingError("cancelled", "Happy pairing was cancelled.");
        }
        if (timeoutSignal.aborted) {
            return deadlineBoundsRequest
                ? this.#expired()
                : new HappyPairingError(
                      "happy_unavailable",
                      "Happy is unavailable. Please try again.",
                  );
        }
        return undefined;
    }

    #credentials(
        response: Extract<HappyAuthResponse, { state: "authorized" }>,
    ): StoredHappyCredentials {
        const bundle = decodeBase64(response.response);
        const decrypted = decryptHappyAuthBundle(bundle, this.#secretKey);
        if (decrypted === undefined) {
            throw new HappyPairingError(
                "invalid_response",
                "Happy returned authorization data Happy Agent could not decrypt.",
            );
        }
        try {
            if (decrypted.byteLength === 32) {
                return { secret: Buffer.from(decrypted).toString("base64"), token: response.token };
            }
            if (decrypted.byteLength === 33 && decrypted[0] === 0) {
                const machineKey = this.#randomBytes(32);
                if (machineKey.byteLength !== 32) {
                    machineKey.fill(0);
                    throw new Error("Happy pairing randomness must return exactly 32 bytes.");
                }
                try {
                    return {
                        encryption: {
                            machineKey: Buffer.from(machineKey).toString("base64"),
                            publicKey: Buffer.from(decrypted.slice(1)).toString("base64"),
                        },
                        token: response.token,
                    };
                } finally {
                    machineKey.fill(0);
                }
            }
            throw new HappyPairingError(
                "invalid_response",
                "Happy returned authorization data in an unsupported format.",
            );
        } finally {
            decrypted.fill(0);
        }
    }

    #finish(credentials: StoredHappyCredentials): void {
        if (this.#settled) return;
        this.#settled = true;
        this.#secretKey.fill(0);
        this.#resolve(credentials);
    }

    #finishError(error: HappyPairingError): void {
        if (this.#settled) return;
        this.#settled = true;
        this.#secretKey.fill(0);
        this.#reject(error);
    }
}

function decodeBase64(value: string): Uint8Array {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength === 0 || decoded.toString("base64") !== value) {
        throw new HappyPairingError(
            "invalid_response",
            "Happy returned authorization data Happy Agent could not decode.",
        );
    }
    return new Uint8Array(decoded);
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(
            () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            },
            Math.max(0, milliseconds),
        );
        timer.unref();
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function readBoundedJson(response: Response): Promise<unknown> {
    if (response.body === null) return JSON.parse(await response.text()) as unknown;
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > HAPPY_PAIRING_RESPONSE_MAX_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw new Error("The Happy authorization response is too large.");
            }
            chunks.push(Buffer.from(next.value));
        }
    } finally {
        reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}
