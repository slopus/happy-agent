import { createId } from "@paralleldrive/cuid2";
import {
    agentPermissionMode,
    defineAgentTool,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { storyCaptionSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { ArtifactInputError } from "../../artifacts/index.js";
import type { StoriesModule } from "../StoriesModule.js";

const setStoryInputSchema = Type.Object(
    {
        audience: Type.Optional(Type.Union([Type.Literal("owner"), Type.Literal("team")])),
        story: Type.Union([
            Type.Object(
                {
                    media: Type.Object(
                        {
                            artifactId: Type.String(),
                            version: Type.Optional(Type.Integer({ minimum: 1 })),
                            path: Type.Optional(Type.String()),
                        },
                        { additionalProperties: false },
                    ),
                    caption: Type.Optional(storyCaptionSchema),
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
    },
    { additionalProperties: false },
);
export type SetStoryInput = Static<typeof setStoryInputSchema>;

/** Post this agent's one live story for an audience, replacing the last; `null` takes it down. */
export function setStoryTool(stories: StoriesModule, scope: AgentModuleScope) {
    return defineAgentTool({
        name: "set_story",
        defer: false,
        capabilities: ["Post a story, one image or video for a day, on this conversation's card."],
        description: [
            "Post your one live story on your card in the person's sidebar for a day: an image or video showing something that shipped or is ready to try, with a few plain words as the caption. Posting again replaces your live story for that audience; story: null takes it down.",
            "media names an image or video artifact: its latest version and its entry unless you give version and path. Publish a screenshot or a short screen recording with create_artifact first; a web page cannot be a story.",
            'audience "owner", the default, is only the person you work for. "team" reaches every teammate: use it only when a person asked for a team post, in this conversation or as a standing instruction; it is reviewed for that ask.',
        ].join("\n\n"),
        parameters: setStoryInputSchema,
        returnType: Type.Unknown(),
        durable: true,
        // A team post reaches people who did not ask for it, so it always needs a person's ask.
        shouldReviewInAutoMode: (input) => input.audience === "team",
        describeAutoPermissionAction: (input) =>
            `${input.story === null ? "taking down" : "posting"} a story in every teammate's sidebar, captioned ${JSON.stringify(input.story?.caption ?? "")}. Allow it only when a person asked for a post to the team, in this conversation or as a standing instruction; otherwise deny it as not allowed`,
        execute: async (ctx, input: SetStoryInput, call) => {
            if (agentPermissionMode(ctx) === "read_only")
                throw new ArtifactInputError("Read only mode cannot post stories.");
            const id = await call.kv.getOrCreate(ctx, "artifactId", () => createId());
            const audience = input.audience ?? "owner";
            const { story, replaced } = await stories.post(ctx, scope, id, audience, input.story);
            const { artifactId, postedAt, expiresAt } = story ?? {};
            return { story: story && { id: artifactId, audience, postedAt, expiresAt }, replaced };
        },
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}
