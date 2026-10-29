import { describe, expect, it } from "vitest";

import type { ProviderCli } from "../../sources/providerClis/index.js";
import { chatActionSegments } from "../../sources/onboarding/impl/chatActions/chatActionBlocks.js";
import {
    accountAddMessage,
    catalogMessage,
    chooseAtLeastOneMessage,
    connectFailedMessage,
    connectedMessage,
    connectingMessage,
    installOfferMessage,
    manualMessage,
    noneYetMessage,
    otherConnectionMessage,
    restartMessage,
    signInOfferMessage,
    useFailedMessage,
    verifyFailedMessage,
} from "../../sources/onboarding/impl/connectingCopy.js";
import {
    openingMessage,
    subscriptionsMessage,
} from "../../sources/onboarding/impl/onboardingCopy.js";
import { onboardingGuide } from "../../sources/onboarding/impl/onboardingGuide.js";

function cli(overrides: Partial<ProviderCli>): ProviderCli {
    return {
        id: "claude",
        name: "Claude Code",
        vendor: "Anthropic",
        website: "https://claude.ai",
        providerId: "claude",
        installation: {
            status: "missing",
            path: null,
            version: null,
            source: null,
            desktopApp: null,
        },
        installer: {
            command: "curl -fsSL https://claude.ai/install.sh | bash",
            sourceUrl: "https://claude.ai/install.sh",
            sourceHost: "claude.ai",
            vendorSite: "https://claude.ai",
        },
        commands: { run: "claude", signIn: "claude auth login" },
        signIn: { status: "signed_out", account: null, methods: ["browser"] },
        operation: null,
        version: "1",
        updatedAt: 0,
        ...overrides,
    };
}

const MISSING = cli({});
const NO_INSTALLER = cli({
    id: "grok",
    name: "Grok CLI",
    vendor: "xAI",
    installer: null,
    commands: { run: "grok", signIn: "grok login" },
});
const INSTALLED = cli({
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    installation: {
        status: "installed",
        path: "/Applications/ChatGPT.app/codex",
        version: "1",
        source: "desktop_app",
        desktopApp: "ChatGPT",
    },
    commands: { run: "codex", signIn: "codex login" },
});

/** The labels of a message's buttons, the emphasized one marked with a star. */
function buttons(text: string): string[] {
    return chatActionSegments(text).flatMap((segment) =>
        segment.type === "actions" && segment.block?.kind === "buttons"
            ? segment.block.buttons.map((button) =>
                  button.emphasized === true ? `*${button.label}` : button.label,
              )
            : [],
    );
}

describe("Happy's own onboarding words", () => {
    it("speak in the first person, without em dashes", () => {
        const said = [
            subscriptionsMessage([], [], "Mac"),
            noneYetMessage(),
            otherConnectionMessage(),
            signInOfferMessage(INSTALLED, "codex", "Mac"),
            installOfferMessage(MISSING, "claude", "Mac"),
            manualMessage(MISSING, "claude"),
            manualMessage(NO_INSTALLER, "grok"),
            manualMessage(INSTALLED, "codex"),
            connectFailedMessage("claude", "The installer exited with an error."),
            connectingMessage("claude"),
            catalogMessage(new Set(["codex"])),
            accountAddMessage("codex", undefined),
            chooseAtLeastOneMessage(""),
            connectedMessage([{ app: "ChatGPT", account: "ada@example.com", cli: "codex" }]),
            useFailedMessage(
                "Claude",
                "My settings on this computer have no connection for it.",
                "claude",
            ),
            restartMessage(["OpenRouter"]),
            verifyFailedMessage("ChatGPT", "Your ChatGPT sign-in expired.", "codex"),
        ];
        for (const text of said) {
            expect(text).not.toMatch(/\bHappy\b/u);
            expect(text).not.toContain("—");
            expect(text).not.toContain("carry on");
        }
        expect(openingMessage()).toContain("Hi, I'm Happy, your main agent.");
        expect(openingMessage()).not.toContain("—");
        // No pricing or quality claims; whichever they already use comes first.
        expect(noneYetMessage()).toContain(
            "I reuse the subscription you already pay for, so there's nothing new to pay for.",
        );
        expect(noneYetMessage()).not.toMatch(/extra|coding and writing|general work/u);
    });

    it("offer a way on after every setback, and never push doing it for them after they declined", () => {
        expect(buttons(connectFailedMessage("claude", "It failed."))).toEqual([
            "*Try again",
            "I'd rather do it myself",
            "Choose another AI",
        ]);
        expect(buttons(manualMessage(MISSING, "claude"))).toEqual([
            "Install it for me instead",
            "Choose another AI",
        ]);
        expect(buttons(manualMessage(INSTALLED, "codex"))).toEqual([
            "Open the sign-in page instead",
            "Choose another AI",
        ]);
        expect(buttons(manualMessage(NO_INSTALLER, "grok"))).toEqual(["Choose another AI"]);
        expect(manualMessage(NO_INSTALLER, "grok")).toContain("Run this command,");
        expect(manualMessage(MISSING, "claude")).toContain("Run these commands");
        const failed = useFailedMessage(
            "Claude",
            "My settings on this computer have no connection for it.",
            "claude",
        );
        expect(failed).toContain(
            "I couldn't switch to Claude. My settings on this computer have no connection for it. Sign in to Claude, or choose another AI.",
        );
        expect(buttons(failed)).toEqual(["*Sign in to Claude", "Choose another AI"]);
    });

    it("list every AI with the connected ones last, checked rather than relabelled", () => {
        const catalog = catalogMessage(new Set(["codex"]));
        expect(catalog).toContain("Here's every AI I can connect:");
        expect(buttons(catalog)).toEqual([
            "Claude",
            "Grok",
            "Gemini (Antigravity)",
            "API key or something else",
            "ChatGPT",
        ]);
        expect(catalog).toContain(
            'data-provider="codex" data-mark="openai" data-connected>ChatGPT',
        );
    });

    it("say once, under Connected, that more can be connected later", () => {
        const later = "You can always ask me to connect more later.";
        const signedIn = {
            ...INSTALLED,
            signIn: { status: "signed_in" as const, account: null, methods: [] },
        };
        const offered = subscriptionsMessage([], [signedIn], "Mac");
        expect(offered).not.toContain(later);
        expect(chooseAtLeastOneMessage(offered)).not.toContain(later);
        expect(connectedMessage([{ app: "ChatGPT", cli: "codex" }]).split(later)).toHaveLength(2);
    });
});

describe("the guide Happy's model follows", () => {
    it("names this computer's shortcut for Create", () => {
        expect(onboardingGuide("darwin")).toContain("(or ⌘N)");
        expect(onboardingGuide("win32")).toContain("(or Ctrl+N)");
        expect(onboardingGuide("linux")).not.toContain("⌘N");
    });

    it("has the model speak as itself, with the labels it must use exactly", () => {
        const guide = onboardingGuide("darwin");
        expect(guide).toContain("You are Happy, the person's main agent");
        expect(guide).not.toContain("—");
        expect(guide).toContain("Never put them inside a code fence.");
        expect(guide).toContain(
            "call propose_work right away, with no words between the two calls",
        );
        expect(guide).toContain("write the step 2 message right away, in the same turn");
        expect(guide).toContain(
            'gemini "Gemini (Antigravity)", and other "API key or something else"',
        );
        expect(guide).toContain('"I\'ve downloaded and opened Happy"');
        expect(guide).not.toMatch(/coding and writing|anything extra/u);
    });
});
