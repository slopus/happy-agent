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
          /** Start a turn for the waiting notes now, instead of with the person's next message. */
          readonly wake?: boolean;
      } & ([ResultOf<B, K>] extends [never]
          ? { readonly result?: undefined }
          : { readonly result: ResultOf<B, K> }))
    | {
          readonly status: "rejected";
          /** A stable machine-readable code; stored clipped to 64 characters. */
          readonly code: string;
          /** One English sentence safe to show; stored clipped to 500 characters. */
          readonly reason: string;
      };

/** What a component's input became: its stored props, and the media those props name. */
export type ChatUiPrepared<B extends UiBundle> =
    | {
          readonly props: PropsOf<B>;
          readonly items?: readonly HistoryMediaItem[];
      }
    | { readonly problems: readonly string[] };

/**
 * How a module serves one component: what `show_ui` teaches about it, its own checks, its
 * fallback line, and a hook per action. The bundle stays the contract; this is the server side of
 * it.
 */
export interface ChatUiContribution<B extends UiBundle> {
    /** One or two sentences for `show_ui`'s description: when to use it and what a press does. */
    readonly prompt: string;
    /**
     * The one line a client that cannot draw the component shows instead, at most 500 characters.
     * `items` are the media its props name, in order, empty for a component without any.
     */
    readonly fallback: (props: PropsOf<B>, items: readonly HistoryMediaItem[]) => string;
    /**
     * Turn what was written into stored props, for a component whose input differs from its props
     * (`media` takes paths and stores media indexes). Runs in the `show_ui` call's context. Media
     * it returns join the document's one list, where its first item lands at `firstItemIndex`.
     * Absent means the input is the props.
     */
    readonly prepare?: (
        ctx: Context,
        agentId: string,
        input: InputOf<B>,
        firstItemIndex: number,
    ) => Promise<ChatUiPrepared<B>>;
    /** Problems the model must fix beyond the schema, such as an unknown provider. */
    readonly check?: (ctx: Context, props: PropsOf<B>) => Promise<readonly string[]>;
    /** Whether showing this input needs an Auto review, such as a file outside the workspace. */
    readonly shouldReview?: (ctx: Context, agentId: string, input: InputOf<B>) => Promise<boolean>;
    /**
     * What showing this component reaches beyond the chat, as the Auto reviewer is told: a short
     * phrase such as "local file read". Given by a component that has `shouldReview`.
     */
    readonly reviewAccess?: string;
    readonly actions: {
        readonly [K in ActionNamesOf<B>]: (
            ctx: Context,
            offer: ChatUiOffer<B>,
            payload: PayloadOf<B, K>,
        ) => Promise<ChatUiOutcome<B, K>>;
    };
}
