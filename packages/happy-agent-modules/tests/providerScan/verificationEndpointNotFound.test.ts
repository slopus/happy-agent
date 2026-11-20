import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderScanModule } from "../../sources/providerScan/index.js";
import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
const servers: Server[] = [];
let root: string;
let codexHome: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verification-not-found-"));
    roots.push(root);
    codexHome = join(root, "codex");
    await mkdir(codexHome, { recursive: true });
    for (const name of ["GATEWAY_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) vi.stubEnv(name, "");
    vi.stubEnv("CODEX_HOME", codexHome);
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("verifying a provider whose endpoint path does not exist", () => {
    it("reports the endpoint once instead of claiming the credentials work", async () => {
        const requests: string[] = [];
        // Any web server behind a wrong base URL: every path is a 404 and the key is never read.
        const server = createServer((request, response) => {
            request.resume();
            requests.push(request.url ?? "");
            response.writeHead(404, { "content-type": "text/plain" });
            response.end("Not Found");
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing port.");
        vi.stubEnv("GATEWAY_KEY", "wrong-key");
        await writeFile(
            join(codexHome, "config.toml"),
            [
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                // Missing the /v1 segment the gateway serves.
                `base_url = "http://127.0.0.1:${String(address.port)}/wrong"`,
                'env_key = "GATEWAY_KEY"',
            ].join("\n"),
        );
        const config = await testConfigRootedAt(
            root,
            "[providers]\ndefault_enable = false\n[providers.codex]\nenabled = true\n[settings]\ninference_max_retries = 0\n",
        );

        const result = await new ProviderScanModule(config).verify(
            createRootContext(),
            "codex",
            "inference",
        );

        expect(requests).toEqual(["/wrong/responses"]);
        expect(result.status).toBe("failed");
        expect(result.failure?.kind).toBe("unknown");
        expect(result.failure?.message).toMatch(/HTTP 404 \(not found\)/u);
        expect(result.failure?.message).not.toMatch(/credentials/u);
    });
});
