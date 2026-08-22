import { describe, expect, it } from "vitest";

import { createHappyMachineMetadata } from "../../sources/happy/index.js";
import type { HappyConnectionConfiguration, HappyModel } from "../../sources/happy/index.js";

const CONFIGURATION: HappyConnectionConfiguration = {
    credentials: { encryption: { secret: new Uint8Array(32), type: "legacy" }, token: "token" },
    credentialsPath: "/home/steve/.happy/access.key",
    happyHome: "/home/steve/.happy",
    imported: true,
    machineId: "machine-1",
    serverUrl: "https://api.happy.example",
};

const MODELS: readonly HappyModel[] = [
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium", "high"],
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerId: "codex",
        serviceTiers: ["priority"],
    },
];

function metadata(overrides: { siblingMachineId?: string } = {}) {
    return createHappyMachineMetadata({
        configuration: CONFIGURATION,
        models: MODELS,
        ...overrides,
        version: "1.2.3",
    });
}

describe("describing this computer to Happy", () => {
    /**
     * The phone requires every one of these of any machine, and rejects the whole metadata
     * document when one is missing — which costs the machine its models, its name and any way to
     * start a session, not just the field itself.
     */
    it("says everything the phone refuses to read a machine without", () => {
        const published = metadata();
        expect(typeof published.happyCliVersion).toBe("string");
        expect(published.happyCliVersion.length).toBeGreaterThan(0);
        expect(typeof published.host).toBe("string");
        expect(typeof published.platform).toBe("string");
        expect(typeof published.happyHomeDir).toBe("string");
        expect(typeof published.homeDir).toBe("string");
    });

    it("names the machine the other daemon on this computer registered", () => {
        expect(metadata({ siblingMachineId: "cli-1" }).siblingMachineId).toBe("cli-1");
        expect("siblingMachineId" in metadata()).toBe(false);
    });

    it("offers itself for new sessions, with what it can run", () => {
        const published = metadata();
        expect(published.machineKind).toBe("rig");
        expect(published.capabilities.newSession).toBe(true);
        expect(published.models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
        expect(published.defaults).toMatchObject({ modelId: "gpt-5.6-sol", providerId: "codex" });
    });
});
