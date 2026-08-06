import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";

describe("Codex ChatGPT unauthorized recovery", () => {
    it("reloads once, refreshes once, persists tokens, and retries SSE", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-codex-auth-recovery-"));
        const authFile = join(directory, "auth.json");
        await writeFile(
            authFile,
            JSON.stringify({
                tokens: {
                    access_token: "stale-access",
                    refresh_token: "stale-refresh",
                    account_id: "account-1",
                },
            }),
        );

        const inferenceTokens: string[] = [];
        let refreshRequests = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain request input before responding.
            }
            if (request.url === "/oauth/token") {
                refreshRequests += 1;
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        access_token: "fresh-access",
                        refresh_token: "fresh-refresh",
                    }),
                );
                return;
            }

            inferenceTokens.push(request.headers.authorization ?? "");
            if (inferenceTokens.length < 3) {
                response.writeHead(401, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "expired" } }));
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                'data: {"type":"response.completed","response":{"id":"response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
            );
        });
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        try {
            const credential = await CodexSessionCredential.tryLoad({
                authFile,
                env: {
                    CODEX_APP_SERVER_LOGIN_CLIENT_ID: "test-client",
                    CODEX_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${address.port}/oauth/token`,
                },
            });
            if (credential === null) expect.fail("Credential did not load.");
            const session = await new CodexProvider({
                credential,
                endpoint: `http://127.0.0.1:${address.port}/backend-api`,
                model: "gpt-5.6-sol",
                transport: "sse",
            }).session("auth-recovery", {
                instructions: "instructions",
            });
            const events = [];
            for await (const event of session.run({
                context: { messages: [{ role: "user", content: "hello" }] },
                effort: "low",
            })) {
                events.push(event);
            }

            expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
            expect(inferenceTokens).toEqual([
                "Bearer stale-access",
                "Bearer stale-access",
                "Bearer fresh-access",
            ]);
            expect(refreshRequests).toBe(1);
            const persisted = JSON.parse(await readFile(authFile, "utf8"));
            expect(persisted.tokens).toMatchObject({
                access_token: "fresh-access",
                refresh_token: "fresh-refresh",
                account_id: "account-1",
            });
            session.destroy();
        } finally {
            server.close();
            await rm(directory, { force: true, recursive: true });
        }
    });
});
