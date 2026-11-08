import {
    chatActionBlocksOf,
    stripChatActionBlocks,
    type ChatActionBlock,
    type ChatActionButton,
} from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import {
    checkOnboardingRecipe,
    recipeText,
} from "../../sources/onboarding/impl/checkOnboardingRecipe.js";
import { fillRecipeText, recipeVariables } from "../../sources/onboarding/impl/fillRecipeText.js";
import {
    LOCAL_OFFER,
    codeBlock,
    effortLabel,
    providerMenu,
    routesTable,
} from "../../sources/onboarding/impl/localWords.js";
import type { OnboardingRecipe } from "../../sources/onboarding/index.js";
import localRecipeJson from "../../sources/onboarding/recipes/local.json" with { type: "json" };
import type { ProviderRoute } from "../../sources/providerRoutes/index.js";

const recipe = localRecipeJson as OnboardingRecipe;
const steps = recipe.bootstrap.steps;

function route(overrides: Partial<ProviderRoute>): ProviderRoute {
    return {
        id: "claude",
        kind: "direct",
        name: "Claude Code",
        vendors: ["Anthropic"],
        billing: "subscription",
        account: { label: null, email: "ada@example.com", plan: "Max", count: null },
        endpoint: null,
        status: "ready",
        models: null,
        overlaps: [],
        recommended: true,
        warning: null,
        providerId: "claude",
        use: null,
        ...overrides,
    };
}

const ROUTES = [
    route({}),
    route({
        id: "openrouter",
        kind: "router",
        name: "OpenRouter",
        vendors: ["Anthropic", "OpenAI"],
        billing: "pay_per_token",
        account: null,
        recommended: false,
        providerId: null,
        use: {
            providerId: "openrouter",
            type: "openrouter",
            summary: "OpenRouter",
            restartRequired: true,
        },
    }),
];

/** Every variable the local runtime fills, with a value that has to be escaped. */
const VARIABLES: Record<string, string> = {
    botName: `Chief of "Staff" & <co>`,
    machine: "Mac",
    provider: "Claude",
    providerCli: "claude",
    providerMark: "claude",
    cliName: "Claude Code",
    vendor: "Anthropic",
    installHost: "claude.ai",
    reason: "It's <not> working.",
    routesReady: "OpenRouter is",
};

const BLOCKS: Record<string, string> = {
    routesTable: routesTable(ROUTES),
    providerMenu: providerMenu({ withNone: true }),
    providerCatalog: providerMenu({ withNone: false }),
    installCommand: codeBlock("curl -fsSL https://claude.ai/install.sh | bash"),
    signInCommand: codeBlock("claude auth login"),
    firstProjectRecipe: "/docs/recipe/first-project.md",
};

/** Each message a step can say, filled as the daemon fills it. */
function said(): { step: string; text: string }[] {
    return Object.entries(steps).flatMap(([step, definition]) =>
        (definition.say ?? []).map((entry) => ({
            step,
            text: fillRecipeText(entry.text, VARIABLES, BLOCKS),
        })),
    );
}

function controls(block: ChatActionBlock): ChatActionButton[] {
    if (block.kind === "menu") return [...block.buttons];
    if (block.kind === "checklist") return [...block.others];
    return [];
}

/** The labels of a message's buttons, the emphasized one marked with a star. */
function buttons(text: string): string[] {
    return chatActionBlocksOf(text).flatMap((block) =>
        block === undefined
            ? []
            : controls(block).map((button) =>
                  button.emphasized ? `*${button.label}` : button.label,
              ),
    );
}

