import type { AgentBaseModelChange, AgentModel } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import type { HistoryExcerpt } from "../../sources/history/index.js";
import { ModelSwitchModule } from "../../sources/modelSwitch/ModelSwitchModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import {
    DEFAULT_AGENT_ID,
    agentReference,
    historyWith,
    modelChange,
    modelSwitchNoticeFromHook,
    modelSwitchScope,
    textFromNotice,
} from "./modelSwitchTestSupport.js";

function model(providerId: string, id: string, name: string): AgentModel {
    return {
        providerId,
        id,
        name,
        effortLevels: ["low"],
        defaultEffort: "low",
    };
}

/** A history that cannot be read, which must cost the excerpt and nothing else. */
class UnreadableHistory extends HistoryModule {
    override async readExcerpt(): Promise<HistoryExcerpt | undefined> {
        throw new Error("the archive is unreadable");
    }
}

/** A history that records how it was asked to be excerpted. */
class ObservedHistory extends HistoryModule {
    readonly requests: string[] = [];

    override async readExcerpt(
        ctx: Context,
        agentId: string,
        maxCharacters: number,
    ): Promise<HistoryExcerpt | undefined> {
        this.requests.push(`${agentId}:${maxCharacters}`);
        return await super.readExcerpt(ctx, agentId, maxCharacters);
    }
}

