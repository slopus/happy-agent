import { describe, expect, it } from "vitest";

import type { ProviderCli } from "../../sources/providerClis/index.js";
import { chatActionSegments } from "../../sources/onboarding/impl/chatActions/chatActionBlocks.js";
import {
    accountAddMessage,
    catalogMessage,
    chooseAtLeastOneMessage,
    connectFailedMessage,
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
    effortLabel,
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

    it("list only the AIs not connected yet, and never another account of one", () => {
        const catalog = catalogMessage(new Set(["codex"]));
        expect(catalog).toContain("Here's every AI I can connect:");
        expect(buttons(catalog)).toEqual([
            "Claude",
            "Grok",
            "Gemini (Antigravity)",
            "API key or something else",
        ]);
        expect(catalog).not.toContain("onboarding.accountAdd");
    });

    it("say the bootstrap exactly as the video script does, and that more can be connected later once", () => {
        expect(openingMessage()).toContain(
            "Hi, I'm Happy, your main agent. I run and coordinate agents across your work. The sidebar shows an example of what that looks like.",
        );
        const later = "You can always ask me to connect more later.";
        const signedIn = {
            ...INSTALLED,
            signIn: { status: "signed_in" as const, account: null, methods: [] },
        };
        const offered = subscriptionsMessage([], [signedIn], "Mac");
        expect(offered).toContain(
            "First, let's check which AI subscriptions you already use. I reuse what you pay for today, so there's nothing new to pay for. I found these on this Mac; choose which ones I should use.",
        );
        expect(offered.split(later)).toHaveLength(2);
        expect(offered).not.toContain("onboarding.accountAdd");
        expect(offered).toContain("data-emphasis>Use selected</button>");
        expect(offered).toContain(
            'data-action="onboarding.connectAnother">Sign in to more</button>',
        );
    });
});

describe("an effort as the app shows it", () => {
    it("reads exactly as the desktop model picker labels it", () => {
        expect(["off", "low", "medium", "high", "xhigh", "max"].map(effortLabel)).toEqual([
            "Off",
            "Low",
            "Medium",
            "High",
            "Extra High",
            "Maximum",
        ]);
    });
});

describe("the guide Happy's model follows", () => {
    it("names this computer's shortcut for Create", () => {
        expect(onboardingGuide("darwin")).toContain("in the sidebar, or ⌘N.");
        expect(onboardingGuide("win32")).toContain("in the sidebar, or Ctrl+N.");
        expect(onboardingGuide("linux")).not.toContain("⌘N");
    });

    it("has the model speak as itself, with the labels it must use exactly", () => {
        const guide = onboardingGuide("darwin");
        expect(guide).toContain("You are Happy, the person's main agent");
        expect(guide).not.toContain("—");
        expect(guide).toContain("Never put them inside a code fence.");
        // Focus is introduced once, as Happy's sub-agent, and handed the work by message.
        expect(guide).toContain("I'm handing this to Focus, my sub-agent");
        expect(guide).toContain("The press started Focus with its task");
        expect(guide).toContain('<figure data-sidebar-proposal="PROPOSAL_ID"></figure>');
        expect(guide).toContain(
            'sidebar.proposalAccept with data-proposal set to that ID, "Good to go"',
        );
        // The person may type at any step, and is told so once.
        expect(guide).toContain("The person may type instead of pressing, at any step");
        expect(guide).toContain(
            '"From here on, use the buttons or just message me anything below."',
        );
        expect(guide).toContain('("Connected to ChatGPT as ada@example.com."');
        expect(guide).not.toContain("propose_work");
        expect(guide).not.toContain("discover_work");
        expect(guide).toContain("write the step 2 message right away, in the same turn");
        expect(guide).toContain(
            'gemini "Gemini (Antigravity)", and other "API key or something else"',
        );
        expect(guide).toContain('"I\'ve downloaded and opened Happy"');
        expect(guide).not.toMatch(/coding and writing|anything extra/u);
    });
});
