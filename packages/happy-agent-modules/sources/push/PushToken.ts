const PUSH_TOKEN_PATTERN = /^HappyPushToken\[[A-Za-z0-9]{22}\]$/u;
const REDACTED = "HappyPushToken[redacted]";

/**
 * The capability Happy's push relay gives a phone for its native token. Whoever holds the text can
 * send to that phone, so the text lives in a private field: a token interpolated into a string,
 * serialized as JSON, or handed to a logger prints as redacted. Only `expose()` returns it, for the
 * stored registration and the relay request.
 */
export class PushToken {
    readonly #value: string;

    private constructor(value: string) {
        this.#value = value;
    }

    /** The token for text a phone or the database supplied, or `undefined` when it is not one. */
    static parse(value: unknown): PushToken | undefined {
        return typeof value === "string" && PUSH_TOKEN_PATTERN.test(value)
            ? new PushToken(value)
            : undefined;
    }

    expose(): string {
        return this.#value;
    }

    toString(): string {
        return REDACTED;
    }

    toJSON(): string {
        return REDACTED;
    }

    [Symbol.for("nodejs.util.inspect.custom")](): string {
        return REDACTED;
    }
}
