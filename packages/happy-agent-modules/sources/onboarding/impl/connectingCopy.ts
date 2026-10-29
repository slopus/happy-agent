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
        "Happy uses an AI account you pay the AI company for directly. I'd start with ChatGPT for general work, or Claude if that's the one you prefer. Check the company's current plans; your account may already include access.\n\nChoose one and I'll help you connect it. We'll carry on here as soon as you're signed in.",
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
        "You can connect an API key, a company account, or a custom endpoint. Add it in its own window, and I'll carry on here once it works.",
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
        ? `, inside the ${cli.installation.desktopApp} app`
        : "";
    return [
        `${cli.name} is already on this ${machine}${inside}. I'll open ${cli.vendor}'s sign-in page so you can connect your account.`,
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
        `${cli.name} isn't on this ${machine} yet. I'll download it from **${installer.sourceHost}**, ${cli.vendor}'s official installer, and then start signing you in. This is exactly what I'll run:\n\n\`\`\`sh\n${installer.command}\n\`\`\`\n\nOnce it's installed, you can also use ${cli.name} on its own in your terminal: run \`${cli.commands.run}\`.`,
        "",
        menu(
            `<button data-action="onboarding.connect" data-provider="${id}" data-mark="${MARK_OF[id]}" data-emphasis>Install and sign in</button>`,
            `<button data-action="onboarding.manual" data-provider="${id}">I'd rather do it myself</button>`,
        ),
    ].join("\n");
}

/** The commands to run by hand; Happy carries on when it finds the sign-in. */
export function manualMessage(cli: ProviderCli | undefined, id: ChatProviderId): string {
    const name = cli?.name ?? APP_OF[id];
    const install = cli !== undefined && cli.installation.status !== "installed" && cli.installer;
    return [
        [
            `You can set it up in your terminal. Run these, and I'll notice when ${name} is ready.`,
            install ? `\`\`\`sh\n${install.command}\n\`\`\`` : "",
            `\`\`\`sh\n${cli?.commands.signIn ?? `${id} login`}\n\`\`\``,
        ]
            .filter(Boolean)
            .join("\n\n"),
        "",
        `<output data-status="running">${chatActionEscape(`Waiting for ${APP_OF[id]} sign-in…`)}</output>`,
        "",
        manualMenu(id),
    ].join("\n");
}

function manualMenu(id: ChatProviderId): string {
    return menu(
        `<button data-action="onboarding.connect" data-provider="${id}" data-emphasis>Let Happy do it</button>`,
        '<button data-action="onboarding.connectAnother">Choose another AI</button>',
    );
}

export function connectFailedMessage(id: ChatProviderId, reason: string): string {
    return [`That didn't work: ${reason}`, "", manualMenu(id)].join("\n");
}

/**
 * The connecting message, written once: the app draws the install and sign-in live from the
 * provider CLI figure, with its own page, code field, Cancel, and Try again, so nothing here is
 * ever rewritten.
 */
export function connectingMessage(id: ChatProviderId): string {
    return [
        `Connecting ${APP_OF[id]}. I'll carry on here as soon as you're signed in.`,
        "",
        `<figure data-provider-cli="${id}"></figure>`,
        "",
        menu(
            `<button data-action="onboarding.manual" data-provider="${id}">I'd rather do it myself</button>`,
            '<button data-action="onboarding.connectAnother">Choose another AI</button>',
        ),
    ].join("\n");
}

/** Every AI Happy can connect; one already connected offers another account instead. */
export function catalogMessage(connected: ReadonlySet<ChatProviderId>): string {
    const names = [...connected].map((id) => APP_OF[id]);
    return [
        names.length > 0
            ? `Here's every AI Happy can connect. ${listOf(names)} ${names.length === 1 ? "is" : "are"} already connected; choosing ${names.length === 1 ? "it" : "one of them"} adds another account.`
            : "Here's every AI Happy can connect:",
        "",
        menu(
            ...PROVIDER_BUTTONS.filter((button) => button.choice !== "none").map((button) => {
                const id =
                    button.choice === "other" || button.choice === "none"
                        ? undefined
                        : PROVIDER_OF[button.choice];
                const mark = button.mark ? ` data-mark="${button.mark}"` : "";
                return id !== undefined && connected.has(id)
                    ? `<button data-action="onboarding.accountAdd" data-provider="${id}"${mark}>${chatActionEscape(`${button.label} · connected`)}</button>`
                    : `<button data-action="onboarding.provider" data-provider="${button.choice}"${mark}>${chatActionEscape(button.label)}</button>`;
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
        `Adding a second ${app}account isn't available in Happy yet. Your current ${app}account stays connected, and you can use it now.`,
        ...(then === undefined ? [] : ["", then]),
    ].join("\n");
}

export function chooseAtLeastOneMessage(table: string): string {
    return ["Choose at least one, or sign in to another AI.", "", table].join("\n");
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
            : `Connected to ${listOf(connections.map((each) => each.app))}. I'll use ${first.app} unless you ask for another.`;
    return [
        `${lead} You can chat with me below now. Use another AI too?`,
        "",
        menu(
            ...offered.filter((entry) => !isConnected(entry)).map(button),
            ...offered.filter(isConnected).map(button),
        ),
        ...(connectedIds.size === 0
            ? []
            : [
                  "",
                  "If you have more than one account, you can add those too.",
                  "",
                  menu(
                      ...[...connectedIds].map(
                          (id) =>
                              `<button data-action="onboarding.accountAdd" data-provider="${id}" data-mark="${MARK_OF[id]}">${chatActionEscape(`Add another ${APP_OF[id]} account`)}</button>`,
                      ),
                  ),
              ]),
        "",
        '<output data-status="info">You can always ask me later.</output>',
    ].join("\n");
}

export function useFailedMessage(app: string, reason: string): string {
    return `I couldn't make ${app} the AI Happy uses. ${/[.!?]$/u.test(reason) ? reason : `${reason}.`} Choose another AI, or try again.`;
}

export function restartMessage(names: readonly string[]): string {
    return `I set up ${listOf(names)}. Happy restarts to start using ${names.length === 1 ? "it" : "them"}; I'll carry on right after.`;
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
