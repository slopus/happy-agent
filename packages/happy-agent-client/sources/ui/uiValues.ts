import { Type, type Static } from "@sinclair/typebox";

/**
 * The small values chat UI components share. Every string a component shows is plain text: never
 * Markdown, HTML, a link, or a URL, and it holds no control or bidirectional formatting character.
 */

/** No C0/C1 control, DEL, or bidirectional formatting character. */
const PLAIN =
    "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*$";
/** As {@link PLAIN}, but line feeds are allowed. */
const PLAIN_LINES =
    "^[^\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*$";

/** A component's or an option's ID: a lowercase slug of 1–64. */
export const uiSlugSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
});
export type UiSlug = Static<typeof uiSlugSchema>;

/** A control's or an option's label: one line of 1–80 characters. */
export const uiLabelSchema = Type.String({ minLength: 1, maxLength: 80, pattern: PLAIN });
export type UiLabel = Static<typeof uiLabelSchema>;

/** A short detail under a label: one line of 1–200 characters. */
export const uiDetailSchema = Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN });
export type UiDetail = Static<typeof uiDetailSchema>;

/** The fallback line every wire component carries, which a client that cannot draw it shows. */
export const uiFallbackSchema = Type.String({ maxLength: 500, pattern: PLAIN_LINES });

/** The AIs a provider sign-in can connect, by their provider CLI ID. */
export const uiProviderSchema = Type.Union([
    Type.Literal("claude"),
    Type.Literal("codex"),
    Type.Literal("grok"),
    Type.Literal("antigravity"),
]);
export type UiProvider = Static<typeof uiProviderSchema>;

/** A UNIX epoch time in milliseconds. */
export const uiTimestampSchema = Type.Integer({ minimum: 0 });
