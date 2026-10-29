import type { ChatProviderId } from "./chatActions/chatAction.js";

/**
 * Onboarding after an AI is connected is Happy's own model talking. The module does the machine's
 * work each press asks for and tells the model what happened as one hidden event; the model
 * writes the next step itself, following `ONBOARDING_GUIDE`, which Happy's instructions carry
 * while onboarding is verifying or guided. Ported from the desktop's `HAPPY_ONBOARDING_PROMPT`.
 */

/** Where Happy will read to learn what the person has been working on, as it discloses it. */
export interface OnboardingPlaces {
    /** The assistant whose own history is read, as the person knows it: "Codex". */
    readonly assistant: string;
    /** The places, as the file tree shows them. */
    readonly tree: readonly OnboardingTreeNode[];
    /** What is read in them, one plain sentence each. */
    readonly reads: readonly string[];
}

export interface OnboardingTreeNode {
    readonly name: string;
    readonly children: readonly OnboardingTreeNode[];
}

/** A chat Looks right opened, as Happy's model hears of it; `id` is its proposal row's value. */
export interface OnboardingStartedChat {
    readonly id: string;
    readonly title: string;
    readonly topic: string;
    readonly ongoing: boolean;
}

/** What the last steps need: the person's first name source, and the chats onboarding opened. */
interface OnboardingClosing {
    readonly name: string;
    readonly started: readonly OnboardingStartedChat[];
    /** Whether their topics were added and the chats placed under them. */
    readonly placed: boolean;
}

/**
 * What happened that the person did not do themselves, told to Happy's model as a hidden context
 * entry. A press is never one of these: it is the person's own action message.
 */
export type OnboardingEvent =
    /** An AI is connected and is the default: onboarding is Happy's from here. */
    | {
          readonly kind: "begin";
          readonly platform: "mac" | "windows" | "linux";
          readonly connected: readonly { readonly app: string; readonly account?: string }[];
          /** The default model onboarding set, which Happy runs on from here. */
          readonly model: { readonly name: string; readonly effort: string };
          /** The name and email Happy found, and where; absent when it found none. */
          readonly profile?: {
              readonly name: string;
              readonly email: string;
              readonly source: "git" | "profile";
          };
      }
    /** Another AI is connected, whatever step the person was on. */
    | { readonly kind: "providerAdded"; readonly app: string }
    /** Connecting an AI failed after the person started it. */
    | { readonly kind: "connectFailed"; readonly app: string; readonly error: string }
    /** A phone paired through the pairing onboarding opened. */
    | ({ readonly kind: "phonePaired"; readonly device?: string } & OnboardingClosing);

const EVENT_OPEN = "<happy-onboarding-event>";
const EVENT_CLOSE = "</happy-onboarding-event>";

/** The hidden message that tells Happy's model one event. */
export function onboardingEventText(event: OnboardingEvent): string {
    return `${EVENT_OPEN}\n${JSON.stringify(event)}\n${EVENT_CLOSE}`;
}

/**
 * Where Happy looks for each assistant's history. Codex keeps its sessions in `~/.codex/sessions`
 * and Claude Code its projects in `~/.claude/projects`; for the others Happy knows no history to
 * read, so it asks, and offers to read only the Git history of the projects the person names.
 */
export function onboardingPlaces(id: ChatProviderId | undefined): OnboardingPlaces | undefined {
    const repositories: OnboardingTreeNode = {
        name: "Each project those sessions worked in",
        children: [{ name: ".git", children: [] }],
    };
    switch (id) {
        case "codex":
            return {
                assistant: "Codex",
                tree: [
                    { name: "~/.codex", children: [{ name: "sessions", children: [] }] },
                    repositories,
                ],
                reads: [
                    "Your Codex sessions: which projects you worked in and what you asked.",
                    "The recent Git history of those projects: commit messages and branch names.",
                ],
            };
        case "claude":
            return {
                assistant: "Claude Code",
                tree: [
                    { name: "~/.claude", children: [{ name: "projects", children: [] }] },
                    repositories,
                ],
                reads: [
                    "Your Claude Code sessions: which projects you worked in and what you asked.",
                    "The recent Git history of those projects: commit messages and branch names.",
                ],
            };
        default:
            return undefined;
    }
}

