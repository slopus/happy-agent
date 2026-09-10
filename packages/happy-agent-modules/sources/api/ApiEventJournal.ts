import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { createUuidV7Factory, eventIdSchema } from "../events/index.js";

const apiEventTypeSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
});

export const apiEventSchema = Type.Object(
    {
        cursor: eventIdSchema,
        occurredAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        payload: Type.Unknown(),
        type: apiEventTypeSchema,
    },
    { additionalProperties: false },
);

export const apiEventPageSchema = Type.Object(
    {
        cursor: eventIdSchema,
        events: Type.Array(apiEventSchema),
        latestCursor: eventIdSchema,
    },
    { additionalProperties: false },
);

export type ApiEvent = Static<typeof apiEventSchema>;
export type ApiEventPage = Static<typeof apiEventPageSchema>;
export type ApiEventListener = (event: ApiEvent) => void;

export const DEFAULT_API_EVENT_CAPACITY = 10_000;

/**
 * The bounded journal exposed by the HTTP API.
 *
 * Feature modules do not share a wire vocabulary. This queue is the single conversion boundary:
 * subscribers append the API event they mean, and clients only ever see this vocabulary.
 */
export class ApiEventJournal {
    readonly #capacity: number;
    readonly #events: ApiEvent[] = [];
    readonly #listeners = new Set<ApiEventListener>();
    readonly #owners = new WeakMap<ApiEvent, string>();
    readonly #createCursor: () => string;
    #originCursor: string;

    constructor(capacity = DEFAULT_API_EVENT_CAPACITY, now: () => number = Date.now) {
        if (!Number.isSafeInteger(capacity) || capacity < 1) {
            throw new Error("The API event capacity must be a positive safe integer.");
        }
        this.#capacity = capacity;
        this.#createCursor = createUuidV7Factory(now);
        this.#originCursor = this.#createCursor();
    }

    cursor(): string {
        return this.#events.at(-1)?.cursor ?? this.#originCursor;
    }

    oldestCursor(): string {
        return this.#events.at(0)?.cursor ?? this.#originCursor;
    }

    append(type: string, payload: unknown, occurredAt = Date.now(), ownerId?: string): ApiEvent {
        const event: ApiEvent = Object.freeze({
            cursor: this.#createCursor(),
            occurredAt: Math.max(0, Math.trunc(occurredAt)),
            payload: immutableClone(payload),
            type,
        });
        if (!Value.Check(apiEventSchema, event)) {
            throw new Error("The converted API event is invalid.");
        }
        if (ownerId !== undefined) this.#owners.set(event, ownerId);
        this.#events.push(event);
        if (this.#events.length > this.#capacity) {
            const removed = this.#events.shift();
            if (removed !== undefined) this.#originCursor = removed.cursor;
        }
        for (const listener of [...this.#listeners]) listener(event);
        return event;
    }

    /** Owner metadata is bounded by retained events and never enters the wire envelope. */
    visibleTo(event: ApiEvent, userId: string | undefined): boolean {
        const owner = this.#owners.get(event);
        if (owner !== undefined) return owner === userId;
        // An unowned mobile snapshot belongs to standalone mode, never to a team member.
        return event.type !== "happy.integration.updated" || userId === undefined;
    }

    /**
     * Read oldest-first. `undefined` means a supplied cursor is no longer available.
     *
     * Omitting `after` starts at the oldest retained event, as the HTTP contract requires.
     */
    replay(
        after: string | undefined,
        until: string | undefined,
        limit: number,
    ): ApiEventPage | undefined {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#capacity) {
            throw new Error("The API event limit is outside the journal bounds.");
        }
        let start = 0;
        if (after !== undefined) {
            if (after === this.#originCursor) {
                start = 0;
            } else {
                const index = this.#events.findIndex((event) => event.cursor === after);
                if (index < 0) return undefined;
                start = index + 1;
            }
        }
        let end = this.#events.length;
        if (until !== undefined) {
            if (until === this.#originCursor) {
                end = 0;
            } else {
                const index = this.#events.findIndex((event) => event.cursor === until);
                if (index < 0) return undefined;
                end = index + 1;
            }
        }
        const events = this.#events.slice(start, Math.min(end, start + limit));
        return {
            cursor: events.at(-1)?.cursor ?? after ?? this.#originCursor,
            events: [...events],
            latestCursor: this.cursor(),
        };
    }

    hasCursor(cursor: string): boolean {
        return (
            cursor === this.#originCursor || this.#events.some((event) => event.cursor === cursor)
        );
    }

    subscribe(listener: ApiEventListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }
}

function immutableClone<Value>(value: Value): Value {
    return deepFreeze(structuredClone(value), new WeakSet<object>());
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object>): Value {
    if (value === null || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && "value" in descriptor) {
            deepFreeze(descriptor.value, seen);
        }
    }
    return Object.freeze(value);
}
