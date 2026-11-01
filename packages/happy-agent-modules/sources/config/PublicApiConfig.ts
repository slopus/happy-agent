import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const publicUrlInputSchema = Type.String({ minLength: 1, maxLength: 2048 });

export class PublicApiConfigError extends Error {
    constructor() {
        super(
            "The public API endpoint must be an HTTPS origin or hostname, without credentials, a path, query, or fragment.",
        );
    }
}

/** Canonical origin shared by machine settings and the runtime mutation. */
export function normalizePublicApiUrl(input: string): string {
    if (!Value.Check(publicUrlInputSchema, input)) throw new PublicApiConfigError();
    const text = input.trim();
    const absolute = text.includes("://") ? text : `https://${text}`;
    if (!/^https:\/\/[^\s\u0000-\u001f\u007f/@?#\\]+\/?$/iu.test(absolute)) {
        throw new PublicApiConfigError();
    }
    try {
        const url = new URL(absolute);
        if (
            url.protocol !== "https:" ||
            !url.hostname ||
            url.port === "0" ||
            !Value.Check(publicUrlInputSchema, url.origin)
        ) {
            throw new PublicApiConfigError();
        }
        return url.origin;
    } catch {
        throw new PublicApiConfigError();
    }
}
