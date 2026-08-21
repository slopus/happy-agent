import { describe, expect, it } from "vitest";

import { runClipboardCommand } from "./runClipboardCommand.js";

describe("runClipboardCommand", () => {
    it("does not block the event loop while waiting for clipboard output", async () => {
        const order: string[] = [];
        const eventLoopTurn = new Promise<void>((resolve) => {
            setImmediate(() => {
                order.push("event loop");
                resolve();
            });
        });
        const command = runClipboardCommand(
            process.execPath,
            ["-e", 'setTimeout(() => process.stdout.write("image"), 100)'],
            { maxBufferBytes: 1_024, timeoutMs: 1_000 },
        ).then((result) => {
            order.push("command");
            return result;
        });

        await Promise.all([eventLoopTurn, command]);

        expect(order).toEqual(["event loop", "command"]);
        await expect(command).resolves.toMatchObject({ ok: true, stdout: Buffer.from("image") });
    });
});
