import type { ProviderCli } from "../../providerClis/index.js";
import type { ChatProviderId } from "./chatActions/chatAction.js";
import { chatActionEscape, type ChatActionMark } from "./chatActions/chatActionBlocks.js";
import {
    APP_OF,
    MARK_OF,
    PROVIDER_BUTTONS,
    PROVIDER_OF,
    accountOf,
    listOf,
    menu,
} from "./onboardingCopy.js";

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
 * The connecting message, rewritten in place as the install and sign-in move: its steps, then
 * while the browser is out, the page to open again and Cancel, and a field of its own for a code
 * the page shows. `now` decides whether a waiting page has timed out.
 */
export function connectingMessage(cli: ProviderCli, id: ChatProviderId, now: number): string {
    const operation = cli.operation;
    const signedIn = cli.signIn.status === "signed_in";
    const waitingOperation =
        operation?.kind === "sign_in" && operation.status === "waiting" && !signedIn;
    const expiresAt = operation?.authorization?.expiresAt;
    const expired = waitingOperation && expiresAt !== undefined && now >= expiresAt;
    const waiting = waitingOperation && !expired;
    const installing = operation?.kind === "install" && operation.status === "running";
    const failed = (operation?.status === "failed" || expired) && !signedIn;
    const authorization = waiting ? operation.authorization : null;
    const app = APP_OF[id];
    const parts = [`Connecting ${app}:`, stepsOf(cli, id, expired)];
    if (installing) {
        parts.push(
            menu(
                `<button data-action="onboarding.connectCancel" data-provider="${id}">Cancel</button>`,
            ),
        );
    }
    if (waiting) {
        const opened = authorization?.openedByProgram
            ? `${cli.name} opened the ${cli.vendor} sign-in page in your browser.`
            : `I opened the ${cli.vendor} sign-in page in your browser.`;
        const code = authorization?.userCode ? ` Enter **${authorization.userCode}** there.` : "";
        const quick =
            authorization !== null &&
            authorization !== undefined &&
            authorization.expiresAt - now < 120_000
                ? " The page times out in about a minute."
                : "";
        parts.push(
            `${opened}${code} Finish there and come back; I'll carry on as soon as you're signed in.${quick}`,
        );
        // The page is opened again only on a click: the program already opened it once.
        parts.push(
            menu(
                ...(authorization?.url
                    ? [
                          `<button data-action="onboarding.signInOpen" data-provider="${id}" data-emphasis>Open sign-in page</button>`,
                      ]
                    : []),
                `<button data-action="onboarding.connectCancel" data-provider="${id}">Cancel</button>`,
            ),
        );
        if (authorization?.acceptsCode) {
            parts.push(
                "If the page shows you a code, enter it here:",
                [
                    `<form data-action="onboarding.codeEntry" data-provider="${id}">`,
                    '  <input type="text" placeholder="Sign-in code">',
                    '  <button type="submit">Enter code</button>',
                    "</form>",
                ].join("\n"),
            );
        }
    }
    if (failed) {
        parts.push(
            expired
                ? `That sign-in page expired. Open a new one to finish connecting ${app}.`
                : `${cli.name} couldn't finish. You can try again or choose another AI.`,
            menu(
                `<button data-action="onboarding.connect" data-provider="${id}" data-mark="${MARK_OF[id]}" data-emphasis>${expired ? "Sign in again" : "Try again"}</button>`,
                '<button data-action="onboarding.connectAnother">Choose another AI</button>',
                `<button data-action="onboarding.manual" data-provider="${id}">Do it myself</button>`,
            ),
        );
    }
    return parts.join("\n\n");
}

function stepsOf(cli: ProviderCli, id: ChatProviderId, expired: boolean): string {
    const operation = cli.operation;
    const installed = cli.installation.status === "installed";
    const signedIn = cli.signIn.status === "signed_in";
    const installStatus = installed
        ? "done"
        : operation?.kind === "install" && operation.status === "failed"
          ? "failed"
          : operation?.kind === "install"
            ? "running"
            : "pending";
    const signInStatus = signedIn
        ? "done"
        : operation?.kind === "sign_in" && (operation.status === "failed" || expired)
          ? "failed"
          : operation?.kind === "sign_in" && operation.status !== "cancelled"
            ? "running"
            : "pending";
    const installDetail = installed
        ? cli.installation.version
            ? `${cli.installation.version} · ${cli.installation.desktopApp ? `in ${cli.installation.desktopApp}` : "installed"}`
            : "installed"
        : operation?.kind === "install"
          ? (operation.error?.message ?? operation.message)
          : undefined;
    const signInDetail = signedIn
        ? accountOf(cli) || "signed in"
        : operation?.kind === "sign_in"
          ? expired
              ? "timed out"
              : operation.status === "cancelled"
                ? "paused"
                : (operation.error?.message ??
                  (operation.status === "waiting" ? "waiting for your browser" : operation.message))
          : undefined;
    const item = (status: string, label: string, detail?: string, mark?: ChatActionMark) =>
        `  <li data-status="${status}"${mark ? ` data-mark="${mark}"` : ""}>${chatActionEscape(label)}${detail ? ` <small>${chatActionEscape(detail)}</small>` : ""}</li>`;
    return [
        "<ol data-steps>",
        item(installStatus, `Install ${cli.name}`, installDetail, MARK_OF[id]),
        item(signInStatus, `Sign in to ${APP_OF[id]}`, signInDetail),
        "</ol>",
    ].join("\n");
}

export function connectPausedMessage(id: ChatProviderId, installed: boolean): string {
    return [
        `${APP_OF[id]} sign-in is paused. You can finish it whenever you're ready.`,
        "",
        menu(
            `<button data-action="onboarding.connect" data-provider="${id}" data-mark="${MARK_OF[id]}" data-emphasis>${installed ? "Continue sign-in" : "Install and sign in"}</button>`,
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

export function codeFailedMessage(reason: string): string {
    return `That code didn't work: ${reason}`;
}

/**
 * Connected, and what else can be: the AIs not connected yet first, the connected ones at the
 * far end, then another account of a connected one. None of it has to be answered.
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
                              `<button data-action="onboarding.accountAdd" data-provider="${id}" data-mark="${MARK_OF[id]}" data-connected>${chatActionEscape(`Add another ${APP_OF[id]} account`)}</button>`,
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
