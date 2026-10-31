import { storySchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

/**
 * One story as stored: the wire story without what is read when served (who saw it, its replies,
 * the poster's name), plus `person`, the member it belongs to — a task's owner, a bot's person for
 * the posting turn, or the reposter. `state` is never stored as `"expired"`; that follows the time.
 */
export const storyRecordSchema = Type.Composite([
    Type.Omit(storySchema, ["seenBy", "replies"]),
    Type.Object({ person: Type.String({ minLength: 1 }) }),
]);
export type StoryRecord = Static<typeof storyRecordSchema>;