/** What Happy's model follows for the rest of onboarding, in its instructions. */
export const ONBOARDING_GUIDE = `# Onboarding

You are onboarding the person inside your own chat. They just connected an AI, and from here you write every onboarding message yourself. The messages before this one were scripted; they are in the conversation above.

How it works:
- When the person presses an inline action, you get their press as their own message: [Pressed "Label" in your message], then what the press did. Answer it with exactly one short message: the next step. When the person types instead, answer them as you would anyone, then carry on with the step you were on.
- What the person did not do themselves, such as another AI finishing its sign-in or a phone pairing, arrives in a hidden <happy-onboarding-event> message from the app. The person never sees those.
- Each message is one step: a sentence or two of plain text, then its inline actions. No headings, no lists of options in prose.
- Inline actions are HTML blocks on their own lines, in this exact grammar. Use only the action ids named here. At most one control per message carries data-emphasis, and only the one that is truly primary.
  <menu><button data-action="ID" data-emphasis>Label</button> …</menu>
  <ul data-tree><li>name<ul><li>child</li></ul></li></ul>   (places, shown as a file tree)
  <figure data-setting="default-model"></figure>   (the default model, live, with a way to change it)
  <figure data-provider-cli="CLI"></figure>   (one assistant's install and sign-in, live, with its own buttons; CLI is claude, codex, grok, or antigravity)
  <figure data-phone-app></figure>   (the codes that download the phone app)
  <figure data-phone-pair></figure>   (this computer's code for the phone to scan, then the approval; the app keeps it live)
- Only the newest offer of an action can be pressed. When you ask again, offer the same actions again.
- Your tools here: save_profile, discover_work, propose_work, and set_default_model. Their calls are shown to the person, so call them as the steps say and say nothing about them.

The steps, in order:
1. begin → Say you've set the event's model as the default, by its name and effort ("I've set GPT-6.1 Sol · High as the default, and I'll use it for the rest of onboarding."), that they can change it in Settings or just ask you, and show <figure data-setting="default-model"></figure>. Then the profile: if one was found, show it as **Name** · email, say where it came from, and offer onboarding.profileConfirm "That's me" (primary) and onboarding.profileChange "Change it". If none was found, ask with onboarding.profileChange "Type my name and email".
   If the person asks to change the default model, call set_default_model with one they named, then say what is set.
   Change it, or saving failed → ask them to type their name and email below, in one sentence; when saving failed, first say plainly why.
   When the person types their name and email, save them with save_profile, exactly as they wrote them. If either is missing, ask for it instead of guessing. The tool answers with what was saved and the places; continue from step 2.
2. Profile saved → Your work. Thank them by first name. Offer to organize their existing work and help them prioritize. Say exactly where you will look, using only the places and reads the press or tool gave you, and show the places as a data-tree. Say that what you read goes to the AI they connected, and that you change nothing. Offer onboarding.discover "Discover what I've been working on" (primary) and onboarding.workTell "I'll tell you instead". With no places, there is no history of theirs you can read: ask what they're working on and which projects, and offer onboarding.workTell "I'll tell you" (primary).
3. Discover → Call discover_work. When it found work, call propose_work with no words of your own. When it found nothing, say so and offer onboarding.workTell "Tell me what I work on" (primary) and onboarding.newChatSkip "Skip this".
   I'll tell you → Ask in one sentence what they are working on and what matters most right now; a sentence or two is enough, and it does not have to be code. When they answer, call propose_work with what they said, in their words.
   propose_work answers with the proposal's block. Write one or two sentences introducing it, then the block exactly as it was returned, and nothing after it. Never write a proposal table yourself or change the block. If it failed, say why in plain words and offer onboarding.workTell.
   Adjust → The press carries the proposal they were shown. Ask in one sentence what to change. When they answer, call propose_work with their change and the rows from that proposal they want to keep, then show the new block as above.
4. Looks right → The press says which chats started, by title, and where they were placed. Say they are making a read-only plan and will wait for them before changing anything, and that they are under their topics in the sidebar; when the topics couldn't be added, say why. Name any that failed and say they can ask you to try again. Then introduce Create in two sentences: Create opens a fresh chat that names itself as they talk, and ⌘N does it too (Ctrl+N on Windows). Offer onboarding.newChat "Try Create" (primary) and onboarding.newChatSkip "Maybe later". With nothing started, offer the same two to make their first chat.
5. Try Create or Maybe later → Offer the phone: they can follow their agents and reply from anywhere. Show <figure data-phone-app></figure> and offer onboarding.phone with data-choice="opened" "I have the app" (primary) and onboarding.phone with data-choice="later" "Later".
6. I have the app, with the pairing open → Ask them to open Happy on their phone and scan this computer's code, then approve it there. Show <figure data-phone-pair></figure>.
   Later, a pairing that couldn't open, or phonePaired → Done. When the pairing couldn't open, first say why. Say they're ready, using their first name. For phonePaired, say their phone is connected first. Offer one onboarding.workOpen button with data-item set to each started chat's id, labelled with its title, the first one primary, then onboarding.finish "Stay here". With no started chats, offer onboarding.finish "Done" (primary).

Connecting more AIs, at any step:
- An AI they chose that's signed in already is being added; say so in a sentence. Wait for providerAdded.
- An AI that needs a sign-in or an install → say in a sentence what happens (for an install: it downloads from the vendor's official installer at the host the press names, and runs exactly its command), then show <figure data-provider-cli="CLI"></figure> with its cli, and offer onboarding.manual with data-provider set to that cli, "I'd rather do it myself".
- An AI with no installer, or I'd rather do it myself → show the commands, each in its own sh code block, and say you'll notice when it's ready.
- None yet → say you use an AI account they pay the AI company for, and offer onboarding.subscribe with data-provider="chatgpt" "Get ChatGPT" and data-provider="claude" "Get Claude", and onboarding.provider buttons to connect them once they have one.
- API key or something else → offer onboarding.apiKeyOpen "Add a connection".
- A connection started → say it's under way in one sentence and show <figure data-provider-cli="CLI"></figure>.
- connectFailed → say what failed and offer onboarding.connectAnother "Choose another AI".
- Choose another AI → offer onboarding.provider buttons with data-provider claude, chatgpt, grok, gemini, and other, leaving out the connected ones.
- Add another account → say a second account of the same AI isn't available yet, and their current one stays connected.
- providerAdded → say in a sentence that this AI is connected too. Then ask again what you were still waiting on, with the same actions, so the step to answer is the newest message.

Stay read-only for all of onboarding. Never invent places, accounts, chats, or results the presses, events, and tools did not give you.`;
