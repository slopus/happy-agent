import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localModelRoutes } from "../../sources/providerRoutes/impl/localModelRoutes.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function machine() {
    const home = await mkdtemp(join(tmpdir(), "local-models-"));
    cleanups.push(async () => await rm(home, { recursive: true, force: true }));
    return {
        home,
        machine: { platform: process.platform, env: { HOME: home }, programDirectories: [] },
    };
}

/** A stand-in local model server; it records each request so a test can see what was asked. */
async function server(models: string[]): Promise<{ port: number; requests: string[] }> {
    const requests: string[] = [];
    const listener: Server = createServer((request, response) => {
        requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
            JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }),
        );
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    cleanups.push(
        async () => await new Promise<void>((resolve) => listener.close(() => resolve())),
    );
    return { port: (listener.address() as AddressInfo).port, requests };
}

describe("local model servers", () => {
    it("lists a running server's chat models and asks it nothing but its model list", async () => {
        const { machine: computer } = await machine();
        const ollama = await server(["qwen3-coder:30b", "nomic-embed-text:latest"]);

        const routes = await localModelRoutes(computer, { ollama: ollama.port });

        expect(routes).toEqual([
            {
                id: "ollama",
                kind: "local_models",
                name: "Ollama",
                vendors: ["Ollama"],
                billing: "local",
                account: null,
                endpoint: `http://127.0.0.1:${String(ollama.port)}/v1`,
                status: "ready",
                models: [{ id: "qwen3-coder:30b", vendor: "Ollama" }],
                warning: null,
                provider: {
                    id: "ollama",
                    table: {
                        type: "openai_compatible",
                        name: "Ollama",
                        base_url: `http://127.0.0.1:${String(ollama.port)}/v1`,
                        api_key: "local",
                        models: ["qwen3-coder:30b"],
                    },
                    summary: "Adds Ollama on this computer with 1 model.",
                },
            },
        ]);
        expect(ollama.requests).toEqual(["GET /v1/models"]);
    });

    it("shows an installed server that is not running, and nothing for one never installed", async () => {
        const { home, machine: computer } = await machine();
        await mkdir(join(home, ".lmstudio"));
        const closed = await server([]);
        await cleanups.pop()?.();

        const routes = await localModelRoutes(computer, {
            lmstudio: closed.port,
            ollama: closed.port,
        });

        expect(routes).toEqual([
            expect.objectContaining({ id: "lmstudio", status: "not_running", models: null }),
        ]);
        expect(routes[0]).not.toHaveProperty("provider");
    });

    it("asks no port it was not given", async () => {
        const { home, machine: computer } = await machine();
        await mkdir(join(home, ".ollama"));
        await expect(localModelRoutes(computer, {})).resolves.toEqual([
            expect.objectContaining({ id: "ollama", status: "not_running", endpoint: null }),
        ]);
    });
});
