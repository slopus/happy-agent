import { describe, expect, it } from "vitest";

import {
    createHappySessionMetadata,
    MAX_HAPPY_ATTACHMENT_BYTES,
} from "../../sources/happy/index.js";
import type {
    HappyConnectionConfiguration,
    HappyModel,
    HappySessionSnapshot,
} from "../../sources/happy/index.js";

const CONFIGURATION: HappyConnectionConfiguration = {
    credentialFingerprint: "credential-fingerprint",
    credentials: { encryption: { secret: new Uint8Array(32), type: "legacy" }, token: "token" },
    credentialsPath: "/home/steve/.rig/happy/access.key",
    happyHome: "/home/steve/.rig/happy",
    imported: false,
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
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium"],
        id: "opus-5",
        name: "Opus 5",
        providerId: "claude",
        serviceTiers: [],
    },
];

function snapshot(overrides: Partial<HappySessionSnapshot> = {}): HappySessionSnapshot {
    return {
        agentId: "agent-1",
        archived: false,
        cwd: "/home/steve/projects/rig",
        effort: "high",
        modelId: "gpt-5.6-sol",
        permissionMode: "auto",
        projectName: "rig",
        providerId: "codex",
        sessionId: "session-1",
        status: "running",
        title: "Porting the Happy module",
        tools: ["read", "edit"],
        working: true,
        ...overrides,
    };
}

function metadata(session: HappySessionSnapshot = snapshot()) {
    return createHappySessionMetadata({
        configuration: CONFIGURATION,
        models: MODELS,
        session,
        summaryUpdatedAt: 5_000,
        version: "1.2.3",
    });
}

describe("describing a Happy Agent session in Happy's own terms", () => {
    it("says what the session is running on", () => {
        const published = metadata();
        expect(published.currentModelCode).toBe("gpt-5.6-sol");
        expect(published.currentModelProviderId).toBe("codex");
        expect(published.currentThoughtLevelCode).toBe("high");
        expect(published.model).toEqual({ id: "gpt-5.6-sol", providerId: "codex" });
        expect(published.reasoning).toEqual({
            current: "high",
            levels: ["low", "medium", "high"],
        });
    });

    it("shows the session as thinking while it owes work", () => {
        expect(metadata().activity.session).toEqual({ kind: "thinking" });
        expect(metadata(snapshot({ working: false })).activity.session).toEqual({ kind: "idle" });
        expect(metadata(snapshot({ archived: true, working: false })).activity.session).toEqual({
            kind: "archived",
        });
    });

    it("offers every model the daemon can serve, whatever the provider", () => {
        const published = metadata();
        expect(published.models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "opus-5"]);
        expect(published.providers.map((provider) => provider.id)).toEqual(["codex", "claude"]);
    });

    it("claims only what this daemon can actually do", () => {
        const capabilities = metadata().capabilities;
        expect(capabilities.abort).toBe(true);
        expect(capabilities.steering).toBe(true);
        expect(capabilities.modelSelection).toBe(true);
        expect(capabilities.reasoningSelection).toBe(true);
        // Happy Agent's Happy connection has no file or shell surface of its own.
        expect(capabilities.files).toEqual({
            browse: false,
            read: false,
            search: false,
            write: false,
        });
        expect(capabilities.shell).toBe(false);
        expect(capabilities.rpcMethods).toEqual(["abort", "communication", "killSession"]);
        expect(capabilities.attachments).toEqual({
            enabled: true,
            maxBytes: MAX_HAPPY_ATTACHMENT_BYTES,
            mediaTypes: ["image/*"],
        });
    });

    it("does not offer a reasoning choice for a model with none", () => {
        const published = metadata(snapshot({ modelId: "unknown-model" }));
        expect(published.capabilities.reasoningSelection).toBe(false);
        expect(published.reasoning.levels).toEqual([]);
    });

    it("names the session and the folder it works in", () => {
        const published = metadata();
        expect(published.name).toBe("Porting the Happy module");
        expect(published.summary).toEqual({
            text: "Porting the Happy module",
            updatedAt: 5_000,
        });
        expect(published.path).toBe("/home/steve/projects/rig");
        expect(published.project).toEqual({ id: "rig:session-1", kind: "regular", name: "rig" });
    });

    it("says which Happy Agent this is and which machine it runs on", () => {
        const published = metadata();
        expect(published.client).toEqual({ id: "rig", name: "Happy Agent", version: "1.2.3" });
        expect(published.machineId).toBe("machine-1");
        expect(published.happyHomeDir).toBe("/home/steve/.rig/happy");
        expect(published.startedBy).toBe("daemon");
        expect(published.rigMetadataVersion).toBe(1);
    });

    it("leaves out a reasoning level the session does not have", () => {
        const { effort: _effort, ...rest } = snapshot();
        expect(metadata(rest as HappySessionSnapshot).currentThoughtLevelCode).toBeUndefined();
        expect(metadata(rest as HappySessionSnapshot).reasoning.current).toBeNull();
    });
});