describe("the local onboarding recipe", () => {
    it("fits its schema and everything the standalone daemon offers", () => {
        expect(checkOnboardingRecipe(localRecipeJson, LOCAL_OFFER)).toEqual([]);
    });

    it("reaches every step from its start", () => {
        const reached = new Set<string>();
        const visit = (target: string) => {
            if (reached.has(target) || !Object.hasOwn(steps, target)) return;
            reached.add(target);
            const step = steps[target]!;
            for (const next of Object.keys(step.next ?? {})) visit(next);
            for (const next of Object.values(step.effect?.then ?? {})) visit(next);
        };
        visit(recipe.bootstrap.start);
        if (recipe.bootstrap.handoffFailed !== undefined) visit(recipe.bootstrap.handoffFailed);
        expect([...reached].sort()).toEqual(Object.keys(steps).sort());
    });

    it("writes only blocks the client can read, and every control leads where its step allows", () => {
        for (const { step, text } of said()) {
            const blocks = chatActionBlocksOf(text);
            expect(blocks, `${step}: ${text}`).not.toContain(undefined);
            const next = steps[step]!.next ?? {};
            for (const block of blocks) {
                const pressable = [
                    ...controls(block!).flatMap((button) => (button.action ? [button.action] : [])),
                    ...(block!.kind === "checklist" && block!.action ? [block!.action] : []),
                ];
                for (const action of pressable) {
                    expect(action.id, step).toBe("onboarding.next");
                    const target = action.params["step"] ?? "";
                    expect(Object.keys(next), `${step} → ${target}`).toContain(target);
                    const rule = next[target]!;
                    for (const [name, value] of Object.entries(action.params)) {
                        if (name === "step") continue;
                        const declared = rule.params?.[name];
                        expect(declared, `${step} → ${target}: data-${name}`).toBeDefined();
                        if (declared?.values !== undefined)
                            expect(declared.values).toContain(value);
                    }
                    if (block!.kind === "checklist" && action === block!.action) {
                        expect(rule.values, `${step} → ${target}`).toBe("checklist");
                    }
                }
            }
        }
    });

    it("speaks in the first person, never as Happy, and without em dashes or exclamation marks", () => {
        for (const { step, text } of said()) {
            expect(text, step).not.toMatch(/\bHappy\b/u);
            expect(text, step).not.toMatch(/I'm Chief of Staff/u);
            // A table's empty cell may show a dash; the words around it never do.
            expect(stripChatActionBlocks(text), step).not.toContain("—");
            expect(text, step).not.toContain("!");
        }
        for (const entry of steps["providers"]!.say!) {
            expect(fillRecipeText(entry.text, VARIABLES, BLOCKS)).toMatch(
                /^Hi, I'm your Chief of Staff\. Hand me the work you want done/u,
            );
        }
        // The guide names Happy only as the phone app.
        const guide = recipeText(recipe.guide);
        expect(guide).not.toContain("—");
        expect(guide).not.toContain("!");
        expect(
            guide
                .replace(
                    `Never call yourself "Happy" or "Happy Agent"; Happy is the phone app.`,
                    "",
                )
                .replaceAll("I've opened Happy", "")
                .replaceAll("In Happy on your phone", "")
                .replace("put Happy on their phone", "")
                // Happy Cloud is the account service, named as the source of a profile.
                .replace("their Happy Cloud account", ""),
        ).not.toMatch(/\bHappy\b/u);
    });

    it("uses no filler, hype, hedging, or sign-offs", () => {
        const banned =
            /\b(?:Great|Awesome|Perfect|powerful|seamless|supercharge|I think|maybe|Enjoy|Have a good one)\b/iu;
        for (const { step, text } of said()) expect(text, step).not.toMatch(banned);
        // The guide names them only to forbid them.
        const guide = recipeText(recipe.guide)
            .split("\n")
            .filter((line) => !line.startsWith("- Confident, warm, specific, short."));
        for (const line of guide) expect(line).not.toMatch(banned);
    });

    it("labels each button in a few words of the person's own, never a bare Done", () => {
        for (const { step, text } of said()) {
            for (const label of buttons(text)) {
                const words = label.replace(/^\*/u, "").split(/\s+/u);
                // Four words is the aim; the final script keeps a few of five, such as "Sign in to
                // another AI".
                expect(words.length, `${step}: ${label}`).toBeLessThanOrEqual(5);
                expect(label.replace(/^\*/u, ""), step).not.toBe("Done");
            }
        }
    });

    it("offers a way on after every setback", () => {
        const failures = ["connect-failed", "use-failed", "verify-failed", "choose-at-least-one"];
        for (const step of failures) {
            for (const entry of steps[step]!.say!) {
                expect(
                    buttons(fillRecipeText(entry.text, VARIABLES, BLOCKS)).length,
                    step,
                ).toBeGreaterThan(0);
            }
        }
        expect(
            buttons(fillRecipeText(steps["connect-failed"]!.say![0]!.text, VARIABLES, BLOCKS)),
        ).toEqual(["*Try again", "I'll do it myself", "Choose another AI"]);
        expect(
            buttons(fillRecipeText(steps["use-failed"]!.say![0]!.text, VARIABLES, BLOCKS)),
        ).toEqual(["*Sign in again", "Choose another AI"]);
    });

    it("says no price and names no AI better than another", () => {
        for (const { step, text } of said()) {
            expect(text, step).not.toMatch(/\$|extra cost|cheaper|better|best\b/iu);
        }
        expect(fillRecipeText(steps["none-yet"]!.say![0]!.text, VARIABLES, BLOCKS)).toContain(
            "If your work already pays for ChatGPT or Claude, sign in with that account.",
        );
    });

    it("asks with at most one set of controls, after any figure, and ends with it", () => {
        for (const { step, text } of said()) {
            const blocks = chatActionBlocksOf(text);
            const asks = blocks.flatMap((block, index) =>
                block!.kind === "menu" || block!.kind === "checklist" || block!.kind === "code"
                    ? [index]
                    : [],
            );
            expect(asks.length, step).toBeLessThanOrEqual(1);
            const ask = asks[0];
            if (ask === undefined) continue;
            // Only a status line may follow the controls, such as a hint under the routes table.
            for (const block of blocks.slice(ask + 1)) expect(block!.kind, step).toBe("status");
        }
    });

    it("emphasizes at most one control in each block, and none where the person picks an AI", () => {
        for (const { step, text } of said()) {
            for (const block of chatActionBlocksOf(text)) {
                const emphasized =
                    controls(block!).filter((button) => button.emphasized).length +
                    (block!.kind === "checklist" && block!.submit.emphasized ? 1 : 0);
                expect(emphasized, step).toBeLessThanOrEqual(1);
                // No AI is recommended over another.
                const picksAnAi = controls(block!).some(
                    (button) => button.action?.params["step"] === "choose",
                );
                if (picksAnAi) expect(emphasized, step).toBe(0);
            }
        }
    });

    it("says the profile and suggests a first task from read-only evidence before the phone", () => {
        const guide = recipeText(recipe.guide);
        expect(guide).toContain(
            "first call save_profile with exactly that name and email, then say it in one sentence",
        );
        expect(guide).toContain("Their press or reply is their consent; without it, read nothing.");
        expect(guide).toContain("read only Git metadata");
        expect(guide).toContain("Never suggest a generic task.");
        expect(guide).toContain("at most three lines");
        expect(guide.indexOf("3. The first task, suggested.")).toBeLessThan(
            guide.indexOf("4. The phone, while the task runs."),
        );
        expect(guide).toContain(
            "Onboarding is finished only when you call finish_onboarding. Never call it before you have offered the first task, unless they say to stop setting up.",
        );
    });

    it("fills only the blocks a text uses", () => {
        expect([...recipeVariables(steps["providers"]!.say![0]!.text)].sort()).toEqual([
            "machine",
            "routesTable",
        ]);
    });
});

describe("an effort as the app shows it", () => {
    it("reads exactly as the desktop model picker labels it", () => {
        expect(["off", "low", "medium", "high", "xhigh", "max", "turbo"].map(effortLabel)).toEqual([
            "Off",
            "Low",
            "Medium",
            "High",
            "Extra High",
            "Maximum",
            "Turbo",
        ]);
    });
});

describe("the routes table", () => {
    it("ticks the token Claude uses, and says the same on the sign-in it replaces", () => {
        const table = routesTable([
            route({
                recommended: false,
                warning:
                    "CLAUDE_CODE_OAUTH_TOKEN is set, so that token is used instead of this sign-in.",
            }),
            route({
                id: "env:CLAUDE_CODE_OAUTH_TOKEN",
                kind: "api_key",
                name: "Claude Code token",
                account: null,
                recommended: true,
                warning:
                    "CLAUDE_CODE_OAUTH_TOKEN is set, so this token is used instead of your Claude Code sign-in.",
            }),
        ]);
        const [block] = chatActionBlocksOf(table);
        if (block?.kind !== "checklist") throw new Error("The routes table is not a checklist.");
        expect(
            block.options.map((option) => [
                option.value,
                option.checked,
                option.detail,
                option.cells,
            ]),
        ).toEqual([
            [
                "claude",
                false,
                "CLAUDE_CODE_OAUTH_TOKEN is set, so that token is used instead of this sign-in.",
                ["Direct", "ada@example.com · Max"],
            ],
            [
                "env:CLAUDE_CODE_OAUTH_TOKEN",
                true,
                "CLAUDE_CODE_OAUTH_TOKEN is set, so this token is used instead of your Claude Code sign-in.",
                ["Token", "—"],
            ],
        ]);
    });
});
