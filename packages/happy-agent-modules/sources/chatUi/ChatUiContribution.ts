import type {
    ActionNamesOf,
    InputOf,
    PayloadOf,
    PropsOf,
    ResultOf,
    UiBundle,
} from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import type { HistoryMediaItem } from "../history/index.js";

/** The offer an action answers, read from the daemon's own stored copy. */
export interface ChatUiOffer<B extends UiBundle> {
    readonly agentId: string;
    /** The agent message holding the document. */
    readonly messageId: string;
    readonly uiId: string;
    readonly componentId: string;
    readonly props: PropsOf<B>;
    /** The clicking person in team mode; undefined on a standalone daemon. */
    readonly userId: string | undefined;
}

/** What a hook decided. A rejection is the person's answer, not an error. */
export type ChatUiOutcome<B extends UiBundle, K extends ActionNamesOf<B>> =
    | ({
          readonly status: "accepted";
          /** A sentence about server state the model reads with its next turn; no client shows it. */
          readonly note?: string;
          /** Start a turn for the notes now, on the conversation's last mode. */
          readonly wake?: boolean;
      } & ([ResultOf<B, K>] extends [never]
          ? { readonly result?: undefined }
          : { readonly result: ResultOf<B, K> }))
    | { readonly status: "rejected"; readonly code: string; readonly reason: string };

/** What a component's input became: its stored props, and the media its props name. */
export type ChatUiPrepared<B extends UiBundle> =
    | {
          readonly props: PropsOf<B>;
          readonly items?: readonly HistoryMediaItem[];
      }
    | { readonly problems: readonly string[] };

/**
 * How a module serves one component: what `show_ui` teaches about it, its own checks, its
 * fallback line, and a hook per action. The catalog bundle stays the contract; this is the server
 * side of it.
 */
export interface ChatUiContribution<B extends UiBundle> {
    /** One or two sentences for `show_ui`'s description: when to use it and what a press does. */
    readonly prompt: string;
    /** The one line a client that cannot draw the component shows instead, at most 500 characters. */
    readonly fallback: (props: PropsOf<B>) => string;
    /**
     * Turn a model's input into stored props, for a component whose input differs from its props
     * (`images` snapshots files). Runs in the `show_ui` call's context. Absent means the input is
     * the props.
     */
    readonly prepare?: (
        ctx: Context,
        agentId: string,
        input: InputOf<B>,
    ) => Promise<ChatUiPrepared<B>>;
    /** Problems the model must fix beyond the schema, such as an unknown provider. */
    readonly check?: (ctx: Context, props: PropsOf<B>) => Promise<readonly string[]>;
    /** Whether showing this input needs an Auto review, such as a file outside the workspace. */
    readonly shouldReview?: (ctx: Context, agentId: string, input: InputOf<B>) => Promise<boolean>;
    /** A guest of an exported bot may send this component's actions. Default false. */
    readonly guestSafe?: boolean;
    readonly actions: {
        readonly [K in ActionNamesOf<B>]: (
            ctx: Context,
            offer: ChatUiOffer<B>,
            payload: PayloadOf<B, K>,
        ) => Promise<ChatUiOutcome<B, K>>;
    };
}
