import type { ProviderCli } from "../../providerClis/index.js";
import type { ChatProviderId } from "./chatActions/chatAction.js";
import { chatActionEscape } from "./chatActions/chatActionBlocks.js";
import { APP_OF, MARK_OF, PROVIDER_BUTTONS, PROVIDER_OF, listOf, menu } from "./onboardingCopy.js";

/**
 * Happy's words while an AI is chosen and connected, in the inline action grammar. The desktop's
 * flow on `chat-onboarding` is the reference for their wording.
 */

/** One AI the person connected, as Happy names it to them and to its model. */
export interface OnboardingConnection {
    /** As the person knows it, such as "Claude" or "OpenRouter". */
    readonly app: string;
    readonly account?: string;
    /** Its provider CLI, whose history Happy knows where to find, when it is one. */
    readonly cli?: ChatProviderId;
}

export function noneYetMessage(): string {
    return [
        "I work through your own AI account. I reuse the subscription you already pay for, so there's nothing new to pay for. Start with the one you already use, ChatGPT or Claude; your account may already include access.\n\nChoose one to sign in or create an account. I'll continue here as soon as you're connected.",
        "",
        menu(
            '<button data-action="onboarding.provider" data-provider="chatgpt" data-mark="openai" data-emphasis>Connect ChatGPT</button>',
            '<button data-action="onboarding.provider" data-provider="claude" data-mark="claude">Connect Claude</button>',
            '<button data-action="onboarding.connectAnother">See all options</button>',
        ),
    ].join("\n");
}

export function otherConnectionMessage(): string {
    return [
        "You can connect an API key, a company account, or a custom endpoint. Add it in the connection window, and I'll continue here as soon as it's ready.",
        "",
        menu(
            '<button data-action="onboarding.apiKeyOpen" data-emphasis>Add a connection</button>',
            '<button data-action="onboarding.connectAnother">Use a subscription instead</button>',
        ),
    ].join("\n");
}

/** The program is here and signed out: Happy offers the vendor's own sign-in. */
export function signInOfferMessage(cli: ProviderCli, id: ChatProviderId, machine: string): string {
    const inside = cli.installation.desktopApp
        ? ` inside the ${cli.installation.desktopApp} app`
        : "";
    return [
        `${cli.name} is already on this ${machine}${inside}. I'll open ${cli.vendor}'s sign-in page so you can connect your ${APP_OF[id]} account.`,
        "",
        menu(
            `<button data-action="onboarding.connect" data-provider="${id}" data-mark="${MARK_OF[id]}" data-emphasis>${chatActionEscape(`Sign in to ${APP_OF[id]}`)}</button>`,
            `<button data-action="onboarding.manual" data-provider="${id}">I'd rather do it myself</button>`,
        ),
    ].join("\n");
}

/** The program is missing: exactly what Happy will run, and from where, before it runs it. */
export function installOfferMessage(cli: ProviderCli, id: ChatProviderId, machine: string): string {
    const installer = cli.installer!;
    return [
        `${cli.name} isn't on this ${machine} yet. I'll download ${cli.vendor}'s official installer from **${installer.sourceHost}** and start signing you in. This is the exact command I'll run:\n\n\`\`\`sh\n${installer.command}\n\`\`\`\n\nOnce installed, you can also run ${cli.name} directly in your terminal with \`${cli.commands.run}\`.`,
        "",
        menu(
            `<button data-action="onboarding.connect" data-provider="${id}" data-mark="${MARK_OF[id]}" data-emphasis>Install and sign in</button>`,
            `<button data-action="onboarding.manual" data-provider="${id}">I'd rather do it myself</button>`,
        ),
    ].join("\n");
}

/**
 * The commands to run by hand; Happy continues when it finds the sign-in. Doing it for them is
 * offered again only when Happy can, and never as the emphasized choice: they just declined it.
 */
export function manualMessage(cli: ProviderCli | undefined, id: ChatProviderId): string {
    const name = cli?.name ?? APP_OF[id];
    const installed = cli?.installation.status === "installed";
    const install = cli !== undefined && !installed && cli.installer;
    const commands = [...(install ? [install.command] : []), cli?.commands.signIn ?? `${id} login`];
    const back = installed
        ? "Open the sign-in page instead"
        : install
          ? "Install it for me instead"
          : undefined;
    return [
        [
            commands.length === 1
                ? `Set up ${name} in your terminal. Run this command, and I'll continue here as soon as you're signed in:`
                : `Run these commands in your terminal. I'll continue here as soon as ${name} is signed in:`,
            ...commands.map((command) => `\`\`\`sh\n${command}\n\`\`\``),
        ].join("\n\n"),
        "",
        `<output data-status="running">${chatActionEscape(`Waiting for ${APP_OF[id]} sign-in…`)}</output>`,
        "",
        menu(
            ...(back === undefined
                ? []
                : [
                      `<button data-action="onboarding.connect" data-provider="${id}">${chatActionEscape(back)}</button>`,
                  ]),
            '<button data-action="onboarding.connectAnother">Choose another AI</button>',
        ),
    ].join("\n");
}

