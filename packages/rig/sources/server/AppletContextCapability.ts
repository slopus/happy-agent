import { randomBytes } from "node:crypto";

import { Value } from "@sinclair/typebox/value";

import {
    appletContextSchema,
    type AppletContext,
    type ResolveAppletOpenRequest,
} from "../protocol/AppletProtocol.js";

export const APPLET_CONTEXT_QUERY_PARAMETER = "rigContext";
const APPLET_CONTEXT_TOKEN_TTL_MS = 5 * 60 * 1_000;
const APPLET_CONTEXT_TOKEN_CAP = 1_024;

type OutstandingAppletContext = {
    context: AppletContext;
    expiresAt: number;
};

/** Short-lived, single-use bearer capabilities for hosted applet launch context. */
export class AppletContextTokenStore {
    readonly #outstanding = new Map<string, OutstandingAppletContext>();
    readonly #now: () => number;
    readonly #randomToken: () => string;

    constructor(
        readonly options: {
            cap?: number;
            now?: () => number;
            randomToken?: () => string;
            ttlMs?: number;
        } = {},
    ) {
        this.#now = options.now ?? Date.now;
        this.#randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    }

    mint(context: AppletContext): string {
        if (!Value.Check(appletContextSchema, context)) {
            throw new Error("The applet context is invalid.");
        }
        const now = this.#now();
        for (const [token, outstanding] of this.#outstanding) {
            if (now >= outstanding.expiresAt) this.#outstanding.delete(token);
        }
        while (this.#outstanding.size >= (this.options.cap ?? APPLET_CONTEXT_TOKEN_CAP)) {
            const oldest = this.#outstanding.keys().next().value;
            if (oldest === undefined) break;
            this.#outstanding.delete(oldest);
        }
        let token = this.#randomToken();
        while (this.#outstanding.has(token)) token = this.#randomToken();
        this.#outstanding.set(token, {
            context,
            expiresAt: now + (this.options.ttlMs ?? APPLET_CONTEXT_TOKEN_TTL_MS),
        });
        return token;
    }

    exchange(applet: string, token: string): AppletContext | undefined {
        const outstanding = this.#outstanding.get(token);
        if (outstanding === undefined) return undefined;
        if (this.#now() >= outstanding.expiresAt) {
            this.#outstanding.delete(token);
            return undefined;
        }
        if (outstanding.context.applet !== applet) return undefined;
        this.#outstanding.delete(token);
        return outstanding.context;
    }
}

export function resolveAppletOpenUrl(
    applet: string,
    request: ResolveAppletOpenRequest,
    context: AppletContext,
    tokens: AppletContextTokenStore,
): string {
    const segments = (request.path ?? "")
        .split("/")
        .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
        .map(encodeURIComponent);
    const parameters = new URLSearchParams(request.query);
    parameters.set(APPLET_CONTEXT_QUERY_PARAMETER, tokens.mint(context));
    return `/applets/${encodeURIComponent(applet)}/files/${segments.join("/")}?${parameters.toString()}`;
}