import type { AgentConfig } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SubtaskInputError, SubtasksModule } from "../../sources/subtasks/index.js";

/** One parent with subtask children held in memory, enough to drive ordering decisions. */
function fixture(children: Record<string, Record<string, unknown>>, parentId = "parent") {
    const configs = new Map<string, AgentConfig>([
        [parentId, { provenance: { createdAt: 0 }, metadata: { version: 3 } }],
    ]);
    let createdAt = 1;
    for (const [id, metadata] of Object.entries(children)) {
        configs.set(id, {
            provenance: { createdAt: createdAt++ },
            metadata: { subtask: true, version: 1, ...metadata },
        } as AgentConfig);
    }
    configs.set("hidden", { provenance: { createdAt: 99 }, metadata: {} });
    const updates: [string, Record<string, unknown>][] = [];
    const agents = {
        config: async (_ctx: Context, id: string) => configs.get(id),
        parentOf: async (_ctx: Context, id: string) => (id === parentId ? null : parentId),
        childOf: async (_ctx: Context, id: string) =>
            id === parentId ? [...configs.keys()].filter((key) => key !== parentId) : [],
        updateMetadata: async (_ctx: Context, id: string, update: Record<string, unknown>) => {
            updates.push([id, update]);
            const config = configs.get(id)!;
            configs.set(id, {
                ...config,
                metadata: { ...config.metadata, ...update },
            } as AgentConfig);
        },
    };
    const module = new SubtasksModule(
        {} as never,
        {} as never,
        {} as never,
        { register: vi.fn() } as never,
        {} as never,
        {} as never,
    );
    module.beforeStart({} as Context, agents as never);
    const ctx = {
        inTx: async (work: (txCtx: Context) => Promise<unknown>) => await work(ctx),
    } as unknown as Context;
    const order = () =>
        module
            .sortSiblings(
                [...configs.entries()]
                    .filter(
                        ([id, config]) =>
                            id !== parentId &&
                            module.isSubtask(config) &&
                            typeof config.metadata?.["archivedAt"] !== "number",
                    )
                    .map(([id, config]) => ({ id, config })),
            )
            .map(({ id }) => id);
    return { module, ctx, configs, updates, order };
}

describe("subtask sibling order", () => {
    it("keeps unordered siblings newest first and puts keyed siblings ahead of them", () => {
        const { order } = fixture({ old: {}, middle: {}, newest: { subtaskOrderKey: "5" } });
        expect(order()).toEqual(["newest", "middle", "old"]);
    });

    it("keys every active sibling in its current order before moving one", async () => {
        const { module, ctx, configs, updates, order } = fixture({
            alpha: {},
            bravo: {},
            charlie: {},
        });
        expect(order()).toEqual(["charlie", "bravo", "alpha"]);
        await expect(module.reorder(ctx, "alpha", null)).resolves.toBe(true);
        expect(order()).toEqual(["alpha", "charlie", "bravo"]);
        for (const id of ["alpha", "bravo", "charlie"]) {
            expect(module.siblingOrderKey(configs.get(id))).toMatch(/^[0-9]+$/);
        }
        expect(updates.map(([id]) => id).sort()).toEqual(["alpha", "bravo", "charlie", "parent"]);
        expect(updates.find(([id]) => id === "parent")?.[1]).toMatchObject({
            subtasksOrderedAt: expect.any(Number),
            version: 4,
        });
        expect(updates.find(([id]) => id === "alpha")?.[1]).toMatchObject({ version: 2 });
    });

    it("moves only the target once siblings are keyed, and treats a no-op move as unchanged", async () => {
        const { module, ctx, updates, order } = fixture({
            alpha: { subtaskOrderKey: "7" },
            bravo: { subtaskOrderKey: "5" },
            charlie: { subtaskOrderKey: "3" },
        });
        expect(order()).toEqual(["charlie", "bravo", "alpha"]);
        await expect(module.reorder(ctx, "charlie", "alpha")).resolves.toBe(true);
        expect(order()).toEqual(["bravo", "alpha", "charlie"]);
        expect(updates.map(([id]) => id)).toEqual(["charlie", "parent"]);
        updates.length = 0;
        await expect(module.reorder(ctx, "alpha", "bravo")).resolves.toBe(false);
        await expect(module.reorder(ctx, "bravo", null)).resolves.toBe(false);
        expect(updates).toEqual([]);
        await module.reorder(ctx, "alpha", null);
        await module.reorder(ctx, "charlie", "alpha");
        expect(order()).toEqual(["alpha", "charlie", "bravo"]);
    });

    it("re-keys tied siblings instead of failing between equal neighbours", async () => {
        const { module, ctx, order } = fixture({
            alpha: { subtaskOrderKey: "5" },
            bravo: { subtaskOrderKey: "5" },
            charlie: { subtaskOrderKey: "5" },
        });
        // Equal keys order by ascending identifier, never by creation time.
        expect(order()).toEqual(["alpha", "bravo", "charlie"]);
        await module.reorder(ctx, "charlie", "alpha");
        expect(order()).toEqual(["alpha", "charlie", "bravo"]);
    });

    it("orders a restored subtask that shares a moved sibling's key by identifier", async () => {
        const { module, ctx, configs, order } = fixture({
            zulu: { subtaskOrderKey: "3" },
            alpha: { subtaskOrderKey: "5", archivedAt: 1 },
            mike: { subtaskOrderKey: "7" },
        });
        await module.reorder(ctx, "mike", null);
        await module.reorder(ctx, "zulu", "mike");
        const alpha = configs.get("alpha")!;
        const zuluKey = module.siblingOrderKey(configs.get("zulu"));
        configs.set("alpha", {
            ...alpha,
            metadata: { ...alpha.metadata, archivedAt: null, subtaskOrderKey: zuluKey },
        } as never);
        expect(order()).toEqual(["mike", "alpha", "zulu"]);
        await module.reorder(ctx, "zulu", null);
        expect(order()).toEqual(["zulu", "mike", "alpha"]);
    });

    it("ignores archived siblings as neighbours and keeps their keys", async () => {
        const { module, ctx, configs, order } = fixture({
            alpha: { subtaskOrderKey: "7" },
            archived: { subtaskOrderKey: "6", archivedAt: 1 },
            charlie: { subtaskOrderKey: "5" },
        });
        await expect(module.reorder(ctx, "charlie", "archived")).rejects.toBeInstanceOf(
            SubtaskInputError,
        );
        await expect(module.reorder(ctx, "archived", null)).rejects.toBeInstanceOf(
            SubtaskInputError,
        );
        await module.reorder(ctx, "charlie", "alpha");
        expect(order()).toEqual(["alpha", "charlie"]);
        expect(module.siblingOrderKey(configs.get("archived"))).toBe("6");
    });

    it.each([
        ["alpha", "alpha"],
        ["alpha", "hidden"],
        ["alpha", "parent"],
        ["alpha", "unknown"],
        ["hidden", null],
        ["parent", null],
        ["unknown", null],
        ["alpha", "Not an id"],
    ])("refuses moving %s after %s", async (agentId, afterId) => {
        const { module, ctx, updates } = fixture({ alpha: {}, bravo: {} });
        await expect(module.reorder(ctx, agentId, afterId)).rejects.toBeInstanceOf(
            SubtaskInputError,
        );
        expect(updates).toEqual([]);
    });
});
