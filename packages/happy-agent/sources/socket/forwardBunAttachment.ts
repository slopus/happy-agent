import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { PreparedHappyAgentRuntime } from "@slopus/happy-agent-modules";

/** Adapt a native raw attachment without losing the caller's authentication headers. */
export async function forwardBunAttachment(
    prepared: PreparedHappyAgentRuntime,
    head: { method: string; target: string; headers: Record<string, string | string[]> },
    stream: Duplex,
    bytes: Buffer,
): Promise<void> {
    const request = new IncomingMessage(new Socket());
    request.method = head.method;
    request.url = head.target;
    request.headers = head.headers;
    request.complete = true;
    try {
        const ctx = prepared.context("bun-authenticated-attachment");
        if (await prepared.api.handleRemoteAttachment(ctx, request, stream, bytes)) return;
        if (await prepared.api.handleServiceAttachment(ctx, request, stream, bytes)) return;
        stream.destroy();
    } finally {
        request.destroy();
    }
}