describe("ModelSwitchModule lifecycle", () => {
    it("returns the modelChanged hook from beforeStart and uses the collection labels", async () => {
        const ctx = moduleDatabase([], "model-switch-labels");
        const module = new ModelSwitchModule();
        const hooks = await module.beforeStart?.(
            ctx.context,
            agentReference([
                model("scripted", "openai/gpt-5.6-sol", "Fast OpenAI"),
                model("scripted", "anthropic/opus-5", "Careful Claude"),
            ]),
        );

        try {
            expect(hooks?.modelChanged).toBeTypeOf("function");
            const result = await hooks?.modelChanged?.(
                ctx.context,
                modelSwitchScope(),
                modelChange(),
            );
            const text = textFromNotice(result);

            expect(text).toContain("Fast OpenAI on scripted");
            expect(text).toContain("Careful Claude on scripted");
        } finally {
            ctx.close();
        }
    });

    it("falls back to model IDs when the collection has no matching route", async () => {
        const database = moduleDatabase([], "model-switch-unlabeled");
        try {
            const result = await modelSwitchNoticeFromHook(
                new ModelSwitchModule(),
                database.context,
                {
                    models: [model("other-provider", "openai/gpt-5.6-sol", "Wrong provider")],
                },
            );

            const text = textFromNotice(result);
            expect(text).toContain("openai/gpt-5.6-sol on scripted");
            expect(text).toContain("anthropic/opus-5 on scripted");
            expect(text).not.toContain("Wrong provider");
        } finally {
            database.close();
        }
    });

    it("does not read the history for a compatible change or an initial model selection", async () => {
        const history = new ObservedHistory();
        const database = moduleDatabase(history.migrations, "model-switch-no-notice");
        await database.ready;
        const module = new ModelSwitchModule(history);

        try {
            await expect(
                modelSwitchNoticeFromHook(module, database.context, {
                    change: modelChange({ wasReset: false }),
                }),
            ).resolves.toBeUndefined();
            await expect(
                modelSwitchNoticeFromHook(module, database.context, {
                    change: modelChange({ previousModel: undefined }),
                }),
            ).resolves.toBeUndefined();
            expect(history.requests).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("uses the same hook to explain a request-profile reset", async () => {
        const database = moduleDatabase([], "model-switch-profile-reset");
        try {
            const result = await modelSwitchNoticeFromHook(
                new ModelSwitchModule(),
                database.context,
                {
                    change: modelChange({
                        previousModel: "openai/gpt-5.6-sol",
                        model: "openai/gpt-5.6-sol",
                    }),
                },
            );
            const text = textFromNotice(result);

            expect(text).toContain("<profile-reset-history-context>");
            expect(text).toContain("The request profile changed");
            expect(text).not.toContain("configuration changed from");
        } finally {
            database.close();
        }
    });
});

describe("ModelSwitchModule history handoff", () => {
    it("quotes both ends of the erased conversation with the archive's own totals", async () => {
        const { history, database } = await historyWith(
            "model-switch-handoff",
            Array.from({ length: 6 }, (_, index) => ({
                blocks: [{ type: "text" as const, text: `message ${index}` }],
            })),
        );

        try {
            const result = await modelSwitchNoticeFromHook(
                new ModelSwitchModule(history),
                database.context,
            );
            const text = textFromNotice(result);

            expect(text).toContain("History overview: 6 messages");
            expect(text).toContain("Beginning history excerpt:");
            expect(text).toContain("read_agent_history");
            // A history this short is covered by both bounded reads, and is quoted once.
            expect(text.match(/1\. USER/g)).toHaveLength(1);
            expect(text.match(/6\. USER/g)).toHaveLength(1);
        } finally {
            database.close();
        }
    });

    it("asks for the switching agent's own history, within the notice budget", async () => {
        const history = new ObservedHistory();
        const database = moduleDatabase(history.migrations, "model-switch-identity");
        await database.ready;

        try {
            await history.record(database.context, "target-agent", {
                blocks: [{ text: "only this agent's work", type: "text" }],
                recordId: "record-target",
                role: "user",
            });
            await history.record(database.context, "other-agent", {
                blocks: [{ text: "someone else's work", type: "text" }],
                recordId: "record-other",
                role: "user",
            });

            const result = await modelSwitchNoticeFromHook(
                new ModelSwitchModule(history),
                database.context,
                { agentId: "target-agent" },
            );
            const text = textFromNotice(result);

            expect(history.requests).toEqual(["target-agent:32000"]);
            expect(text).toContain("only this agent's work");
            expect(text).not.toContain("someone else's work");
        } finally {
            database.close();
        }
    });

    it("still explains the switch when the agent has no history recorded yet", async () => {
        const { history, database } = await historyWith("model-switch-empty-history", []);

        try {
            const result = await modelSwitchNoticeFromHook(
                new ModelSwitchModule(history),
                database.context,
            );
            const text = textFromNotice(result);

            expect(text).toContain("The conversation itself is not part of this context");
            expect(text).not.toContain("Beginning history excerpt:");
            // The tool is still named: the history exists, this agent just has nothing in it yet.
            expect(text).toContain("Use read_agent_history proactively");
        } finally {
            database.close();
        }
    });

    it("drops only the excerpt when the history cannot be read", async () => {
        const history = new UnreadableHistory();
        const database = moduleDatabase(history.migrations, "model-switch-unreadable");
        await database.ready;

        try {
            const result = await modelSwitchNoticeFromHook(
                new ModelSwitchModule(history),
                database.context,
            );
            const text = textFromNotice(result);

            expect(text).toContain("The conversation itself is not part of this context");
            expect(text).not.toContain("Beginning history excerpt:");
        } finally {
            database.close();
        }
    });

    it("carries nothing from one handoff to the next", async () => {
        const { history, database } = await historyWith("model-switch-repeated", [
            { blocks: [{ type: "text", text: "first" }] },
            { blocks: [{ type: "text", text: "second" }], role: "assistant" },
        ]);
        const module = new ModelSwitchModule(history);

        try {
            const first = await modelSwitchNoticeFromHook(module, database.context);
            const second = await modelSwitchNoticeFromHook(module, database.context);

            expect(textFromNotice(first)).toBe(textFromNotice(second));
            expect(textFromNotice(first)).toContain("History overview: 2 messages");
        } finally {
            database.close();
        }
    });

    it("still produces a notice for each of two simultaneous handoffs", async () => {
        const { history, database } = await historyWith("model-switch-concurrent", [
            { blocks: [{ type: "text", text: "first" }] },
        ]);
        const module = new ModelSwitchModule(history);

        try {
            // One writer at a time is the database's rule, not this module's problem: a read the
            // other handoff is holding the connection for costs an excerpt, never the switch.
            const notices = await Promise.all([
                modelSwitchNoticeFromHook(module, database.context),
                modelSwitchNoticeFromHook(module, database.context),
            ]);

            for (const notice of notices) {
                expect(textFromNotice(notice)).toContain("openai/gpt-5.6-sol on scripted");
            }
        } finally {
            database.close();
        }
    });
});

describe("ModelSwitchModule hook input boundaries", () => {
    it("does not mutate the caller's model change or the archive it quotes", async () => {
        const { history, database } = await historyWith("model-switch-immutable", [
            { blocks: [{ type: "text", text: "original" }] },
        ]);
        const change: AgentBaseModelChange = modelChange();
        const changeSnapshot = { ...change };

        try {
            await modelSwitchNoticeFromHook(new ModelSwitchModule(history), database.context, {
                change,
            });

            expect(change).toEqual(changeSnapshot);
            const page = await history.read(database.context, DEFAULT_AGENT_ID);
            expect(page.messages[0]?.message.blocks[0]).toEqual({
                text: "original",
                type: "text",
            });
        } finally {
            database.close();
        }
    });

    it("does not require a history to explain an incompatible reset", async () => {
        const database = moduleDatabase([], "model-switch-no-history");
        try {
            const result = await modelSwitchNoticeFromHook(
                new ModelSwitchModule(),
                database.context,
                {
                    change: modelChange({
                        previousModel: "old",
                        model: "new",
                    }),
                },
            );

            const text = textFromNotice(result);
            expect(text).toContain("old on scripted");
            expect(text).toContain("new on scripted");
            expect(text).toContain("Durable history lookup is unavailable");
        } finally {
            database.close();
        }
    });

    it("keeps a valid notice when provider/model identifiers are empty only if the hook contract supplied them", async () => {
        const database = moduleDatabase([], "model-switch-empty-identifiers");
        try {
            const result = await modelSwitchNoticeFromHook(
                new ModelSwitchModule(),
                database.context,
                {
                    change: modelChange({
                        previousModel: "",
                        model: "",
                        previousProvider: "old",
                        provider: "",
                    }),
                },
            );

            expect(textFromNotice(result)).toContain("changed from  on old to  on");
        } finally {
            database.close();
        }
    });
});
