import { describe, expect, it } from "vitest";

import type { HistoryMessage } from "../../sources/history/index.js";
import { findPressedControl } from "../../sources/onboarding/impl/findPressedControl.js";
import { openingMessage, providersTable } from "../../sources/onboarding/impl/onboardingCopy.js";
import type { ProviderCli } from "../../sources/providerClis/index.js";

function message(...texts: string[]): HistoryMessage {
    return {
        role: "assistant",
        recordId: "m1",
        blocks: texts.map((text) => ({ type: "text", text })),
        at: 1,
    } as HistoryMessage;
}

const claude = {
    id: "claude",
    name: "Claude Code",
    signIn: { status: "signed_in", account: { email: "a@example.com", plan: "Max" } },
} as unknown as ProviderCli;
const codex = {
    id: "codex",
    name: "Codex",
    signIn: { status: "signed_in", account: { email: "a@example.com", plan: "Plus" } },
} as unknown as ProviderCli;

describe("finding the control a press names", () => {
    it("finds the opening button by its exact action", () => {
        expect(
            findPressedControl(message(openingMessage()), {
                blockIndex: 0,
                action: { id: "onboarding.start", params: {} },
                values: [],
            }),
        ).toEqual({
            kind: "found",
            action: { id: "onboarding.start" },
            choice: { kind: "button", index: 0 },
        });
    });

    it("counts action blocks across text blocks, and refuses a block that is not there", () => {
        const twice = message(openingMessage(), `Again:\n\n${openingMessage()}`);
        expect(
            findPressedControl(twice, {
                blockIndex: 1,
                action: { id: "onboarding.start", params: {} },
                values: [],
            }),
        ).toMatchObject({ kind: "found" });
        expect(
            findPressedControl(twice, {
                blockIndex: 2,
                action: { id: "onboarding.start", params: {} },
                values: [],
            }),
        ).toEqual({ kind: "no_block" });
    });

    it("refuses an action or parameters the block does not hold", () => {
        const opening = message(openingMessage());
        expect(
            findPressedControl(opening, {
                blockIndex: 0,
                action: { id: "onboarding.finish", params: {} },
                values: [],
            }),
        ).toEqual({ kind: "mismatch" });
        expect(
            findPressedControl(opening, {
                blockIndex: 0,
                action: { id: "onboarding.start", params: { extra: "1" } },
                values: [],
            }),
        ).toEqual({ kind: "mismatch" });
    });

    it("accepts a checklist's own values and refuses any other", () => {
        const table = message(providersTable([claude, codex]));
        expect(
            findPressedControl(table, {
                blockIndex: 0,
                action: { id: "onboarding.providersUse", params: {} },
                values: ["claude"],
            }),
        ).toEqual({
            kind: "found",
            action: { id: "onboarding.providersUse", values: ["claude"] },
            choice: { kind: "checklist", values: ["claude"] },
        });
        expect(
            findPressedControl(table, {
                blockIndex: 0,
                action: { id: "onboarding.providersUse", params: {} },
                values: ["claude", "grok"],
            }),
        ).toEqual({ kind: "mismatch" });
    });

    it("numbers a checklist's other buttons after its submit", () => {
        const table = message(providersTable([claude]));
        expect(
            findPressedControl(table, {
                blockIndex: 0,
                action: { id: "onboarding.connectAnother", params: {} },
                values: [],
            }),
        ).toMatchObject({ kind: "found", choice: { kind: "button", index: 1 } });
    });

    it("takes Try Create's new chat as the value the app pressed it with", () => {
        const tryCreate = message(
            '<menu><button data-action="onboarding.newChat" data-emphasis>Try Create</button></menu>',
        );
        expect(
            findPressedControl(tryCreate, {
                blockIndex: 0,
                action: { id: "onboarding.newChat", params: {} },
                values: ["space-1"],
            }),
        ).toEqual({
            kind: "found",
            action: { id: "onboarding.newChat", values: ["space-1"] },
            choice: { kind: "button", index: 0 },
        });
    });
});
