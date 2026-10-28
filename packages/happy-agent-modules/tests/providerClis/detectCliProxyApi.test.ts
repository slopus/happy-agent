import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    detectCliProxyApi,
    parseCliProxyApiConfig,
} from "../../sources/providerClis/impl/detectCliProxyApi.js";
import type { ProviderCliMachine } from "../../sources/providerClis/impl/providerCliCatalog.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An empty home and empty program folders, so nothing of the real computer is read. */
async function machine(): Promise<{ home: string; machine: ProviderCliMachine }> {
    const home = await mkdtemp(join(tmpdir(), "cliproxyapi-"));
    cleanups.push(async () => await rm(home, { recursive: true, force: true }));
    return {
        home,
        machine: {
            platform: process.platform,
            env: { HOME: home, PATH: "" },
            applications: [],
            programDirectories: [],
        },
    };
}

/** A stand-in for CLIProxyAPI's local server that records what it was asked. */
async function proxy(
    answer: (request: IncomingMessage) => { status: number; body: string },
): Promise<{ port: number; requests: IncomingMessage[] }> {
    const requests: IncomingMessage[] = [];
    const server: Server = createServer((request, response) => {
        requests.push(request);
        const { status, body } = answer(request);
        response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => await new Promise<void>((resolve) => server.close(() => resolve())));
    return { port: (server.address() as AddressInfo).port, requests };
}

async function writeHomeConfig(home: string, text: string): Promise<string> {
    await mkdir(join(home, ".cli-proxy-api"), { recursive: true });
    const path = join(home, ".cli-proxy-api", "config.yaml");
    await writeFile(path, text);
    return path;
}

const MODELS = JSON.stringify({
    object: "list",
    data: [
        { id: "claude-opus-5-5", object: "model", owned_by: "anthropic" },
        { id: "gpt-6.1-sol", object: "model", owned_by: "openai" },
        { id: "gemini-3-pro", object: "model", owned_by: "antigravity" },
        { id: "kimi-k3", object: "model", owned_by: "moonshot" },
    ],
});

describe("reading a CLIProxyAPI config", () => {
    it("reads the v8 layout's server port and client keys", () => {
        expect(
            parseCliProxyApiConfig(
                [
                    "config-version: 8",
                    "models:",
                    '  catalog: ""',
                    "server:",
                    '  # Use "127.0.0.1" to restrict access.',
                    '  host: ""',
                    "  port: 9417 # the server port",
                    "  tls:",
                    "    enable: false",
                    "    port: 1",
                    "access:",
                    "  # API keys for authentication",
                    "  api-keys:",
                    '    - "sk-local-#1"',
                    "    - 'second'",
                ].join("\n"),
            ),
        ).toEqual({ port: 9417, apiKeys: ["sk-local-#1", "second"] });
    });

    it("reads the legacy top-level layout, and lets v8 win even with an empty list", () => {
        expect(parseCliProxyApiConfig("port: 8400\napi-keys:\n- legacy-key\n")).toEqual({
            port: 8400,
            apiKeys: ["legacy-key"],
        });
        expect(
            parseCliProxyApiConfig(
                'port: 8400\napi-keys: [a, "b"]\nserver:\n  port: 8500\naccess:\n  api-keys: []\n',
            ),
        ).toEqual({ port: 8500, apiKeys: [] });
    });

    it("falls back to the default port when the config has none or a bad one", () => {
        expect(parseCliProxyApiConfig("server:\n  port: banana\n")).toEqual({
            port: 8317,
            apiKeys: [],
        });
        expect(parseCliProxyApiConfig("")).toEqual({ port: 8317, apiKeys: [] });
    });
});

describe("detecting a CLIProxyAPI already on this computer", () => {
    it("finds nothing, and probes nothing, when neither its program nor its config exists", async () => {
        const { machine: computer } = await machine();
        await expect(detectCliProxyApi(computer)).resolves.toBeNull();
    });

    it("lists the models a running proxy serves, sending its own client key to 127.0.0.1", async () => {
        const { home, machine: computer } = await machine();
        const server = await proxy((request) =>
            request.headers.authorization === "Bearer sk-local"
                ? { status: 200, body: MODELS }
                : { status: 401, body: '{"error":"Invalid API key"}' },
        );
        const configPath = await writeHomeConfig(
            home,
            `server:\n  port: ${String(server.port)}\naccess:\n  api-keys:\n    - "sk-local"\n`,
        );

        const detected = await detectCliProxyApi(computer);

        expect(detected).toEqual({
            program: null,
            configPath,
            port: server.port,
            apiKey: "sk-local",
            status: "running",
            models: [
                { id: "claude-opus-5-5", vendor: "Anthropic" },
                { id: "gpt-6.1-sol", vendor: "OpenAI" },
                { id: "gemini-3-pro", vendor: "Google" },
                { id: "kimi-k3", vendor: "moonshot" },
            ],
            vendors: ["Anthropic", "Google", "OpenAI", "moonshot"],
        });
        expect(server.requests.map((request) => [request.method, request.url])).toEqual([
            ["GET", "/v1/models"],
        ]);
    });

    it("reports a proxy that refuses its key, and one that is not running", async () => {
        const { home, machine: computer } = await machine();
        const server = await proxy(() => ({ status: 401, body: '{"error":"Invalid API key"}' }));
        await writeHomeConfig(home, `port: ${String(server.port)}\napi-keys:\n  - stale\n`);
        await expect(detectCliProxyApi(computer)).resolves.toMatchObject({
            status: "unauthorized",
            models: [],
        });

        // A port nothing listens on any more.
        const closed = await proxy(() => ({ status: 200, body: MODELS }));
        await cleanups.pop()?.();
        await writeHomeConfig(home, `port: ${String(closed.port)}\n`);
        await expect(detectCliProxyApi(computer)).resolves.toMatchObject({
            status: "stopped",
            apiKey: null,
            models: [],
        });
    });

    it("does not mistake another server on that port for the proxy", async () => {
        const { home, machine: computer } = await machine();
        const server = await proxy(() => ({ status: 200, body: "<html>Hello</html>" }));
        await writeHomeConfig(home, `port: ${String(server.port)}\n`);
        await expect(detectCliProxyApi(computer)).resolves.toMatchObject({ status: "stopped" });
    });

    it("finds a Homebrew install and its config beside the package manager's bin, without running it", async () => {
        const { home, machine: computer } = await machine();
        const bin = join(home, "homebrew", "bin");
        await mkdir(bin, { recursive: true });
        await mkdir(join(home, "homebrew", "etc"), { recursive: true });
        const program = join(bin, "cliproxyapi");
        // Running it would leave this marker; detection must never run the proxy's program.
        const marker = join(home, "ran");
        await writeFile(program, `#!/bin/sh\ntouch "${marker}"\n`);
        await chmod(program, 0o755);
        const server = await proxy(() => ({ status: 200, body: MODELS }));
        const configPath = join(home, "homebrew", "etc", "cliproxyapi.conf");
        await writeFile(configPath, `server:\n  port: ${String(server.port)}\n`);

        const detected = await detectCliProxyApi({ ...computer, programDirectories: [bin] });

        expect(detected).toMatchObject({ program, configPath, status: "running" });
        await expect(import("node:fs/promises").then(({ stat }) => stat(marker))).rejects.toThrow();
    });
});
