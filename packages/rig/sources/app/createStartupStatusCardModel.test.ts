import { describe, expect, it } from "vitest";

import type { ProtocolSession } from "../protocol/index.js";
import { defineTestModel as defineModel } from "../testing/defineTestModel.js";
import { createStartupStatusCardModel } from "./createStartupStatusCardModel.js";

describe("createStartupStatusCardModel", () => {
    it("captures resumed Docker session state without adding usage data", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off", "high"],
        });
        const session = {
            cwd: "/container/workspace",
            effort: "high",
            environment: {
                kind: "image",
                reference: "rig-dev:latest",
                type: "docker",
                workingDirectory: "/container/workspace",
            },
            permissionMode: "workspace_write",
            providerId: "codex",
            serviceTier: "fast",
            snapshot: {},
        } as unknown as ProtocolSession;

        expect(
            createStartupStatusCardModel({ model, resumed: true, session, version: "1.2.3" }),
        ).toEqual({
            access: "Workspace write",
            environment: "Docker image rig-dev:latest",
            fast: true,
            githubAvailable: false,
            model: "GPT Test",
            provider: "Codex",
            reasoning: "High",
            session: "Resumed",
            version: "1.2.3",
            workspace: "/container/workspace",
        });
    });
});
