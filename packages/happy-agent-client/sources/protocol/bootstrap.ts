/** Bootstrap: one request that gets a desktop client on screen instantly. */

import { type Static, Type } from "@sinclair/typebox";

import {
    type Agent,
    type AgentDraftResponse,
    type AgentModeResponse,
    type AgentResponse,
    agentSchema,
} from "./agents.js";
import { botSchema } from "./bots.js";
import { cloudSchema } from "./cloud.js";
import { type EventCursor, eventCursorSchema } from "./common.js";
import { daemonConfigSchema, onboardingStateSchema } from "./daemon.js";
import { happyIntegrationSchema } from "./integrations.js";
import type { UserMessage } from "./messages.js";
import type { BackgroundProcess } from "./processes.js";
import { profileSchema } from "./profile.js";
import { projectSchema } from "./projects.js";
import type { AgentUsageResponse } from "./usage.js";
import { workspaceSchema } from "./workspaces.js";

/**
 * `GET /v0/agents/:agentId/bootstrap`
 *
 * The small, current agent facts a conversation client needs before following events. Usage and
 * mode keep their own focused endpoints; this composes those exact response fields with the
 * durable pending composer queue and the cursor that closes the snapshot window.
 */
export interface AgentBootstrapResponse
    extends AgentDraftResponse, AgentModeResponse, AgentResponse, AgentUsageResponse {
    /** Queued and steering messages not yet accepted by inference, oldest first. */
    pending: UserMessage[];
    /** Full background-process activity, newest first. Absent on older compatible daemons. */
    processes?: BackgroundProcess[];
    /** Full child-agent activity, newest first. Absent on older compatible daemons. */
    subagents?: Agent[];
    cursor: EventCursor;
}

/**
 * `GET /v0/bootstrap/desktop`
 *
 * A composition of other endpoints' objects; nothing here has a shape of its
 * own. There is no separate list of active agents: each included project and
 * workspace carries its own ordered active top-level agents, and the archived agents of those
 * owners arrive together in `archivedAgents`. Every full agent may embed its recursive
 * active subtask tree, including each bot's agent and shared-filesystem subtasks.
 */
export const desktopBootstrapResponseSchema = Type.Object({
    /**
     * The archived agents of the included projects and workspaces, newest `archivedAt` first
     * with the agent ID as the tie-breaker, bounded to the most recently archived ones. Absent
     * on older compatible daemons, which carry no archived agents in bootstrap.
     */
    archivedAgents: Type.Optional(Type.Array(agentSchema)),
    /** Every bot, archived ones included. Absent on older compatible daemons. */
    bots: Type.Optional(Type.Array(botSchema)),
    config: daemonConfigSchema,
    /**
     * The newest event cursor as of this snapshot. Opening the event stream
     * from here leaves no window for a change to fall between the two.
     */
    cursor: eventCursorSchema,
    /** Current Happy Cloud authentication state. Absent on older compatible daemons. */
    cloud: Type.Optional(cloudSchema),
    /** Current Happy mobile connection state. Absent on older compatible daemons. */
    happyIntegration: Type.Optional(happyIntegrationSchema),
    onboarding: onboardingStateSchema,
    profile: profileSchema,
    /** Every active project, in catalog order. */
    projects: Type.Array(projectSchema),
    /** Each project's root workspace and the workspaces directly under it. */
    workspaces: Type.Array(workspaceSchema),
});
export type DesktopBootstrapResponse = Static<typeof desktopBootstrapResponseSchema>;
