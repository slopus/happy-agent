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

/** Every AI Happy can connect, the connected ones last with their check. */
export function catalogMessage(connected: ReadonlySet<ChatProviderId>): string {
    const offered = PROVIDER_BUTTONS.filter((button) => button.choice !== "none");
    const idOf = (button: (typeof PROVIDER_BUTTONS)[number]) =>
        button.choice === "other" || button.choice === "none"
            ? undefined
            : PROVIDER_OF[button.choice];
    const isConnected = (button: (typeof PROVIDER_BUTTONS)[number]) => {
        const id = idOf(button);
        return id !== undefined && connected.has(id);
    };
    const control = (button: (typeof PROVIDER_BUTTONS)[number]) => {
        const id = idOf(button);
        const mark = button.mark ? ` data-mark="${button.mark}"` : "";
        return id !== undefined && connected.has(id)
            ? `<button data-action="onboarding.accountAdd" data-provider="${id}"${mark} data-connected>${chatActionEscape(button.label)}</button>`
            : `<button data-action="onboarding.provider" data-provider="${button.choice}"${mark}>${chatActionEscape(button.label)}</button>`;
    };
    return [
        "Here's every AI I can connect:",
        "",
        menu(
            ...offered.filter((button) => !isConnected(button)).map(control),
            ...offered.filter(isConnected).map(control),
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

/**
 * Connected, and what else can be: the AIs not connected yet first, the connected ones at the
 * far end with their check, then another account of a connected one, which carries no check:
 * a second account is welcome, and a check there read as if it were already added. None of it has
 * to be answered.
 */
export function connectedMessage(connections: readonly OnboardingConnection[]): string {
    const first = connections[0]!;
    const connectedIds = new Set(connections.flatMap((each) => (each.cli ? [each.cli] : [])));
    const offered = PROVIDER_BUTTONS.filter((entry) => entry.choice !== "none");
    const idOf = (entry: (typeof PROVIDER_BUTTONS)[number]) =>
        entry.choice === "none" || entry.choice === "other" ? undefined : PROVIDER_OF[entry.choice];
    const isConnected = (entry: (typeof PROVIDER_BUTTONS)[number]) => {
        const id = idOf(entry);
        return id !== undefined && connectedIds.has(id);
    };
    const button = (entry: (typeof PROVIDER_BUTTONS)[number]) => {
        const mark = entry.mark ? ` data-mark="${entry.mark}"` : "";
        const id = idOf(entry);
        return id !== undefined && connectedIds.has(id)
            ? `<button data-action="onboarding.accountAdd" data-provider="${id}"${mark} data-connected>${chatActionEscape(entry.label)}</button>`
            : `<button data-action="onboarding.provider" data-provider="${entry.choice}"${mark}>${chatActionEscape(entry.label)}</button>`;
    };
    const lead =
        connections.length === 1
            ? `Connected to ${first.app}${first.account ? ` as ${first.account}` : ""}.`
            : `Connected to ${listOf(connections.map((each) => each.app))}.`;
    return [
        `${lead} You can also type to me below anytime, or connect another AI${connections.length === 1 ? " if you use more than one" : ""}:`,
        "",
        menu(
            ...offered.filter((entry) => !isConnected(entry)).map(button),
            ...offered.filter(isConnected).map(button),
        ),
        ...(connectedIds.size === 0
            ? []
            : [
                  "",
                  menu(
                      ...[...connectedIds].map(
                          (id) =>
                              `<button data-action="onboarding.accountAdd" data-provider="${id}" data-mark="${MARK_OF[id]}">${chatActionEscape(`Add another ${APP_OF[id]} account`)}</button>`,
                      ),
                  ),
              ]),
        "",
        '<output data-status="info">You can always ask me to connect more later.</output>',
    ].join("\n");
}

/** The AI chosen can't be used: the real cause, then signing in to it or choosing another. */
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

/** Happy's first answer on the AI the person chose failed: what failed, and the way to fix it. */
export function verifyFailedMessage(
    app: string,
    error: string,
    cli: ChatProviderId | undefined,
): string {
    return [
        `I couldn't get an answer from ${app}. ${/[.!?]$/u.test(error) ? error : `${error}.`}`,
        "",
        menu(
            ...(cli === undefined
                ? []
                : [
                      `<button data-action="onboarding.connect" data-provider="${cli}" data-mark="${MARK_OF[cli]}" data-emphasis>${chatActionEscape(`Sign in to ${APP_OF[cli]} again`)}</button>`,
                  ]),
            `<button data-action="onboarding.connectAnother"${cli === undefined ? " data-emphasis" : ""}>Choose another AI</button>`,
        ),
    ].join("\n");
}
