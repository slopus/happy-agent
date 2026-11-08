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
            'call save_profile with exactly that name and email, then set_bot_name with "<First name>\'s Chief of Staff"',
        );
        expect(guide).toContain("Their press or reply is their consent; without it, read nothing.");
        // The consent names what find_recent_projects reads, and what it never does.
        expect(guide).toContain(
            "which folders their coding assistants worked in recently on this {{machine}}, and those projects' Git history, never file contents or conversations",
        );
        // Happy reads the recent work itself; the model never runs a shell or leaves the sandbox.
        expect(guide).toContain(
            "Call find_recent_projects to see their recent work, and nothing else",
        );
        expect(guide).toContain(
            "Never read assistant history, run the shell or ask to leave the sandbox for this.",
        );
        expect(recipe.tools).toContain("find_recent_projects");
        expect(guide).toContain("Never suggest a generic task.");
        expect(guide).toContain("at most three lines");
        expect(guide.indexOf("3. The first task, suggested.")).toBeLessThan(
            guide.indexOf("4. Started."),
        );
        expect(guide).toContain("Onboarding is finished only when you call finish_onboarding.");
        // The first task is a new top-level task, never the Chief of Staff's subtask.
        expect(guide).toContain(
            "Start it with start_first_task, never with create_subtask or create_agent",
        );
        expect(recipe.tools).toContain("start_first_task");
    });

    it("still starts a first task on a computer with no recent projects", () => {
        const guide = recipeText(recipe.guide);
        expect(guide).toContain("If you found nothing, the first task still starts now.");
        expect(guide).toContain(
            '"Clone a repo" when Git is installed, "Start a new project" and "I\'ll name a folder", then "Skip for now"',
        );
        expect(guide).toContain(
            "create_project with the path of a folder on this computer, clone_project for a repository, or for a new project create its folder, then call create_project. Then call start_first_task at once.",
        );
        // A clone with no work named still gets something concrete to do.
        expect(guide).toContain(
            "if they name no work, the work is getting it to build and its tests to run on this computer.",
        );
        // Both tools return before setup finishes, so the task is told to wait for it.
        expect(guide).toContain(
            "add that its setup may still be running, so it waits until the project is ready and reports it if setup fails.",
        );
        // A new folder has no Git history, so its task works in a copy, not on a branch.
        expect(guide).toContain(
            "A project without Git history, such as a new folder, gets a workspace of its own, a copy of the folder, instead of a fresh branch",
        );
        // Setting the project up is at hand while the model guides, not something to search for.
        expect(recipe.tools).toEqual(expect.arrayContaining(["create_project", "clone_project"]));
    });

    it("names every tool the recipe loads, and only those, as its onboarding tools", () => {
        const line = recipeText(recipe.guide)
            .split("\n")
            .find((text) => text.startsWith("- Your onboarding tools are "));
        const named = line
            ?.replace("- Your onboarding tools are ", "")
            .split(".")[0]!
            .split(/, | and /);
        expect(named?.sort()).toEqual([...recipe.tools!].sort());
    });

    it("never repeats a secret, and asks for a clone address without its token", () => {
        const guide = recipeText(recipe.guide);
        expect(guide).toContain("Never repeat or type a token, key, code or password.");
        expect(guide).toContain(
            "For a repository address with a token in it, ask for the address without it",
        );
    });

    it("renames the Chief of Staff after the person, or to the nickname they give", () => {
        const guide = recipeText(recipe.guide);
        expect(guide).toContain(
            "As soon as you know the person's first name, call set_bot_name with \"<First name>'s Chief of Staff\"",
        );
        expect(guide).toContain(
            'When they give you a nickname, call set_bot_name with it at once, start your next message with "<Nickname> it is."',
        );
        expect(recipe.tools).toContain("set_bot_name");
    });

    it("hands over when the first task's update says it finished, and claims nothing else", () => {
        const guide = recipeText(recipe.guide);
        for (const state of ["checkedOut", "waiting", "finished", "failed"]) {
            expect(guide).toContain(`\`${state}\``);
        }
        expect(guide).toContain("Never claim progress no taskUpdated event reported.");
        // The handover says plainly where the work is and how it reaches the person's folder.
        expect(guide).toContain(
            "Then say in one plain sentence where the work is and how it gets into their folder",
        );
        expect(guide).toContain("Never explain copies, checkouts or commits.");
        expect(guide).not.toContain("Nothing is committed");
        expect(guide).toContain(
            "7. Handover, when the task's taskUpdated says `finished`. Answer at once:",
        );
        expect(guide.indexOf("Call finish_onboarding, then close")).toBeGreaterThan(
            guide.indexOf("7. Handover"),
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
