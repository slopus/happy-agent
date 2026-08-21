import { afterEach, describe, expect, it, vi } from "vitest";

import { createTerminalInputBurstHandler } from "./createTerminalInputBurstHandler.js";

describe("createTerminalInputBurstHandler", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("coalesces a raw multiline Unicode write before forwarding Enter", () => {
        vi.useFakeTimers();
        const received: string[] = [];
        const handler = createTerminalInputBurstHandler((data) => received.push(data));
        const message = "first  line\n\t日本語 👩🏽‍💻 e\u0301\nlast line";

        for (const codeUnit of message.split("")) handler.handle(codeUnit);

        expect(received).toEqual([]);
        handler.handle("\r");
        expect(received).toEqual([message, "\r"]);
    });

    it("forwards ordinary typing after a short burst window", () => {
        vi.useFakeTimers();
        const received: string[] = [];
        const handler = createTerminalInputBurstHandler((data) => received.push(data));

        handler.handle("a");
        expect(received).toEqual([]);
        vi.advanceTimersByTime(8);

        expect(received).toEqual(["a"]);
    });

    it("flushes pending text before forwarding an escape sequence", () => {
        vi.useFakeTimers();
        const received: string[] = [];
        const handler = createTerminalInputBurstHandler((data) => received.push(data));

        handler.handle("text");
        handler.handle("\x1b[A");

        expect(received).toEqual(["text", "\x1b[A"]);
    });

    it("forwards coalesced Escape presses individually", () => {
        vi.useFakeTimers();
        const received: string[] = [];
        const handler = createTerminalInputBurstHandler((data) => received.push(data));

        handler.handle("\x1b\x1b");

        expect(received).toEqual(["\x1b", "\x1b"]);
    });

    it("forwards separately delivered Escape presses without buffering", () => {
        const received: string[] = [];
        const handler = createTerminalInputBurstHandler((data) => received.push(data));

        handler.handle("\x1b");
        handler.handle("\x1b");

        expect(received).toEqual(["\x1b", "\x1b"]);
    });

    it("separates Escape from immediately coalesced ordinary typing", () => {
        vi.useFakeTimers();
        const received: string[] = [];
        const handler = createTerminalInputBurstHandler((data) => received.push(data));

        handler.handle("\x1bR");
        handler.handle("etain this follow-up");
        handler.handle("\r");

        expect(received).toEqual(["\x1b", "Retain this follow-up", "\r"]);
    });

    it("preserves supported Alt shortcuts and terminal escape sequences", () => {
        const received: string[] = [];
        const handler = createTerminalInputBurstHandler((data) => received.push(data));

        handler.handle("\x1bm");
        handler.handle("\x1b[A");

        expect(received).toEqual(["\x1bm", "\x1b[A"]);
    });
});
