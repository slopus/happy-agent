import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    MAX_SLOT_ENTRIES,
    slotCreateInputSchema,
    slotCursorSchema,
    slotDetailCursorSchema,
    slotDetailPageSchema,
    slotDetailQuerySchema,
    slotMutationOperationSchema,
    slotMutationOptionsSchema,
    slotMutationProofSchema,
    slotOrderingSchema,
    slotPageQueryEverywhereSchema,
    slotPageQueryNoScopeSchema,
    slotPageQueryProjectSchema,
    slotPageQuerySchema,
    slotPageQuerySessionSchema,
    slotPageQueryWorkspaceSchema,
    slotReorderInputSchema,
    slotScopeReferenceSchema,
    slotUpdateInputSchema,
    type SlotCreateInput,
    type SlotCursor,
    type SlotDetailCursor,
    type SlotDetailQuery,
    type SlotMutationOperation,
    type SlotMutationOptions,
    type SlotOrdering,
    type SlotPageQueryEverywhere,
    type SlotPageQueryNoScope,
    type SlotPageQueryProject,
    type SlotPageQuerySession,
    type SlotPageQueryWorkspace,
    type SlotReorderInput,
    type SlotScopeReference,
    type SlotUpdateInput,
} from "../../sources/index.js";

describe("public slot exports", () => {
    it("exports every input, operation, ordering, and cursor contract", () => {
        const create: SlotCreateInput = {
            slot: "status-line",
            scope: "everywhere",
            content: { type: "text", markdown: "Ready" },
            description: "Status",
            purpose: "Show readiness",
        };
        const update: SlotUpdateInput = { purpose: "Show current readiness" };
        const reorder: SlotReorderInput = ["entry-1"];
        const operation: SlotMutationOperation = "create";
        const options: SlotMutationOptions = { operationId: "operation-1" };
        const ordering: SlotOrdering = 0;
        const cursor: SlotCursor = 1;
        const detailCursor: SlotDetailCursor = 1;
        const detailQuery: SlotDetailQuery = { detailOffset: detailCursor, detailLimit: 1 };
        const reference: SlotScopeReference = { scope: "everywhere" };
        const noScope: SlotPageQueryNoScope = {};
        const everywhere: SlotPageQueryEverywhere = { scope: "everywhere" };
        const project: SlotPageQueryProject = { scope: "project", projectId: "project-1" };
        const session: SlotPageQuerySession = { scope: "session", sessionId: "session-1" };
        const workspace: SlotPageQueryWorkspace = {
            scope: "workspace",
            workspaceId: "workspace-1",
        };

        expect(Value.Check(slotCreateInputSchema, create)).toBe(true);
        expect(Value.Check(slotUpdateInputSchema, update)).toBe(true);
        expect(Value.Check(slotReorderInputSchema, reorder)).toBe(true);
        expect(Value.Check(slotMutationOperationSchema, operation)).toBe(true);
        expect(Value.Check(slotMutationOptionsSchema, options)).toBe(true);
        expect(Value.Check(slotOrderingSchema, ordering)).toBe(true);
        expect(Value.Check(slotCursorSchema, cursor)).toBe(true);
        expect(Value.Check(slotCursorSchema, 0)).toBe(true);
        expect(Value.Check(slotCursorSchema, MAX_SLOT_ENTRIES)).toBe(true);
        expect(Value.Check(slotCursorSchema, -1)).toBe(false);
        expect(Value.Check(slotCursorSchema, MAX_SLOT_ENTRIES + 1)).toBe(false);
        expect(Value.Check(slotCursorSchema, "1")).toBe(false);
        expect(Value.Check(slotDetailCursorSchema, detailCursor)).toBe(true);
        expect(Value.Check(slotDetailQuerySchema, detailQuery)).toBe(true);
        expect(
            Value.Check(slotDetailPageSchema, {
                entry: null,
            }),
        ).toBe(true);
        expect(
            Value.Check(slotMutationProofSchema, {
                agentId: "agent-1",
                operation: "remove",
                operationId: "remove-1",
                fingerprint: "0".repeat(64),
                entryId: "entry-1",
                before: null,
                removed: false,
            }),
        ).toBe(true);
        expect(Value.Check(slotScopeReferenceSchema, reference)).toBe(true);
        expect(Value.Check(slotPageQuerySchema, noScope)).toBe(true);
        expect(Value.Check(slotPageQueryNoScopeSchema, noScope)).toBe(true);
        expect(Value.Check(slotPageQueryEverywhereSchema, everywhere)).toBe(true);
        expect(Value.Check(slotPageQueryProjectSchema, project)).toBe(true);
        expect(Value.Check(slotPageQuerySessionSchema, session)).toBe(true);
        expect(Value.Check(slotPageQueryWorkspaceSchema, workspace)).toBe(true);
    });
});
