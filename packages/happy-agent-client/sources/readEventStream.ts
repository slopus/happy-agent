import type { EventStreamFrame, EventStreamHello, HappyAgentEvent } from "./protocol/events.js";
import type {
    SurfaceDocumentPresenceFrame,
    SurfaceDocumentUpdateFrame,
} from "./protocol/surfaces.js";
import type { ViewersUpdatedFrame } from "./protocol/viewers.js";
import { readSseFrames } from "./readSseFrames.js";

/** The stream said something this client cannot read as the documented contract. */
export class EventStreamProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EventStreamProtocolError";
    }
}

/**
 * Turns the event stream's bytes into typed frames.
 *
 * The stream opens with a `hello` frame naming the position it continues from
 * and whether the requested cursor survived the journal window; after it, every
 * frame is one event, its SSE `id:` carrying the event's cursor and its
 * `event:` carrying the event's type.
 *
 * Nothing is validated beyond what the framing itself proves: like every
 * response this client reads, a parsed envelope is trusted to be what the
 * specification says the daemon sends.
 */
export async function* readEventStream(
    body: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<EventStreamFrame> {
    for await (const frame of readSseFrames(body)) {
        const data = parseJson(frame.data);
        if (frame.name === "hello") {
            yield { kind: "hello", hello: data as EventStreamHello };
            continue;
        }
        // Live document frames reach only subscribed streams and carry no cursor by design.
        if (frame.name === "document.update") {
            yield {
                kind: "document",
                frame: { type: "document.update", data: data as SurfaceDocumentUpdateFrame },
            };
            continue;
        }
        if (frame.name === "document.presence") {
            yield {
                kind: "document",
                frame: { type: "document.presence", data: data as SurfaceDocumentPresenceFrame },
            };
            continue;
        }
        // Viewer frames reach only streams that said they view the target, and carry no cursor.
        if (frame.name === "viewers.updated") {
            yield { kind: "viewers", frame: data as ViewersUpdatedFrame };
            continue;
        }
        const event = data as HappyAgentEvent;
        // The envelope carries the cursor, and the SSE `id:` line repeats it for
        // `Last-Event-ID`. Either one is the position; prefer the envelope's.
        const cursor = typeof event.cursor === "string" ? event.cursor : frame.id;
        if (cursor === undefined) {
            throw new EventStreamProtocolError("An event arrived without a cursor.");
        }
        yield { kind: "event", event, cursor };
    }
}

function parseJson(data: string): unknown {
    try {
        return JSON.parse(data);
    } catch {
        throw new EventStreamProtocolError("An event frame did not carry JSON.");
    }
}
