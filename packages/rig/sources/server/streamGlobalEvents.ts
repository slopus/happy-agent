import type { IncomingMessage, ServerResponse } from "node:http";

import type {
    GlobalEventDelivery,
    GlobalEventQueueEntry,
    GlobalLiveEvent,
} from "../protocol/index.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import { parseGlobalEventCursor } from "../global-event/parseGlobalEventCursor.js";
import { sendJson } from "./sendJson.js";
import { writeGlobalSseEvent } from "./writeGlobalSseEvent.js";

/**
 * The durable event log, streamed to the external service that mirrors it.
 *
 * A fresh mirror receives the retained stored log; a known mirror resumes from
 * its cursor. Live events published while it is attached follow too, but current
 * live snapshots are not replayed. Projects, workspaces, sessions, the model
 * catalog and the daemon identity are entities loaded through request-response.
 */
export async function streamGlobalEvents(
    request: IncomingMessage,
    response: ServerResponse,
    queue: GlobalEventQueue,
    afterValue: string | null,
): Promise<void> {
    const lastEventId = request.headers["last-event-id"];
    const cursorValue = Array.isArray(lastEventId) ? lastEventId.at(-1) : lastEventId;
    const selectedValue = cursorValue ?? afterValue;
    const after = parseGlobalEventCursor(selectedValue ?? null);
    if (selectedValue !== undefined && selectedValue !== null && after === undefined) {
        sendJson(response, 400, { error: "The event cursor is invalid." });
        return;
    }

    let closed = false;
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    // Live state is coalesced by entity whenever replay or socket backpressure delays delivery.
    // Stored events are never coalesced; the bounded pending list instead disconnects a mirror
    // whose live tail grows faster than its historical catch-up can advance.
    const pendingLive = new Map<string, GlobalLiveEvent>();
    const pendingStored: GlobalEventQueueEntry[] = [];
    let replaying = true;
    let backedUp = false;
    const flushLive = () => {
        // Without this guard a drain arriving after close would write to an ended response, which
        // surfaces as an uncaught daemon exception. Today only a Node internal prevents it.
        if (closed) return;
        backedUp = false;
        // Copied first because the loop deletes from the map it iterates.
        for (const [key, event] of Array.from(pendingLive)) {
            pendingLive.delete(key);
            if (!writeGlobalSseEvent(response, { event, live: true })) {
                backedUp = true;
                break;
            }
        }
    };
    const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
        response.off("drain", flushLive);
        pendingLive.clear();
        pendingStored.length = 0;
        response.end();
    };

    const deliver = (delivery: GlobalEventDelivery) => {
        if (closed) return;
        if ("live" in delivery) {
            const key = liveEventKey(delivery.event);
            if (backedUp) {
                pendingLive.set(key, delivery.event);
                if (response.writableLength > SUBSCRIBER_BUFFER_LIMIT) close();
                return;
            }
            backedUp = !writeGlobalSseEvent(response, delivery);
            return;
        }
        // Stored events are never coalesced or dropped, so a subscriber that cannot keep up with
        // them is disconnected and resumes from its own cursor instead of growing the buffer
        // without bound.
        if (!writeGlobalSseEvent(response, delivery)) backedUp = true;
        if (response.writableLength > SUBSCRIBER_BUFFER_LIMIT) close();
    };

    // Subscribe before reading the first page. Once replay yields between pages, new stored events
    // can arrive; buffering them here and discarding cursors replay already covered closes that gap.
    unsubscribe = queue.subscribe((delivery) => {
        if (!replaying) {
            deliver(delivery);
            return;
        }
        if ("live" in delivery) {
            pendingLive.set(liveEventKey(delivery.event), delivery.event);
            return;
        }
        if (pendingStored.length >= CATCHUP_PENDING_LIMIT) {
            close();
            return;
        }
        pendingStored.push(delivery);
    }, close);

    request.on("close", close);
    let catchup = queue.list({
        ...(after === undefined ? {} : { after }),
        limit: CATCHUP_PAGE_LIMIT,
    });
    if (catchup === undefined) {
        closed = true;
        unsubscribe();
        request.off("close", close);
        sendJson(response, 409, { error: "The global event cursor is not available." });
        return;
    }
    if (closed) return;

    response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    response.on("drain", flushLive);
    heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    heartbeat.unref?.();

    let lastReplayedCursor = after;
    for (;;) {
        for (const entry of catchup) {
            writeGlobalSseEvent(response, entry);
            lastReplayedCursor = entry.cursor;
        }
        if (closed || response.writableLength > SUBSCRIBER_BUFFER_LIMIT) {
            close();
            return;
        }
        if (catchup.length < CATCHUP_PAGE_LIMIT) break;
        const nextCursor = catchup.at(-1)?.cursor;
        if (nextCursor === undefined) break;

        // SQLite and SSE writes are synchronous. Yielding once per page keeps a large retained log
        // from monopolizing the daemon while preserving the ordered cursor walk.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (closed) return;
        const next = queue.list({ after: nextCursor, limit: CATCHUP_PAGE_LIMIT });
        if (next === undefined) {
            close();
            return;
        }
        catchup = next;
    }

    // No await occurs while switching from replay to live delivery. Anything the paged database
    // walk already saw is discarded; the rest is delivered in subscription order.
    for (const entry of pendingStored) {
        if (lastReplayedCursor === undefined || entry.cursor > lastReplayedCursor) deliver(entry);
    }
    pendingStored.length = 0;
    replaying = false;
    if (!backedUp) flushLive();
}

/**
 * Bytes Node may hold for one subscriber before it is treated as stuck. Counting pending entities
 * instead would be unreachable in practice, because the tracker holds fewer entities than any
 * sensible entity cap, while the socket buffer is what actually grows.
 */
const SUBSCRIBER_BUFFER_LIMIT = 1024 * 1024;
const CATCHUP_PAGE_LIMIT = 1_000;
const CATCHUP_PENDING_LIMIT = 1_000;

function liveEventKey(event: GlobalLiveEvent): string {
    // These events describe daemon-wide state, so each coalesces on its type alone.
    if (
        event.type === "presence_changed" ||
        event.type === "happy_cloud_changed" ||
        event.type === "p2p_status_changed" ||
        event.type === "plugins_changed" ||
        event.type === "slots_changed" ||
        event.type === "webapps_changed"
    ) {
        return event.type;
    }
    if (event.type === "session_share_capabilities_changed") {
        return `${event.type}:member:${event.data.shareMemberId}`;
    }
    if ("sessionId" in event) return `${event.type}:session:${event.sessionId}`;
    const scope =
        "workspaceId" in event ? `workspace:${event.workspaceId}` : `project:${event.projectId}`;
    return `${event.type}:${scope}`;
}
