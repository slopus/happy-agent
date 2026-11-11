import { describe, expect, it, vi } from "vitest";

import type { UserInputModule } from "../../sources/userInput/UserInputModule.js";
import {
    createPresenceModule,
    createUserInputDatabase,
    createUserInputModule,
} from "./userInputTestSupport.js";

const agentId = "agent-one";
const ask = {
    agentId,
    harnessId: "claude_code",
    harnessName: "Claude Code",
    action: "rm -rf ../build\n```\nclosing a fence",
    allowForSession: true,
};

async function pendingId(module: UserInputModule, ctx: Parameters<UserInputModule["list"]>[0]) {
    let id: string | undefined;
    await vi.waitFor(async () => {
        id = (await module.list(ctx, agentId, { status: "pending" }))[0]?.id;
        expect(id).toBeDefined();
    });
    return id!;
}

describe("a foreign harness's permission ask", () => {
    it("is a permission question from the harness, and only an allow option allows", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-harness-answers");
        await database.ready;
        try {
            const answered = async (answer: string | { selectedOptions: string[] }) => {
                const running = module.askHarnessPermission(
                    database.context,
                    ask,
                    new AbortController().signal,
                );
                const requestId = await pendingId(module, database.context);
                const request = await module.get(database.context, agentId, requestId);
                expect(request).toMatchObject({
                    permissionRequest: {
                        source: "harness",
                        server: "claude_code",
                        serverTitle: "Claude Code",
                    },
                });
                // The action's own backticks cannot end the block it is shown in.
                expect(request?.context).toContain(
                    "````\nrm -rf ../build\n```\nclosing a fence\n````",
                );
                await module.answer(database.context, agentId, {
                    requestId,
                    answers: { permission: answer as never },
                });
                return await running;
            };
            expect(await answered("Allow once")).toBe("allow_once");
            expect(await answered({ selectedOptions: ["Allow for this session"] })).toBe(
                "allow_for_session",
            );
            expect(await answered("Deny")).toBe("deny");
            expect(await answered("Sure, go ahead")).toBe("deny");
        } finally {
            database.close();
        }
    });

    it("is denied, not cancelled, when nobody can answer", async () => {
        const presence = createPresenceModule();
        const module = createUserInputModule(presence);
        const database = createUserInputDatabase(module, "user-input-harness-away");
        await database.ready;
        try {
            await presence.setPresence(database.context, { status: "away" });
            await expect(
                module.askHarnessPermission(database.context, ask, new AbortController().signal),
            ).resolves.toBe("deny");
        } finally {
            database.close();
        }
    });

    it("is withdrawn and cancelled when the turn stops", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-harness-withdrawn");
        await database.ready;
        try {
            const stop = new AbortController();
            const running = module.askHarnessPermission(database.context, ask, stop.signal);
            const requestId = await pendingId(module, database.context);
            stop.abort();
            await expect(running).resolves.toBe("cancelled");
            expect(await module.get(database.context, agentId, requestId)).toMatchObject({
                status: "cancelled",
            });
        } finally {
            database.close();
        }
    });
});
