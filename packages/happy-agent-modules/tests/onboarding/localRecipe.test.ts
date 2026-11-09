import { uiComponents } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import {
    checkOnboardingRecipe,
    recipeText,
} from "../../sources/onboarding/impl/checkOnboardingRecipe.js";
import { fillRecipeText } from "../../sources/onboarding/impl/fillRecipeText.js";
import { LOCAL_OFFER, effortLabel } from "../../sources/onboarding/impl/localWords.js";
import type { OnboardingModule, OnboardingRecipe } from "../../sources/onboarding/index.js";
import { startFirstTaskTool } from "../../sources/onboarding/tools/start_first_task.js";
import localRecipeJson from "../../sources/onboarding/recipes/local.json" with { type: "json" };

const recipe = localRecipeJson as OnboardingRecipe;
const bootstrap = recipe.bootstrap!;

/** Every variable the local runtime fills, with a value that has to be escaped. */
const VARIABLES: Record<string, string> = {
    botName: `Chief of "Staff" & <co>`,
    machine: "Mac",
    provider: "Claude",
    reason: "It's <not> working.",
    firstProjectRecipe: "/docs/recipe/first-project.md",
};

/** Each message the opening can say, filled as the daemon fills it. */
function said(): { name: string; text: string }[] {
    return [
        { name: "opening", text: fillRecipeText(bootstrap.say, VARIABLES) },
        ...(bootstrap.failed === undefined
            ? []
            : [{ name: "failed", text: fillRecipeText(bootstrap.failed, VARIABLES) }]),
    ];
}

describe("the local onboarding recipe", () => {
    it("fits its schema and everything the standalone daemon offers", () => {
        expect(checkOnboardingRecipe(localRecipeJson, LOCAL_OFFER)).toEqual([]);
    });

    it("opens with words and a sign-in for each AI, and takes no typing until one connects", () => {
        expect(bootstrap.offer).toEqual(["provider_sign_in"]);
        expect(bootstrap.typing).toBe("disabled");
        expect(bootstrap.failed).toBeDefined();
        expect(fillRecipeText(bootstrap.failed!, VARIABLES)).toContain(
            "It&#39;s &lt;not&gt; working.",
        );
    });

    it("offers answers with suggest_replies and controls with show_ui, never markup in its text", () => {
        for (const { name, text } of said()) expect(text, name).not.toMatch(/<[a-z]/u);
        const guide = recipeText(recipe.guide);
        expect(guide).not.toMatch(
            /<(?:menu|button|figure|output)\b|data-action|data-text|data-emphasis/u,
        );
        expect(guide).toContain(
            "Never write HTML, menus or buttons in your text: offer answers with suggest_replies and controls with show_ui.",
        );
        expect(recipe.tools).toContain("show_ui");
        expect(recipe.tools).toContain("suggest_replies");
        // Every component the guide teaches is one the catalog has.
        const known = new Set<string>(uiComponents.map((component) => component.type));
        const taught = guide
            .split("\n")
            .flatMap((line) => /^ {2}([a-z_]+) {3}\(/u.exec(line)?.[1] ?? []);
        expect(taught).toEqual(["provider_sign_in", "phone_app", "phone_pair", "default_model"]);
        for (const type of taught) expect(known.has(type), type).toBe(true);
    });

    it("speaks in the first person, never as Happy, and without em dashes or exclamation marks", () => {
        for (const { name, text } of said()) {
            expect(text, name).not.toMatch(/\bHappy\b/u);
            expect(text, name).not.toMatch(/I'm Chief of Staff/u);
            expect(text, name).not.toContain("—");
            expect(text, name).not.toContain("!");
        }
        expect(said()[0]!.text).toMatch(
            /^Hi, I'm your Chief of Staff\. Hand me the work you want done/u,
        );
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
        for (const { name, text } of said()) expect(text, name).not.toMatch(banned);
        // The guide names them only to forbid them.
        const guide = recipeText(recipe.guide)
            .split("\n")
            .filter((line) => !line.startsWith("- Confident, warm, specific, short."));
        for (const line of guide) expect(line).not.toMatch(banned);
    });

    it("says no price and names no AI better than another", () => {
        for (const { name, text } of said()) {
            expect(text, name).not.toMatch(/\$|extra cost|cheaper|better|best\b/iu);
        }
    });

    it("says the profile and suggests a first task from read-only evidence before the phone", () => {
        const guide = recipeText(recipe.guide);
        expect(guide).toContain(
            'call save_profile with exactly that name and email, then set_bot_name with "<First name>\'s Chief of Staff"',
        );
        expect(guide).toContain("Their reply is their consent; without it, read nothing.");
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
            "if they name no work, the work is getting it to build and its tests to run with what this {{machine}} already has.",
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

    it("briefs the first task so it never needs to leave its sandbox", () => {
        const guide = recipeText(recipe.guide);
        expect(guide).toContain(
            "Add that it verifies its work with tests and offline checks inside its sandbox, with no live network calls, installs or writes outside its workspace, and that when a live check would need that access, it says so at the end so the person can choose.",
        );
        expect(guide).toContain("Ask for nothing the person didn't, such as a live run");
        // A task told nothing about commits briefed its subtask to commit, which escalated.
        expect(guide).toContain(
            "it doesn't commit, push or publish, and in a project without Git history it never runs git init.",
        );
        expect(guide).toContain(
            'If the task said a live check needs access it doesn\'t have, say so in one sentence and let them choose: suggest "Run it live" and "Not now", in place of the next suggestion',
        );
        // The tool says the same, so a brief written without the guide at hand keeps to it too.
        const tool = startFirstTaskTool(
            {} as OnboardingModule,
            "agent",
            {} as Parameters<typeof startFirstTaskTool>[2],
        );
        expect(tool.description).toContain(
            "The person's first task must never need to leave its sandbox. Have text say that it verifies its work with tests and offline checks, with no live network calls, installs or writes outside its workspace",
        );
        expect(tool.description).toContain(
            "it doesn't commit, push or publish, and in a project without Git history it never runs git init.",
        );
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
            "Then exactly one sentence on where the work is and how to get it into their folder",
        );
        expect(guide).toContain(
            "Never say what their folder doesn't have yet, and never mention copies, checkouts, commits, authors, pushing, publishing or the sandbox, even when the task's summary or its messages to you do.",
        );
        expect(guide).not.toContain("Nothing is committed");
        expect(guide).toContain(
            "7. Handover, when the task's taskUpdated says `finished`. Answer at once:",
        );
        expect(guide.indexOf("Call finish_onboarding, then close")).toBeGreaterThan(
            guide.indexOf("7. Handover"),
        );
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
