import { type Static, Type } from "@sinclair/typebox";

import { cuid2Schema } from "./common.js";

/** The story a message answers, on user messages and chat Surface messages; kinds may grow. */
export const messageReplyToSchema = Type.Object({
    artifactId: cuid2Schema,
    kind: Type.Literal("story"),
});
export type MessageReplyTo = Static<typeof messageReplyToSchema>;
