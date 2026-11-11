/** Questions: a run that cannot proceed without the person. */

import type { Cuid2, ResourceVersion, Timestamp } from "./common.js";

/** One option the person picks from. */
export interface QuestionOption {
    label: string;
    description: string;
}

/** One environment variable a secret request asks for. */
export interface QuestionSecretRequestVariable {
    name: string;
    /** What the value is or where to find it; `null` when the agent gave no hint. */
    description: string | null;
}

/**
 * The prefilled secret an agent asks for. The client creates the secret through
 * `POST /v0/secrets` (or lets the person pick an existing one) and answers with
 * the secret ID only, never a value.
 */
export interface QuestionSecretRequest {
    /** A suggested secret name, or `null` when the agent has no preference. */
    suggestedId: string | null;
    description: string;
    /** The 1–64 variables the agent needs, in the agent's order. */
    environmentVariables: QuestionSecretRequestVariable[];
}

/**
 * Marks a question asked by something outside the agent, such as an MCP server
 * or the agent's own harness wanting the person's approval. The agent cannot
 * answer it, and the answer goes to whatever asked. Clients should tell it apart
 * from the agent's own questions and name `serverTitle` as the party asking.
 * Treat an unknown `source` as a permission request from an unnamed party.
 */
export interface QuestionPermissionRequest {
    /**
     * `"mcp_elicitation"`: an MCP server elicitation during an agent tool call.
     * `"harness"`: the permission system of the foreign harness the agent runs
     * on, such as Claude Code, asking before an action.
     */
    source: "mcp_elicitation" | "harness";
    /** The configured MCP server name or harness ID, 1–128 characters. */
    server: string;
    /** The server's or harness's display name, 1–128 characters. */
    serverTitle: string;
}

/** One prompt inside a question. */
export interface QuestionPrompt {
    id: Cuid2;
    /** A short label for the prompt. */
    header: string;
    question: string;
    multiSelect: boolean;
    /** Possibly empty, and then the answer is free text. */
    options: QuestionOption[];
    /**
     * Present only on a secret request, which is then the question's only prompt.
     * Absent from daemons that predate secret requests.
     */
    secretRequest?: QuestionSecretRequest;
}

/** The question object. An agent has at most one open at a time. */
export interface Question {
    id: Cuid2;
    agentId: Cuid2;
    /** Whose run is waiting. */
    runId: Cuid2;
    /** `"canceled"` means the run stopped needing the answer. */
    status: "pending" | "answered" | "canceled";
    /**
     * Shared Markdown background for all prompts, 1–100,000 characters.
     * Absent from daemons that predate question context.
     */
    context?: string;
    /** One or more prompts, answered together. */
    questions: QuestionPrompt[];
    /**
     * Present only when something outside the agent asks for permission.
     * Absent from daemons that predate permission requests.
     */
    permissionRequest?: QuestionPermissionRequest;
    /** When the agent proceeds on its own; `null` waits indefinitely. */
    autoResolveAt: Timestamp | null;
    /** `null` while pending; a map from prompt ID to the chosen values. */
    answers: Record<string, string[]> | null;
    version: ResourceVersion;
    createdAt: Timestamp;
    answeredAt: Timestamp | null;
}

/** `GET /v0/agents/:agentId/question` — `null` when nothing is pending. */
export interface PendingQuestionResponse {
    question: Question | null;
}

/** `POST /v0/agents/:agentId/question/:questionId/answer` */
export interface QuestionResponse {
    question: Question;
}

/** `POST /v0/agents/:agentId/question/:questionId/answer` */
export interface AnswerQuestionRequest {
    /**
     * Each prompt ID mapped to the person's values. A value matching an option
     * label is a selection; any other string is free text. Every prompt must
     * receive at least one value.
     */
    answers: Record<string, string[]>;
    mutationId?: string;
}
