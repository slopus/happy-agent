import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HAPPY_AGENT_PROTOCOL_VERSION } from "@slopus/happy-agent-client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getHappyDaemonPaths: vi.fn(),
    loadHappyAgentConfiguration: vi.fn(),
    readDaemonToken: vi.fn(),
    readOrCreateDaemonToken: vi.fn(),
    runAgentDaemon: vi.fn(),
}));

vi.mock("@slopus/happy-agent-client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@slopus/happy-agent-client")>()),
    HappyAgentClient: class {
        constructor(options: unknown) {
            mocks.createClient(options);
        }
        async getHealth() {
            return {
                ready: true,
                version: { protocol: HAPPY_AGENT_PROTOCOL_VERSION, daemon: "test" },
            };
        }
    },
}));
vi.mock("@slopus/happy-agent-modules", () => ({
    loadHappyAgentConfiguration: mocks.loadHappyAgentConfiguration,
}));
vi.mock("../sources/lifecycle/daemonToken.js", () => ({
    readDaemonToken: mocks.readDaemonToken,
    readDaemonTokenIfPresent: vi.fn(async () => undefined),
    readOrCreateDaemonToken: mocks.readOrCreateDaemonToken,
}));
vi.mock("../sources/lifecycle/getDaemonIdentity.js", () => ({
    getDaemonIdentity: vi.fn(() => ({ version: "test" })),
}));
vi.mock("../sources/lifecycle/getHappyDaemonPaths.js", () => ({
    getHappyDaemonPaths: mocks.getHappyDaemonPaths,
}));
vi.mock("../sources/lifecycle/runAgentDaemon.js", () => ({
    runAgentDaemon: mocks.runAgentDaemon,
}));

import { ensureAgentDaemon } from "../sources/lifecycle/ensureAgentDaemon.js";

const roots: string[] = [];
afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([true, false])(
    "authenticates startup readiness with the served token (fixed: %s)",
    async (fixed) => {
        const happyHome = await mkdtemp(join(tmpdir(), "happy-startup-token-"));
        roots.push(happyHome);
        const directory = join(happyHome, "agent");
        const tokenPath = join(directory, "token");
        mocks.getHappyDaemonPaths.mockReturnValue({
            directory,
            happyHome,
            tokenPath,
            socketPath: join(directory, "server.sock"),
        });
        const configuredToken = "c".repeat(43);
        const generatedToken = "g".repeat(43);
        const servedToken = fixed ? configuredToken : generatedToken;
        mocks.loadHappyAgentConfiguration.mockResolvedValue({
            values: {
                feature: { team: { enabled: false } },
                ...(fixed ? { api: { token: configuredToken } } : {}),
            },
        });
        mocks.readOrCreateDaemonToken.mockResolvedValue(generatedToken);
        mocks.readDaemonToken.mockResolvedValue(servedToken);
        mocks.runAgentDaemon.mockResolvedValue(undefined);

        const connection = await ensureAgentDaemon({ runInProcess: true });

        expect(mocks.createClient).toHaveBeenCalledTimes(1);
        expect(mocks.createClient).toHaveBeenCalledWith(
            expect.objectContaining({ token: servedToken }),
        );
        expect(connection.token).toBe(servedToken);
        if (fixed) {
            expect(mocks.readOrCreateDaemonToken).not.toHaveBeenCalled();
        } else {
            expect(mocks.readOrCreateDaemonToken).toHaveBeenCalledWith(tokenPath);
        }
    },
);
