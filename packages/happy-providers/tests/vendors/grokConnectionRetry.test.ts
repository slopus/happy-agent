import { testContext } from "../testContext.js";

import { createServer } from "node:http";

import { expect, it, vi } from "vitest";

import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { GrokConnection } from "@/vendors/grok/impl/GrokConnection.js";
import { collectSessionEvents } from "../helpers/collectSessionEvents.js";

vi.mock("@/vendors/grok/impl/grokRetry.js", async (importOriginal) => ({
    ...(await importOriginal()),
    delayBeforeGrokRetry: () => Promise.resolve(),
}));

it("retries a pre-output Grok failure after requesting an HTTP/1 rebuild", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
        request.resume();
        request.once("end", () => {
            requests += 1;
            if (requests === 1) {
                request.socket.destroy();
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                'data: {"type":"response.completed","response":{"id":"response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
            );
        });
    });
    await new Promise<void>((resolve, reject) =>
        server.listen(0, "127.0.0.1", resolve).once("error", reject),
    );
    const address = server.address();
    if (address === null || typeof address === "string") expect.fail("Missing server port.");
    const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "grok-retry-key" });
    if (credential === null) throw new Error("Expected a Grok test credential.");
    const provider = new GrokProvider({
        credential,
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        inferenceMaxRetries: 1,
        model: "grok-4.5",
    });
    const session = await provider.session("connection-retry-session", {
        instructions: "",
        tools: [],
    });
    const rebuild = vi.spyOn(GrokConnection.prototype, "rebuild");

    try {
        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: "Recover this request." }],
                        },
                    ],
                },
            }),
        );

        expect(requests).toBe(2);
        expect(rebuild).toHaveBeenCalledOnce();
        expect(rebuild).toHaveBeenCalledWith(true);
        expect(events).toContainEqual(expect.objectContaining({ type: "retrying", attempt: 1 }));
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    } finally {
        rebuild.mockRestore();
        session.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
