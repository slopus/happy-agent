import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
    happyComposerDraftFromConfig,
    happyComposerDraftSnapshotSchema,
} from "../../sources/happy/HappyComposerDraft.js";
import { draftBodySchema } from "../../sources/api/ApiSchemas.js";

it("mirrors a desktop draft with additional fields instead of projecting a clear", () => {
    const draft = {
        text: "Keep this draft",
        providerId: "codex",
        modelId: "openai/gpt-5.6-sol",
        effort: "high",
        serviceTier: null,
        permissionMode: "auto",
        extra: "desktop metadata",
    };
    expect(Value.Check(draftBodySchema, { draft, updatedAt: 100 })).toBe(true);
    const snapshot = happyComposerDraftFromConfig({
        metadata: { draft, draftUpdatedAt: 100 },
    });
    expect(snapshot).toEqual({ value: draft, updatedAt: 100 });
    expect(Value.Check(happyComposerDraftSnapshotSchema, snapshot)).toBe(true);
});
