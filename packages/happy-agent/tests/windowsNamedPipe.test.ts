import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { createRootContext } from "@steve.kite/stdlib";
import type { PreparedHappyAgentRuntime } from "@slopus/happy-agent-modules";
import { describe, expect, it } from "vitest";
import { bindNodeAgentSocket, removeInactiveAgentSocket } from "../sources/socket/AgentSocket.js";

describe.skipIf(process.platform !== "win32")("Windows local daemon transport", () => {
    it("serves HTTP over a named pipe, refuses a duplicate listener, and releases the pipe", async () => {
        const socketPath = `\\\\.\\pipe\\happy-test-${randomUUID()}`;
        const prepared = {
            context: () => createRootContext(),
            api: {
                handleRequest: async (
                    _ctx: unknown,
                    _request: unknown,
                    response: import("node:http").ServerResponse,
                ) => {
                    response.end("ready");
                },
            },
        } as unknown as PreparedHappyAgentRuntime;
        const server = await bindNodeAgentSocket(prepared, socketPath);
        try {
            const body = await new Promise<string>((resolve, reject) => {
                request({ socketPath, path: "/", agent: false }, (response) => {
                    let text = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk) => (text += chunk));
                    response.on("end", () => resolve(text));
                })
                    .on("error", reject)
                    .end();
            });
            expect(body).toBe("ready");
            await expect(bindNodeAgentSocket(prepared, socketPath)).rejects.toThrow();
        } finally {
            await server.close();
        }
        await removeInactiveAgentSocket(socketPath);
        const replacement = await bindNodeAgentSocket(prepared, socketPath);
        await replacement.close();
    });
});
