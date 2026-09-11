import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createSensitiveReadPaths } from "../../../sources/sandbox/impl/createSensitiveReadPaths.js";

const home = resolve("/home/tester");
const privateConfig = resolve("/private/config");

describe("createSensitiveReadPaths", () => {
    it.each([undefined, "", "relative/config"])(
        "falls back to the private home config directory for %s XDG_CONFIG_HOME",
        (configuredDirectory) => {
            const paths = createSensitiveReadPaths({
                environment: { XDG_CONFIG_HOME: configuredDirectory },
                homeDirectory: home,
            });

            expect(paths).toContain(join(home, ".config", "gh"));
            expect(paths).not.toContain("relative/config/gh");
        },
    );

    it("honors an absolute XDG config directory", () => {
        const paths = createSensitiveReadPaths({
            environment: { XDG_CONFIG_HOME: privateConfig },
            homeDirectory: "/home/tester",
        });

        expect(paths).toContain(join(privateConfig, "gh"));
    });

    it("protects caller-declared private directories", () => {
        const paths = createSensitiveReadPaths({
            environment: {},
            hostPolicy: { privateDirectories: ["/private/agent-state"] },
            homeDirectory: "/home/tester",
        });

        expect(paths).toContain("/private/agent-state");
    });

    it("protects values named by caller-declared private path variables", () => {
        const paths = createSensitiveReadPaths({
            environment: { AGENT_PRIVATE_DIRECTORY: "/private/agent-config" },
            hostPolicy: { privatePathVariables: ["AGENT_PRIVATE_DIRECTORY"] },
            homeDirectory: "/home/tester",
        });

        expect(paths).toContain("/private/agent-config");
    });
});
