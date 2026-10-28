import { agentMetadataSchema, agentPermissionModeSchema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { delegatedPermissionFlagSchemas } from "../impl/delegatedPermissionMode.js";
import {
    senderAgentExplanationArgumentSchema,
    senderAgentExplanationSchemaOf,
} from "../impl/messageOrigin.js";

/** IDs used by the collaboration tools and by Agent Base. */
export const collaborationAgentIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});

/**
 * The effort values Agent Base provider sessions accept. This mirrors `SessionReasoningEffort`,
 * and the compiler holds the two together: a value here that a session cannot be run with fails to
 * build rather than reaching a provider.
 */
export const collaborationEffortSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
]);

/** The service-tier override supported by Agent Base provider sessions. */
export const collaborationServiceTierSchema = Type.Literal("priority");

export const collaborationMessageTextSchema = Type.String({
    minLength: 1,
    maxLength: 50_000,
});

/**
 * Everything one call needs to put a collaborator to work: what it runs on, what to call it, and
 * the first thing it is asked to do.
 *
 * Creating and asking are one operation because what a collaborator runs on can only be said on
 * the message that starts it working. A later message carries no selection at all, so a
 * collaborator cannot be turned into a different model, made to think harder, or given wider
 * permissions by anyone who can talk to it.
 *
 * `title` is written to the agent's real metadata, so whatever shows a person their agents names
 * this one the same way it names every other. A collaborator otherwise inherits its creator's
 * configuration, so the machine it works on is not part of this input. It runs in the creator's own
 * permission mode unless `read_only` hands it less or `full_mode`, from a creator in Full access, asks
 * for Full access.
 */
export const collaborationCreateInputSchema = Type.Object(
    {
        title: Type.String({ minLength: 1, maxLength: 256 }),
        model: Type.String({ minLength: 1, maxLength: 256 }),
        effort: collaborationEffortSchema,
        /** Who runs the collaborator's loop: Happy's own or a foreign agent's, by harness ID. */
        harness: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(collaborationServiceTierSchema),
        ...delegatedPermissionFlagSchemas,
        text: collaborationMessageTextSchema,
    },
    { additionalProperties: false },
);

/**
 * What an agent asks a new conversation to run on, before it is checked against what is offered:
 * the model-facing fields of `create_agent`, shared by every tool that opens a conversation.
 */
export const collaborationModelChoiceSchema = Type.Object(
    {
        model: Type.String({ minLength: 1, maxLength: 256 }),
        effort: collaborationEffortSchema,
        harness: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(collaborationServiceTierSchema),
    },
    { additionalProperties: false },
);

/**
 * What a collaborator runs on. It is chosen once, when the collaborator is created, and never
 * again: a later message may ask a collaborator to do something, but not to become a different
 * model, think harder, or run with wider permissions.
 */
export const collaborationAgentSelectionSchema = Type.Object(
    {
        model: Type.String({ minLength: 1, maxLength: 256 }),
        effort: collaborationEffortSchema,
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(collaborationServiceTierSchema),
    },
    { additionalProperties: false },
);

/**
 * Why a collaborator is being created, in the terms only its creating code knows. `create_agent`
 * supplies none of this: a model asking for a collaborator gets the ordinary one.
 *
 * `reportToCreator` is what a module orchestrating agents of its own turns off. Reporting exists
 * because nothing waits for a collaborator, so its creator would otherwise never hear the answer.
 * Code that does collect the answer itself has no such gap, and a report would only put a hundred
 * notices in a person's conversation about work they asked one question about.
 */
export const collaborationCreateOptionsSchema = Type.Object(
    {
        reportToCreator: Type.Optional(Type.Boolean()),
        metadata: Type.Optional(agentMetadataSchema),
        /**
         * The client mutation the collaborator answers, for a creator that is not on its own run,
         * such as a workflow that took it at launch; null for none. Omitted, it is the mutation the
         * creating run answers now.
         */
        mutationId: Type.Optional(
            Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
        ),
        /**
         * The creating agent's own persistent mode. The collaborator runs in it unless the input's
         * `read_only` or `full_mode` says otherwise, and `full_mode` requires it to be Full access. Omitted,
         * it is the product default, for code that creates an agent on no agent's behalf.
         */
        creatorPermissionMode: Type.Optional(agentPermissionModeSchema),
    },
    { additionalProperties: false },
);

/**
 * Send text to a collaborator this agent can already reach. The explanation is the line a person
 * reading the recipient's conversation sees in place of the message until they open it; code that
 * sends without one leaves that line to the sender's name alone.
 */
export const collaborationSendInputSchema = Type.Object(
    {
        toAgentId: collaborationAgentIdSchema,
        text: collaborationMessageTextSchema,
        explanation: Type.Optional(senderAgentExplanationSchemaOf()),
    },
    { additionalProperties: false },
);

/** What `send_agent_message` takes: a model always says in one line what its message is. */
export const collaborationSendToolInputSchema = Type.Object(
    {
        toAgentId: collaborationAgentIdSchema,
        explanation: senderAgentExplanationArgumentSchema,
        text: collaborationMessageTextSchema,
    },
    { additionalProperties: false },
);

/** What one `create_agent` call produced. */
export const collaborationCreateResultSchema = Type.Object(
    {
        agentId: collaborationAgentIdSchema,
    },
    { additionalProperties: false },
);

/** The agent asking for a collaborator: its account and model decide its harness. */
export interface CollaborationCreator {
    readonly provider: string;
    readonly model: string | undefined;
}

export type CollaborationAgentId = Static<typeof collaborationAgentIdSchema>;
export type CollaborationEffort = Static<typeof collaborationEffortSchema>;
export type CollaborationServiceTier = Static<typeof collaborationServiceTierSchema>;
export type CollaborationAgentSelection = Static<typeof collaborationAgentSelectionSchema>;
export type CollaborationModelChoice = Static<typeof collaborationModelChoiceSchema>;
export type CollaborationCreateInput = Static<typeof collaborationCreateInputSchema>;
export type CollaborationCreateOptions = Static<typeof collaborationCreateOptionsSchema>;
export type CollaborationSendInput = Static<typeof collaborationSendInputSchema>;
export type CollaborationSendToolInput = Static<typeof collaborationSendToolInputSchema>;
export type CollaborationCreateResult = Static<typeof collaborationCreateResultSchema>;
