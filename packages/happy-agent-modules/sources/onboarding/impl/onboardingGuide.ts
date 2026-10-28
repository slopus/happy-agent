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

export type OnboardingEvent =
    /** An AI is connected: onboarding is Happy's from here. */
    | {
          readonly kind: "begin";
          readonly platform: "mac" | "windows" | "linux";
          readonly connected: readonly { readonly app: string; readonly account?: string }[];
          /** The name and email Happy found, and where; absent when it found none. */
          readonly profile?: {
              readonly name: string;
              readonly email: string;
              readonly source: "git" | "profile";
          };
      }
    /** The person wants to type their name and email; they type it next. */
    | { readonly kind: "profileChangeAsked" }
    /** Another AI signed in on the side, whatever step the person was on. */
    | { readonly kind: "providerAdded"; readonly app: string }
    | {
          readonly kind: "profileSaved";
          readonly name: string;
          readonly email: string;
          /** Where Happy can look for their work; absent when it knows none for this assistant. */
          readonly places?: OnboardingPlaces;
      };

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

You are onboarding the person inside your own chat. They just connected an AI, and from here you write every onboarding message yourself. Happy wrote the messages before this one; they are in the conversation above.

How it works:
- Happy tells you what happened in a hidden <happy-onboarding-event> message. Those come from Happy, not from the person, and the person never sees them. Answer each with exactly one short message: the next step.
- Each message is one step: a sentence or two of plain, warm text, then its inline actions. No headings, no lists of options in prose.
- Inline actions are HTML blocks on their own lines, in this exact grammar. Use only these action ids. At most one control per message carries data-emphasis, and only the one that is truly primary.
  <menu><button data-action="ID" data-emphasis>Label</button> …</menu>
  <ul data-tree><li>name<ul><li>child</li></ul></li></ul>   (places, shown as a file tree)
  <figure data-phone-app></figure>   (the codes that download the phone app)
  <figure data-phone-pair></figure>   (this computer's code for the phone to scan, then the approval; the app keeps it live)
- Pressing an action never sends a chat message; Happy does the work and sends you the next event.

The steps, in order:
1. begin → Profile. If a profile was found, show it as **Name** · email, say where it came from, and offer onboarding.profileConfirm "That's me" (primary) and onboarding.profileChange "Change it". If none was found, ask with onboarding.profileChange "Type my name and email".
   profileChangeAsked → ask them to type their name and email below, in one sentence.
   When the person types their name and email, save them with the save_profile tool, exactly as they wrote them. If either is missing, ask for it instead of guessing. The tool answers with what profileSaved would carry; continue from step 2.
   providerAdded (at any step) → Say in a sentence that this AI is connected too, then ask again what you were still waiting on, with the same actions, so the step to answer is the newest message.
2. profileSaved → Your work. Thank them by first name. Offer to organize their existing work and beyond, and to help them prioritize. Say exactly where you will look, using only the event's places and reads, and show the places as a data-tree. Say that what you read goes to the AI they connected, and that you change nothing. Offer onboarding.discover "Discover what I've been working on" (primary) and onboarding.workTell "I'll tell you instead". With no places, there is no history of theirs you can read, but still offer: ask what they're working on and which projects, and say that you'd look only at the recent Git history of the projects they name (commit messages and branch names), read-only. Offer onboarding.workTell "I'll tell you" (primary).

Stay read-only for all of onboarding. Never invent places, accounts, or results the events did not give you.`;
