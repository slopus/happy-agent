import { describe, expect, it } from "vitest";

import { getEnvironmentLocalServerPaths } from "../server/getEnvironmentLocalServerPaths.js";
import { configureDevelopmentEnvironment } from "./configureDevelopmentEnvironment.js";

describe("configureDevelopmentEnvironment", () => {
    it("places the daemon in the development checkout", async () => {
        const environment = { RIG_DEVELOPMENT_BUILD_ID: "existing-build" };

        await configureDevelopmentEnvironment({
            environment,
            repositoryRoot: "/workspace/rig",
        });

        expect(environment).toEqual({
            RIG_DEVELOPMENT_BUILD_ID: "existing-build",
            RIG_SERVER_DIRECTORY: "/workspace/rig/.rig-dev",
        });
    });

    it("preserves an explicit Happy development opt-out", async () => {
        const environment = {
            RIG_DEVELOPMENT_BUILD_ID: "existing-build",
            RIG_DISABLE_HAPPY_SYNC: "1",
        };

        await configureDevelopmentEnvironment({
            environment,
            repositoryRoot: "/workspace/rig",
        });

        expect(environment.RIG_DISABLE_HAPPY_SYNC).toBe("1");
    });

    it("replaces inherited global Rig paths with checkout-local development state", async () => {
        const environment = {
            RIG_DEVELOPMENT_BUILD_ID: "existing-build",
            RIG_SERVER_DIRECTORY: "/tmp/rig-501",
            RIG_SERVER_SOCKET_PATH: "/tmp/rig-501/server.sock",
            RIG_SERVER_TOKEN_PATH: "/tmp/rig-501/token",
        };

        await configureDevelopmentEnvironment({
            environment,
            repositoryRoot: "/workspace/rig",
        });

        expect(environment).toEqual({
            RIG_DEVELOPMENT_BUILD_ID: "existing-build",
            RIG_SERVER_DIRECTORY: "/workspace/rig/.rig-dev",
        });
        expect(getEnvironmentLocalServerPaths(environment, 501)).toEqual({
            databasePath: "/workspace/rig/.rig-dev/sessions.sqlite",
            diagnosticsPath: "/workspace/rig/.rig-dev/diagnostics",
            directory: "/workspace/rig/.rig-dev",
            irohSecretKeyPath: "/workspace/rig/.rig-dev/iroh-secret-key",
            logPath: "/workspace/rig/.rig-dev/server.log",
            p2pIdentityPath: "/workspace/rig/.rig-dev/p2p-instance-identity.json",
            registryPath: "/workspace/rig/.rig-dev/server.json",
            socketPath: "/workspace/rig/.rig-dev/server.sock",
            tokenPath: "/workspace/rig/.rig-dev/token",
        });
    });
});
