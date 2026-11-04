/** One dispatched server-sent event. `event` is absent for the default message type. */
export interface ServerSentEvent {
    readonly event?: string;
    readonly data: string;
}

/**
 * Decodes a `text/event-stream` body with the WHATWG rules: LF, CRLF, and lone CR end lines, even
 * when a terminator is split across network reads; comments are ignored; repeated `data:` fields
 * join with newlines; and an event without data is not dispatched.
 *
 * Bytes are read with `getReader().read()` and decoded before the next read. The OpenAI SDK reads
 * through the stream's async iterator instead; on Bun for Windows that path was observed to drop
 * intermediate events when a gateway's response arrived in a few coalesced reads, while a plain
 * reader loop over the same response received every event.
 *
 * The specification discards an event still pending when the body ends. Gateways and proxies close
 * after a final `data:` line without the blank line, so that event is dispatched instead.
 */
export async function* readServerSentEvents(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let skipLineFeed = false;
    let event: string | undefined;
    let data: string[] = [];

    function* lines(text: string, end: boolean): Generator<string> {
        buffer += text;
        let start = 0;
        for (let index = 0; index < buffer.length; index++) {
            const code = buffer.charCodeAt(index);
            if (code !== 10 && code !== 13) {
                skipLineFeed = false;
                continue;
            }
            if (code === 10 && skipLineFeed) {
                skipLineFeed = false;
                start = index + 1;
                continue;
            }
            skipLineFeed = code === 13;
            yield buffer.slice(start, index);
            start = index + 1;
        }
        buffer = buffer.slice(start);
        if (end && buffer !== "") {
            yield buffer;
            buffer = "";
        }
    }

    function* dispatch(line: string): Generator<ServerSentEvent> {
        if (line === "") {
            if (data.length > 0)
                yield { ...(event === undefined ? {} : { event }), data: data.join("\n") };
            event = undefined;
            data = [];
            return;
        }
        if (line.startsWith(":")) return;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
    }

    try {
        for (;;) {
            const { done, value } = await reader.read();
            const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
            for (const line of lines(text, done)) yield* dispatch(line);
            if (done) break;
        }
        yield* dispatch("");
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
