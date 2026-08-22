/** Bootstrap: one request that gets a desktop client on screen instantly. */

import type { Agent, AgentDraftResponse, AgentModeResponse, AgentResponse } from "./agents.js";
import type { EventCursor } from "./common.js";
import type { DaemonConfig, OnboardingState } from "./daemon.js";
import type { UserMessage } from "./messages.js";
import type { BackgroundProcess } from "./processes.js";
import type { Profile } from "./profile.js";
import type { Project } from "./projects.js";
import type { AgentUsageResponse } from "./usage.js";
import type { Workspace } from "./workspaces.js";

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
 * own. There is no separate global agent list: each included project and
 * workspace carries its own ordered top-level agents.
 */
export interface DesktopBootstrapResponse {
    config: DaemonConfig;
    profile: Profile;
    onboarding: OnboardingState;
    /** Every active project, in catalog order. */
    projects: Project[];
    /** Each project's root workspace and the workspaces directly under it. */
    workspaces: Workspace[];
    /**
     * The newest event cursor as of this snapshot. Opening the event stream
     * from here leaves no window for a change to fall between the two.
     */
    cursor: EventCursor;
}
