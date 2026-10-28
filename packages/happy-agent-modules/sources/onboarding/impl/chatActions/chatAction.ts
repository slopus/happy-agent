// Copied from happy-desktop `happy-desktop-state/src/chatActions` (chat-onboarding, 9da732b7). The
// daemon validates presses with the same grammar clients draw; both move into
// @slopus/happy-agent-client with its next release. Keep the copies identical until then.
/**
 * The actions an inline block in an agent's reply can ask the app to run.
 *
 * An agent writes a button as HTML, `<button data-action="reply" data-text="Yes">Yes</button>`,
 * and the app runs it. Which actions exist, and what each one carries, is
 * closed here: an action id this build does not know, or one whose parameters
 * do not check, is not an action at all, and its button is drawn but cannot be
 * pressed. Nothing about an action is inferred from its label.
 *
 * Each parameter is a `data-` attribute named after it. The checklist's submit
 * adds the values that were ticked; no attribute can supply them.
 */

/** The subscriptions onboarding asks about, as the person knows them. */
export type ChatProviderChoice = "claude" | "chatgpt" | "grok" | "gemini" | "none" | "other";

/** The coding assistants Happy can connect, by the CLI each one runs. */
export type ChatProviderId = "claude" | "codex" | "grok" | "antigravity";

export const CHAT_PROVIDER_CHOICES: readonly ChatProviderChoice[] = [
    "claude",
    "chatgpt",
    "grok",
    "gemini",
    "none",
    "other",
];
export const CHAT_PROVIDER_IDS: readonly ChatProviderId[] = [
    "claude",
    "codex",
    "grok",
    "antigravity",
];

export type ChatAction =
    /** Send `text` as the person's own message, as if typed. */
    | { readonly id: "reply"; readonly text: string }
    /** Onboarding: begin, after Happy's introduction; the example sidebar goes. */
    | { readonly id: "onboarding.start" }
    /** Onboarding: the subscription the person already pays for. */
    | { readonly id: "onboarding.provider"; readonly provider: ChatProviderChoice }
    /** Onboarding: install the assistant's CLI if needed, then start its sign-in. */
    | { readonly id: "onboarding.connect"; readonly provider: ChatProviderId }
    /** Onboarding: the person would rather install and sign in themselves. */
    | { readonly id: "onboarding.manual"; readonly provider: ChatProviderId }
    /** Onboarding: use the ticked accounts already signed in on this computer. */
    | { readonly id: "onboarding.providersUse"; readonly values: readonly string[] }
    /** Onboarding: use the ticked ways this computer already reaches models, by route ID. */
    | { readonly id: "onboarding.routesUse"; readonly values: readonly string[] }
    /** Onboarding: show every AI Happy can connect, the connected ones marked. */
    | { readonly id: "onboarding.connectAnother" }
    /** Onboarding: sign in to a second account of a provider already connected, or of one to choose. */
    | { readonly id: "onboarding.accountAdd"; readonly provider?: ChatProviderId }
    /** Onboarding: open the vendor's sign-in page again. */
    | { readonly id: "onboarding.signInOpen"; readonly provider: ChatProviderId }
    /** Onboarding: stop the install or sign-in under way. */
    | { readonly id: "onboarding.connectCancel"; readonly provider: ChatProviderId }
    /** Onboarding: the code the vendor's page showed, typed into its own field and never into the chat. */
    | {
          readonly id: "onboarding.codeEntry";
          readonly provider: ChatProviderId;
          readonly code: string;
      }
    /** Onboarding: open the vendor's page for its current plans. */
    | { readonly id: "onboarding.subscribe"; readonly provider: ChatProviderId }
    /** Onboarding: add an API key, company account or custom endpoint in its own sheet. */
    | { readonly id: "onboarding.apiKeyOpen" }
    /** Onboarding: the prefilled name and email are right. */
    | { readonly id: "onboarding.profileConfirm" }
    /** Onboarding: the person wants to type their name and email instead. */
    | { readonly id: "onboarding.profileChange" }
    /** Onboarding: look at the places Happy disclosed for what the person has been working on. */
    | { readonly id: "onboarding.discover" }
    /** Onboarding: the person would rather say what they work on. */
    | { readonly id: "onboarding.workTell" }
    /** Onboarding: open a chat for each ticked idea and send its disclosed first message. */
    | { readonly id: "onboarding.workAccept"; readonly values: readonly string[] }
    /** Onboarding: the proposals are not right. */
    | { readonly id: "onboarding.workChange" }
    /** Onboarding: open a fresh, blank stem cell, as New does. */
    | { readonly id: "onboarding.newChat" }
    /** Onboarding: not now for New. */
    | { readonly id: "onboarding.newChatSkip" }
    /** Onboarding: the phone offer's answer: the app is open on the phone, or later. */
    | { readonly id: "onboarding.phone"; readonly choice: "opened" | "later" }
    /** Onboarding: finish in one of the chats acceptance opened. */
    | { readonly id: "onboarding.workOpen"; readonly item: string }
    /** Onboarding: finish where the person is. */
    | { readonly id: "onboarding.finish" };

export type ChatActionId = ChatAction["id"];

/** A block's `data-` attributes, less the ones the grammar itself reads. */
type ChatActionAttributes = ReadonlyMap<string, string>;

function choiceOf<T extends string>(
    values: readonly T[],
    value: string | undefined,
): T | undefined {
    return values.find((candidate) => candidate === value);
}

/**
 * The action an element names, with its parameters checked; nothing when the
 * id is unknown or a parameter is missing or wrong. `values` is what a
 * checklist submit carries, and only a checklist submit carries it.
 */
export function chatActionParse(
    id: string,
    attributes: ChatActionAttributes,
    values?: readonly string[],
): ChatAction | undefined {
    const provider = choiceOf(CHAT_PROVIDER_IDS, attributes.get("provider"));
    switch (id) {
        case "reply": {
            const text = attributes.get("text")?.trim();
            return text ? { id, text } : undefined;
        }
        case "onboarding.provider": {
            const choice = choiceOf(CHAT_PROVIDER_CHOICES, attributes.get("provider"));
            return choice ? { id, provider: choice } : undefined;
        }
        case "onboarding.connect":
        case "onboarding.manual":
        case "onboarding.signInOpen":
        case "onboarding.connectCancel":
        case "onboarding.subscribe":
            return provider ? { id, provider } : undefined;
        case "onboarding.codeEntry": {
            /* A code form's one value is what was typed in its field. */
            const code = values?.[0]?.trim();
            return provider && code !== undefined ? { id, provider, code } : undefined;
        }
        case "onboarding.start":
        case "onboarding.apiKeyOpen":
        case "onboarding.profileConfirm":
        case "onboarding.profileChange":
        case "onboarding.workChange":
        case "onboarding.discover":
        case "onboarding.workTell":
        case "onboarding.connectAnother":
        case "onboarding.newChat":
        case "onboarding.newChatSkip":
        case "onboarding.finish":
            return { id };
        case "onboarding.accountAdd":
            return provider ? { id, provider } : { id };
        case "onboarding.workAccept":
        case "onboarding.providersUse":
        case "onboarding.routesUse":
            return values ? { id, values } : undefined;
        case "onboarding.phone": {
            const choice = choiceOf(["opened", "later"] as const, attributes.get("choice"));
            return choice ? { id, choice } : undefined;
        }
        case "onboarding.workOpen": {
            const item = attributes.get("item");
            return item ? { id, item } : undefined;
        }
        default:
            return undefined;
    }
}
