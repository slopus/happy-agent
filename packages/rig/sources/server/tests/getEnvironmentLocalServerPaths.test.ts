import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getEnvironmentLocalServerPaths } from "../getEnvironmentLocalServerPaths.js";

describe("getEnvironmentLocalServerPaths", () => {
    it("uses RIG_HOME for durable state and the temporary directory for daemon files", () => {
        const paths = getEnvironmentLocalServerPaths({ RIG_HOME: "/home/tester/custom-rig" }, 501);

        expect(paths.databasePath).toBe("/home/tester/custom-rig/sessions.sqlite");
        expect(paths.directory).toBe(join(tmpdir(), "rig-501"));
        expect(paths.socketPath).toBe(join(tmpdir(), "rig-501", "server.sock"));
    });

    it("keeps every development daemon file in the configured directory", () => {
        const directory = resolve("workspace/.rig-dev");

        expect(getEnvironmentLocalServerPaths({ RIG_SERVER_DIRECTORY: directory }, 501)).toEqual({
            databasePath: `${directory}/sessions.sqlite`,
            diagnosticsPath: `${directory}/diagnostics`,
            directory,
            irohSecretKeyPath: `${directory}/iroh-secret-key`,
            logPath: `${directory}/server.log`,
            p2pIdentityPath: `${directory}/p2p-instance-identity.json`,
            registryPath: `${directory}/server.json`,
            socketPath: `${directory}/server.sock`,
            tokenPath: `${directory}/token`,
        });
    });

    it("still honors explicit socket and token overrides", () => {
        const paths = getEnvironmentLocalServerPaths(
            {
                RIG_SERVER_DIRECTORY: "/workspace/.rig-dev",
                RIG_SERVER_SOCKET_PATH: "/tmp/custom.sock",
                RIG_SERVER_TOKEN_PATH: "/tmp/custom-token",
            },
            501,
        );

        expect(paths.socketPath).toBe("/tmp/custom.sock");
        expect(paths.tokenPath).toBe("/tmp/custom-token");
        expect(paths.databasePath).toBe("/workspace/.rig-dev/sessions.sqlite");
    });

    it("ignores empty socket and token overrides", () => {
        const paths = getEnvironmentLocalServerPaths(
            {
                RIG_SERVER_DIRECTORY: "/workspace/.rig-dev",
                RIG_SERVER_SOCKET_PATH: "  ",
                RIG_SERVER_TOKEN_PATH: "",
            },
            501,
        );

        expect(paths.socketPath).toBe("/workspace/.rig-dev/server.sock");
        expect(paths.tokenPath).toBe("/workspace/.rig-dev/token");
    });
});