export function connectFailedMessage(id: ChatProviderId, reason: string): string {
    return [
        `That didn't work: ${reason}`,
        "",
        menu(
            `<button data-action="onboarding.connect" data-provider="${id}" data-emphasis>Try again</button>`,
            `<button data-action="onboarding.manual" data-provider="${id}">I'd rather do it myself</button>`,
            '<button data-action="onboarding.connectAnother">Choose another AI</button>',
        ),
    ].join("\n");
}

/**
 * The connecting message, written once: the app draws the install and sign-in live from the
 * provider CLI figure, with its own page, code field, Cancel, and Try again, so nothing here is
 * ever rewritten.
 */
export function connectingMessage(id: ChatProviderId): string {
    return [
        `Connecting ${APP_OF[id]}. I'll continue here as soon as you're signed in.`,
        "",
        `<figure data-provider-cli="${id}"></figure>`,
        "",
        menu(
            `<button data-action="onboarding.manual" data-provider="${id}">I'd rather do it myself</button>`,
            '<button data-action="onboarding.connectAnother">Choose another AI</button>',
        ),
    ].join("\n");
}

/**
 * Every AI Happy can connect that is not connected yet. A connected one is left out: a second
 * account of the same AI is not offered until more than one can be used.
 */
export function catalogMessage(connected: ReadonlySet<ChatProviderId>): string {
    const offered = PROVIDER_BUTTONS.filter((button) => {
        if (button.choice === "none") return false;
        return button.choice === "other" || !connected.has(PROVIDER_OF[button.choice]);
    });
    return [
        "Here's every AI I can connect:",
        "",
        menu(
            ...offered.map((button) => {
                const mark = button.mark ? ` data-mark="${button.mark}"` : "";
                return `<button data-action="onboarding.provider" data-provider="${button.choice}"${mark}>${chatActionEscape(button.label)}</button>`;
            }),
        ),
    ].join("\n");
}

/** A second account is not offered yet; `then` is what to choose instead, if anything. */
export function accountAddMessage(
    id: ChatProviderId | undefined,
    then: string | undefined,
): string {
    const app = id === undefined ? "" : `${APP_OF[id]} `;
    return [
        id === undefined
            ? "Adding a second account isn't available yet."
            : `Adding a second ${app}account isn't available yet. Your current ${app}account stays connected.`,
        ...(then === undefined ? [] : ["", then]),
    ].join("\n");
}

export function chooseAtLeastOneMessage(table: string): string {
    return ["Select at least one account to use, or sign in to another AI.", "", table].join("\n");
}

export function useFailedMessage(
    app: string,
    reason: string,
    cli: ChatProviderId | undefined,
): string {
    return [
        `I couldn't switch to ${app}. ${/[.!?]$/u.test(reason) ? reason : `${reason}.`} ${cli === undefined ? "Choose another AI." : `Sign in to ${APP_OF[cli]}, or choose another AI.`}`,
        "",
        menu(
            ...(cli === undefined
                ? []
                : [
                      `<button data-action="onboarding.connect" data-provider="${cli}" data-mark="${MARK_OF[cli]}" data-emphasis>${chatActionEscape(`Sign in to ${APP_OF[cli]}`)}</button>`,
                  ]),
            `<button data-action="onboarding.connectAnother"${cli === undefined ? " data-emphasis" : ""}>Choose another AI</button>`,
        ),
    ].join("\n");
}

export function restartMessage(names: readonly string[]): string {
    return `${listOf(names)} ${names.length === 1 ? "is" : "are"} set up. I'm restarting now to switch over and will pick right back up.`;
}

/**
 * Happy's first answer on the AI the person chose failed: what failed, and the way to fix it.
 * `others` is the table of the other AIs already found, to choose from instead, when there are any.
 */
export function verifyFailedMessage(
    app: string,
    error: string,
    cli: ChatProviderId | undefined,
    others?: string,
): string {
    const again =
        cli === undefined
            ? []
            : [
                  `<button data-action="onboarding.connect" data-provider="${cli}" data-mark="${MARK_OF[cli]}" data-emphasis>${chatActionEscape(`Sign in to ${APP_OF[cli]} again`)}</button>`,
              ];
    const reason = `I couldn't get an answer from ${app}. ${/[.!?]$/u.test(error) ? error : `${error}.`}`;
    if (others !== undefined) {
        return [
            reason,
            ...(again.length === 0 ? [] : ["", menu(...again)]),
            "",
            "Or use another AI I found:",
            "",
            others,
        ].join("\n");
    }
    return [
        reason,
        "",
        menu(
            ...again,
            `<button data-action="onboarding.connectAnother"${cli === undefined ? " data-emphasis" : ""}>Choose another AI</button>`,
        ),
    ].join("\n");
}
