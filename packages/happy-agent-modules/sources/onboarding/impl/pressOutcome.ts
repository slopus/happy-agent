import type { ProviderCli } from "../../providerClis/index.js";
import type { OnboardingWorkRow } from "../OnboardingFlow.js";
import type { ChatProviderId } from "./chatActions/chatAction.js";
import type {
    OnboardingPlaces,
    OnboardingStartedChat,
    OnboardingTreeNode,
} from "./onboardingGuide.js";
import { APP_OF } from "./onboardingCopy.js";

/**
 * What a press did, in plain English, as Happy's model reads it after the person's press. These
 * are model input, never shown to the person; the model writes the next step from them.
 */

/** The places Happy may read, and what it reads there, for the model to disclose. */
export function placesOutcome(places: OnboardingPlaces | undefined): string {
    if (places === undefined) {
        return "You know no history of theirs to read for the assistant they connected.";
    }
    const tree = (nodes: readonly OnboardingTreeNode[], depth: number): string[] =>
        nodes.flatMap((node) => [
            `${"  ".repeat(depth)}- ${node.name}`,
            ...tree(node.children, depth + 1),
        ]);
    return [
        `Places you can read for their ${places.assistant} history:`,
        ...tree(places.tree, 0),
        "What you read there:",
        ...places.reads.map((read) => `- ${read}`),
    ].join("\n");
}

/** The person chose an AI to connect: what connecting it needs. */
export function aiChosenOutcome(
    id: ChatProviderId,
    cli: ProviderCli,
    installerAvailable: boolean,
): string {
    const app = APP_OF[id];
    if (cli.signIn.status === "signed_in") {
        return `${cli.name} is already signed in, so ${app} is being added now. You'll hear when it's connected.`;
    }
    if (cli.installation.status === "installed") {
        return `${cli.name} is installed and needs a sign-in. The provider CLI figure for ${id} offers it.`;
    }
    if (installerAvailable && cli.installer !== null) {
        return [
            `${cli.name} isn't installed. Installing downloads ${cli.vendor}'s official installer from ${cli.installer.sourceHost} and runs exactly this, then starts the sign-in:`,
            cli.installer.command,
            `The provider CLI figure for ${id} offers it. Once installed, they can also run \`${cli.commands.run}\` in their terminal.`,
        ].join("\n");
    }
    return [
        `${cli.name} has no installer for this computer. They set it up themselves with:`,
        ...manualCommands(cli),
    ].join("\n");
}

/** The way back from setting an assistant up by hand, for the model to offer when there is one. */
export function manualOutcome(cli: ProviderCli | undefined, app: string): string {
    const commands = cli === undefined ? [] : manualCommands(cli);
    const back =
        cli === undefined || (cli.installation.status !== "installed" && cli.installer === null)
            ? "There is no installer for this computer, so they set it up themselves."
            : cli.installation.status === "installed"
              ? "It's installed, so you can open the sign-in page instead."
              : "You can install it for them instead.";
    return [
        `They'd rather set ${app} up themselves. The commands, in order:`,
        ...commands,
        back,
        "You'll hear when it's connected.",
    ].join("\n");
}

/** What a person runs to set an assistant up by hand: its install when missing, then sign-in. */
export function manualCommands(cli: ProviderCli): string[] {
    return [
        ...(cli.installation.status !== "installed" && cli.installer !== null
            ? [cli.installer.command]
            : []),
        cli.commands.signIn,
    ];
}

/** The proposal as the person was shown it, for Adjust. */
export function proposalOutcome(rows: readonly OnboardingWorkRow[]): string {
    return [
        "They want to change this proposal:",
        ...rows.map(
            (row) =>
                `- ${row.title} (topic ${row.topic}${row.ongoing ? ", ongoing" : ""}); first message: ${row.firstMessage}`,
        ),
    ].join("\n");
}

/** Looks right: what started, where it was placed, and what failed. */
export function acceptedOutcome(
    started: readonly OnboardingStartedChat[],
    failed: readonly string[],
    topicsError: string | undefined,
): string {
    if (started.length === 0 && failed.length === 0) {
        return "Nothing was ticked, so nothing started.";
    }
    return [
        started.length === 0
            ? "No chat started."
            : `Started ${String(started.length)} ${started.length === 1 ? "chat" : "chats"}, each making a read-only plan and waiting for them before it changes anything:`,
        ...started.map((chat) => `- ${chat.title}, under ${chat.topic}`),
        topicsError === undefined
            ? started.length === 0
                ? ""
                : "Each is placed under its topic in the sidebar."
            : `The topics couldn't be added: ${topicsError}`,
        failed.length === 0 ? "" : `These couldn't start: ${failed.join(", ")}.`,
    ]
        .filter(Boolean)
        .join("\n");
}

/** The last steps: the person's name, and the chats onboarding started, by their ids. */
export function closingOutcome(closing: {
    readonly name: string;
    readonly started: readonly OnboardingStartedChat[];
    readonly placed: boolean;
}): string {
    return [
        closing.name ? `Their name: ${closing.name}.` : "",
        closing.started.length === 0
            ? "Onboarding started no chats."
            : [
                  "Chats onboarding started, by the id to use as data-item:",
                  ...closing.started.map((chat) => `- ${chat.id}: ${chat.title} (${chat.topic})`),
              ].join("\n"),
    ]
        .filter(Boolean)
        .join("\n");
}
