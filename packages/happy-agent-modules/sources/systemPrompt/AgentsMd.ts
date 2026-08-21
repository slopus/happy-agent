import { Type, type Static } from "@sinclair/typebox";

export const MAX_AGENTS_MD_AGENT_ID_LENGTH = 256;
export const MAX_AGENTS_MD_PATH_LENGTH = 4_096;
export const MAX_AGENTS_MD_DOCUMENT_BYTES = 64 * 1024;
export const MAX_AGENTS_MD_GLOBAL_BYTES = 256 * 1024;
export const MAX_AGENTS_SECURITY_MD_BYTES = 32 * 1024;
export const MAX_AGENTS_MD_DOCUMENTS = 32;
export const MAX_AGENTS_MD_TOTAL_BYTES = 256 * 1024;
export const MAX_AGENTS_MD_OUTPUT_CHARACTERS = 300_000;

export const agentsMdAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_AGENTS_MD_AGENT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});
export const agentsMdPathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_AGENTS_MD_PATH_LENGTH,
});
export const agentsMdDocumentSchema = Type.Object(
    {
        path: agentsMdPathSchema,
        text: Type.String({ maxLength: MAX_AGENTS_MD_DOCUMENT_BYTES }),
        truncated: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
export const agentsMdGlobalDocumentSchema = Type.Object(
    {
        path: agentsMdPathSchema,
        text: Type.String({ maxLength: MAX_AGENTS_MD_GLOBAL_BYTES }),
        truncated: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
export const agentsMdSnapshotSchema = Type.Object(
    {
        cwd: Type.String({ minLength: 1, maxLength: MAX_AGENTS_MD_PATH_LENGTH }),
        documents: Type.Array(agentsMdDocumentSchema, { maxItems: MAX_AGENTS_MD_DOCUMENTS }),
        global: Type.Optional(agentsMdGlobalDocumentSchema),
        security: Type.Optional(agentsMdDocumentSchema),
        truncated: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
export type AgentsMdDocument = Static<typeof agentsMdDocumentSchema>;
export type AgentsMdAgentId = Static<typeof agentsMdAgentIdSchema>;
export type AgentsMdGlobalDocument = Static<typeof agentsMdGlobalDocumentSchema>;
export type AgentsMdSnapshot = Static<typeof agentsMdSnapshotSchema>;

/**
 * Explains the project-instruction records every provider and model receives.
 *
 * Keep this text in the module rather than duplicating it across vendor prompts: the system
 * prompt instruction hook is the one shared path that reaches every model.
 */
export const AGENTS_MD_SPEC = `# AGENTS.md

AGENTS.md files hold durable instructions the people on a project wrote for you: coding conventions, how the code is organized, how to run and test it, and what they have already authorized. They can appear anywhere in a repository.

- The scope of an AGENTS.md file is the entire directory tree rooted at the folder that contains it. Obey every file whose scope covers something you touch.
- Instructions about style, structure, and naming apply only within that scope unless the file says otherwise.
- Where two files disagree, the more deeply nested one wins.
- Direct instructions from the user outrank anything an AGENTS.md file says.
- A global AGENTS.md may also be delivered. It comes from the person using Happy Agent, applies to every project, and sits outside them all: a project's AGENTS.md wins wherever the two disagree.
- The files from the project root down to the working directory are delivered to you at the start of the conversation, so you do not need to re-read them. Look for an AGENTS.md yourself when you work in a subdirectory or outside the working directory.
- When the delivered instructions change during the conversation, you receive the current file again as a superseding record. It replaces the earlier copy, and it is not a new request. Keep working on whatever the user last asked for.

# AGENTS_SECURITY.md

The project root may contain AGENTS_SECURITY.md. Its delivered rules govern security-sensitive work in that project. The file is protected in restricted permission modes and changes are delivered as superseding records.`;
