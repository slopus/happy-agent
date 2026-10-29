import { createId } from "@paralleldrive/cuid2";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
    cuid2Schema,
    DEFAULT_AGENT_PERMISSION_MODE,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { SessionReasoningEffort, SessionServiceTier } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    afterCommit,
    detach,
    forever,
    isAbortedError,
    withLifetime,
    type Context,
    type RootContext,
} from "@steve.kite/stdlib";

import {
    applySpaceSidebarOperations,
    diffSpaceSidebar,
    formatSpaceSidebar,
    locateSpaceSidebarNode,
    messageModeSchema,
    SpaceSidebarError,
    SpaceSidebarOperationError,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
    type SpaceSidebarSpaceNode,
} from "@slopus/happy-agent-client";

import { BotsModule, type BotRecord } from "../bots/index.js";
import {
    ArtifactsModule,
    readSidebarDocument,
    SidebarValidationError,
    type ArtifactAuthor,
    type ArtifactRecord,
    type UpdateArtifactInput,
} from "../artifacts/index.js";
import { CollaborationModule } from "../collaboration/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { EventsModule } from "../events/index.js";
import { HistoryModule } from "../history/index.js";
import { SubtasksModule } from "../subtasks/index.js";
import { SurfacesModule } from "../surfaces/index.js";
import { TasksModule, type TaskRecord } from "../tasks/index.js";
import { TeamModule } from "../team/index.js";
import { TitlesModule } from "../titles/index.js";
import { UserSettingsModule } from "../userSettings/index.js";
import {
    AGENT_MESSAGE_ORIGIN_METADATA,
    isUserOriginMetadata,
    USER_MESSAGE_ORIGIN_METADATA,
} from "../impl/messageOrigin.js";
import { discoverWork, type SpaceDiscoveryAssistant } from "./impl/discoverWork.js";

import {
    SPACE_STANDALONE_OWNER,
    spaceOwnerIdSchema,
    SpaceConflictError,
    SpaceNotFoundError,
    SpaceStorageError,
    SpaceInputError,
    type SidebarAuthor,
    type SidebarProposal,
    type SidebarProposalNewRow,
    type SidebarProposalRecord,
    type SpaceAttachableSurfaceType,
    type SpaceBatch,
    type SpaceDescription,
    type SpaceIcon,
    type SpaceIconSlug,
    type SpaceOwnerId,
    type SpaceOwnerState,
    type SpacePendingChange,
    type SpaceRecord,
    type SpaceRef,
    type SpaceSectionRecord,
    type SpaceSnapshot,
} from "./Space.js";
import { spaceEventSchema, type SpaceEvent, type SpaceEventListener } from "./SpaceEvent.js";
import type {
    SpaceSidebarOutline,
    SpaceSidebarOutlineGroup,
    SpaceSidebarOutlineRow,
} from "./SpaceSidebarOutline.js";
import { spaceMigrations } from "./SpaceMigrations.js";
import {
    applySpaceChanges,
    compareRows,
    rowKeyAfter,
    rowKeyAtTop,
} from "./impl/applySpaceChanges.js";
import { composeSpaceBatchNote } from "./impl/composeSpaceBatchNote.js";
import { formatConversationReads } from "./impl/formatConversationReads.js";
import { formatConversationAge, formatConversationTurns } from "./impl/formatConversationTurns.js";
import {
    formatPrioritizingInstructions,
    PRIORITIZING_REVISION,
} from "./impl/formatPrioritizingInstructions.js";
import {
    PRIORITIZING_DEFAULT_MODEL_SETTING,
    selectPrioritizingRoute,
} from "./impl/selectPrioritizingRoute.js";
import { spaceContentKey } from "./impl/spaceRefKey.js";
import {
    deletePendingChanges,
    deleteSpace,
    insertBatch,
    insertSection,
    insertSidebarMutation,
    insertSpace,
    insertSpaceIfAbsent,
    queryBatches,
    queryOwnerByPrioritizingAgent,
    queryOwnerBySidebarArtifact,
    queryOwnerState,
    queryOwnerStates,
    queryOwnersWithPendingChanges,
    queryPendingChanges,
    querySection,
    querySections,
    querySidebarMutation,
    querySpace,
    querySpaceByRef,
    querySpaces,
    querySpacesByAgent,
    querySpacesByRef,
    updateSection,
    updateSpace,
    updateSpaceBriefedAt,
    upsertPendingChange,
    writeOwnerState,
    deleteSection,
} from "./persistence/SpacesPersistence.js";
import { attachToMyRowTool } from "./tools/attach_to_my_row.js";
import { requestSpacePlacementTool } from "./tools/request_space_placement.js";
import { prioritizingTools, voiceSidebarTools } from "./tools/prioritizingTools.js";
import {
    applyPrioritizingOperations,
    placedSidebarIds,
    projectSidebar,
} from "./impl/applyPrioritizingOperations.js";
import { liftAttachmentsOut, liftRemovedAttachments } from "./impl/liftSidebarAttachments.js";
import { migrateLegacySidebar } from "./impl/migrateLegacySidebar.js";
import {
    affirmSidebarAuthorship,
    recordSidebarAuthorship,
} from "./impl/recordSidebarAuthorship.js";
import { type PrioritizingRules } from "./impl/reviewPrioritizingOperation.js";
import {
    archiveOffers,
    reviewProposalOperations,
    withoutArchive,
} from "./impl/reviewProposalOperations.js";
import {
    conversationBriefPrefix,
    formatConversationBrief,
} from "./impl/formatConversationBrief.js";
import {
    isSidebarHeading,
    keptAboveSeparator,
    newSpacePosition,
    regroupedSidebarIds,
    seedSidebar,
    shownSidebarRows,
    SIDEBAR_VISIBLE_BUDGET,
    SidebarConflictError,
    type ClassicSidebar,
    sidebarPlacement,
} from "./impl/sidebarLayout.js";

/**
 * How long an event that wakes Prioritizing waits for the rest of its burst, so a person dragging
 * several rows, or several new chats at once, make one run.
 */
const WAKE_DELAY_MS = 2_000;
/** How long a run starting or settling waits for the rest of its burst before rows show it. */
const WORKING_DELAY_MS = 300;
/** How often waiting wakes and queued changes are checked, such as after a restart. */
const CHECK_INTERVAL_MS = 15_000;
const BRIEF_FUNCTION = "spaces.briefPrioritizing";
/** The opening task of a new Prioritizing; work seeded before it existed waits for it. */
const PRIORITIZING_OPENING =
    "Keep this person's sidebar tidy from now on. It was just made to mirror the sidebar they already know, so change nothing else in it now: read it with list_sidebar, show your own conversation as a session under Happy, and give rows and sessions icons. From your next notice on, place new work as your instructions say, and propose anything larger.";
/**
 * Told once to a Prioritizing that predates its own row. What it still needs to do is its own call,
 * from its conversation and the sidebar.
 */
const PRIORITIZING_UPGRADED =
    "Happy Agent was updated. You now have a conversation of your own, your notes go to your conversation, and larger changes are proposals the person accepts. Check the sidebar and your history: show your conversation as a session under Happy, and if the person has not seen a proposal from you yet, propose once how to file the work they already have.";
const PRIORITIZING_UPDATED =
    "Happy Agent was updated, and your instructions may have changed. Check the sidebar against them, starting with where your own conversation stands.";
/**
 * The opening task of a Prioritizing that Happy's onboarding starts: Happy is about to hand it the
 * person's work, and its conversation is already shown under Happy.
 */
const PRIORITIZING_ONBOARDING_OPENING =
    "Happy is onboarding this person and is about to message you with their work. Your conversation is already shown under Happy. Read the sidebar with list_sidebar now; when Happy's message arrives, do what it asks and propose their sidebar.";
/** Focus wears a target: its own row and its session under Happy. */
const FOCUS_ICON: SpaceIconSlug = "goals";
/** The icon of Voice's own row. */
const VOICE_ICON: SpaceIconSlug = "ai-agent";
/** How many bytes `read_conversations` returns at most, and for one conversation. */
const CONVERSATIONS_TEXT_LIMIT = 24_000;
const CONVERSATION_TEXT_LIMIT = 4_000;
const CONVERSATION_MESSAGE_LIMIT = 1_200;
const MAX_BRIEF_TEXT = 2_000;
const NEW_WORK_EXCERPT = 1_500;
/** How many notices about one conversation wait for the next brief; older ones are dropped. */
const CONVERSATION_BRIEFS_KEPT = 3;
/** Work active this recently is never folded or hidden by Prioritizing. */
export const SPACE_RECENT_WORK_MS = 2 * 60 * 60_000;

const briefArgumentsSchema = Type.Object(
    {
        ownerUserId: spaceOwnerIdSchema,
        messageId: cuid2Schema,
        generation: Type.Optional(Type.Integer({ minimum: 0 })),
        text: Type.String({ minLength: 1, maxLength: 20_000 }),
    },
    { additionalProperties: false },
);

/**
 * One flat sidebar per person, kept tidy by Prioritizing, a subtask of Happy.
 *
 * A space is one row: Happy, or an item wrapping a task, bot, or Surface. Separators are
 * untitled visual dividers. New work is a stem cell: a fresh unnamed task wrapped in a row that waits under Happy
 * until Prioritizing places it.
 *
 * Every organisation write goes through Prioritizing's tools, except the person's own explicit
 * actions: moving, folding, hiding, or removing a row, opening a section, and creating new work.
 * Prioritizing is woken by events — the person's own changes and new work — never by its own
 * writes. Its moves are queued and applied together when its turn ends, with one note in its own
 * conversation and a recorded diff. Icons apply at once because they move nothing.
 */
export class SpacesModule implements AgentModule {
    readonly name = "spaces";
    readonly migrations = spaceMigrations;

    readonly #bots: BotsModule;
    readonly #artifacts: ArtifactsModule | undefined;
    readonly #collaboration: CollaborationModule | undefined;
    readonly #config: ConfigModule;
    readonly #events: EventsModule;
    readonly #history: HistoryModule;
    readonly #subtasks: SubtasksModule;
    readonly #team: TeamModule;
    readonly #titles: TitlesModule;
    readonly #userSettings: UserSettingsModule;
    readonly #surfaces: SurfacesModule;
    readonly #tasks: TasksModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #listeners = new Set<SpaceEventListener>();
    /** The pending wake of each person's Prioritizing, which gathers the rest of a burst. */
    readonly #wakeTimers = new Map<SpaceOwnerId, ReturnType<typeof setTimeout>>();
    /** The pending `working` refresh of each conversation, which gathers a burst of runs. */
    readonly #workingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Prioritizing agents with a turn in progress; their batch waits until they finish. */
    readonly #busyPrioritizing = new Set<string>();
    /** Prioritizing agents being made right now, which are not sessions to brief about. */
    readonly #creatingPrioritizing = new Set<string>();
    readonly #unsubscribe: (() => void)[] = [];
    #agents: AgentSystemRef | undefined;
    #lifetime: RootContext | undefined;
    #checkLoop: Promise<void> | undefined;
    readonly #loopLifetime = new AbortController();

    constructor(
        config: ConfigModule,
        tasks: TasksModule,
        bots: BotsModule,
        surfaces: SurfacesModule,
        history: HistoryModule,
        events: EventsModule,
        durableFunctions: DurableFunctionsModule,
        subtasks: SubtasksModule,
        team: TeamModule,
        userSettings: UserSettingsModule,
        titles: TitlesModule,
        artifacts?: ArtifactsModule,
        collaboration?: CollaborationModule,
    ) {
        this.#config = config;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#surfaces = surfaces;
        this.#history = history;
        this.#events = events;
        this.#durableFunctions = durableFunctions;
        this.#subtasks = subtasks;
        this.#team = team;
        this.#userSettings = userSettings;
        this.#titles = titles;
        this.#artifacts = artifacts;
        this.#collaboration = collaboration;
        artifacts?.bindSpaces(this);
        // Telling Prioritizing about new work commits with the work; the message is delivered
        // after the commit and survives a restart in between. A repeated delivery carries the
        // same message ID, so Prioritizing hears it once.
        durableFunctions.register({
            name: BRIEF_FUNCTION,
            argumentsSchema: briefArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#deliverBrief(
                    ctx,
                    call.arguments.ownerUserId,
                    call.arguments.messageId,
                    call.arguments.text,
                    call.arguments.generation ?? 0,
                );
                return null;
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        afterStart: async (ctx: Context): Promise<void> => {
            this.#subscribe();
            for (const owner of await queryOwnerStates(ctx)) {
                if (!(await this.#stemCellsEnabled(ctx, owner.ownerUserId))) {
                    await this.#disablePrioritizing(ctx, owner.ownerUserId);
                    continue;
                }
                // A Prioritizing from before its own row gets one, and one from before its
                // current instructions is told once, so it checks the sidebar right after an update.
                await ctx.inTx(async (txCtx) => {
                    const agentId = await this.#livePrioritizing(txCtx, owner.ownerUserId);
                    if (agentId === undefined) return;
                    const state = await this.#ownerState(txCtx, owner.ownerUserId);
                    const rowless =
                        (await querySpaceByRef(txCtx, owner.ownerUserId, "focus")) === undefined;
                    if (!rowless && state.prioritizingRevision === PRIORITIZING_REVISION) return;
                    await writeOwnerState(txCtx, {
                        ...state,
                        prioritizingRevision: PRIORITIZING_REVISION,
                    });
                    if (rowless) await this.#ensureFocusRow(txCtx, owner.ownerUserId, agentId);
                    await this.#brief(
                        txCtx,
                        owner.ownerUserId,
                        rowless ? PRIORITIZING_UPGRADED : PRIORITIZING_UPDATED,
                    );
                });
            }
            await ctx.inTx((tx) => this.#reconcileSurfaces(tx));
            const lifetime = this.#lifetime;
            if (lifetime === undefined) return;
            // The check belongs to the daemon and stops when this module closes.
            const signal =
                ctx.lifetime === undefined
                    ? this.#loopLifetime.signal
                    : AbortSignal.any([ctx.lifetime, this.#loopLifetime.signal]);
            this.#checkLoop = forever(
                withLifetime(lifetime.named("spaces-check"), signal),
                { delay: CHECK_INTERVAL_MS, delayFirst: true, name: "spaces-check" },
                async (loopCtx) => {
                    await this.#checkOwners(loopCtx);
                },
            ).catch((error: unknown) => {
                if (!isAbortedError(error) && !signal.aborted) {
                    ctx.log.warn("Sidebar tidying stopped.", {}, error);
                }
            });
        },
        instructions: () => "",
        overrideInstructions: async (ctx, scope, input) =>
            (await queryOwnerByPrioritizingAgent(ctx, scope.agent.id)) === undefined
                ? input.instructions
                : formatPrioritizingInstructions(),
        tools: async (ctx, scope): Promise<readonly AnyAgentTool[]> => {
            // Only people who opted into Stem Cells have a sidebar their conversations attach
            // to, or a Prioritizing to ask; nobody else's conversations change.
            const tools: AnyAgentTool[] =
                (await this.#attachHosts(ctx, scope.agent.id)).length > 0
                    ? [attachToMyRowTool(this, scope.agent.id)]
                    : [];
            // People ask for sidebar changes in the conversations they have, not in helpers.
            if ((await this.#requireAgents().parentOf(ctx, scope.agent.id)) !== null) return tools;
            const owners = new Set(
                (await querySpacesByAgent(ctx, scope.agent.id)).map((row) => row.ownerUserId),
            );
            if (!this.#config.configuration.values.feature.team.enabled)
                owners.add(SPACE_STANDALONE_OWNER);
            for (const owner of owners)
                if ((await this.#livePrioritizing(ctx, owner)) !== undefined)
                    return [...tools, requestSpacePlacementTool(this, scope.agent.id)];
            return tools;
        },
        // Prioritizing is one job with one tool array and nothing else.
        overrideTools: async (ctx, scope, input) => {
            const owner = await queryOwnerByPrioritizingAgent(ctx, scope.agent.id);
            return owner === undefined
                ? input.tools
                : (await this.#stemCellsEnabled(ctx, owner.ownerUserId))
                  ? prioritizingTools(this, owner.ownerUserId, scope.agent.id, {
                        discovery: owner.discovery !== undefined,
                    })
                  : [];
        },
        beforeAgentLoop: async (ctx, scope) => {
            const owner = await queryOwnerByPrioritizingAgent(ctx, scope.agent.id);
            if (owner !== undefined) {
                if (!(await this.#stemCellsEnabled(ctx, owner.ownerUserId))) {
                    await this.#requireAgents().abort(ctx, scope.agent.id);
                    return;
                }
                this.#busyPrioritizing.add(scope.agent.id);
            }
        },
        afterAgentSettled: async (ctx, scope, settlement) => {
            const owner = (await queryOwnerByPrioritizingAgent(ctx, scope.agent.id))?.ownerUserId;
            if (owner === undefined) {
                const rows = await querySpacesByAgent(ctx, scope.agent.id);
                for (const row of rows) {
                    if (row.role === "item")
                        await this.#queueSidebarBrief(
                            ctx,
                            row.ownerUserId,
                            `Work finished or paused in space ${row.id}.`,
                        );
                }
                // A session under new work may now need the person, such as for a review.
                if (rows.length === 0 && (await this.#startedAsStemCell(ctx, scope.agent.id))) {
                    const agentText = await this.#lastAgentText(ctx, scope.agent.id);
                    for (const row of await this.#sessionRows(ctx, scope.agent.id))
                        await this.#queueSidebarBrief(
                            ctx,
                            row.ownerUserId,
                            formatConversationBrief({
                                rowId: row.id,
                                sessionId: scope.agent.id,
                                agentText,
                            }),
                            { replaces: conversationBriefPrefix(row.id) },
                        );
                }
                return;
            }
            this.#busyPrioritizing.delete(scope.agent.id);
            const lifetime = this.#lifetime;
            if (lifetime === undefined) return;
            // Prioritizing has finished deciding: its changes apply now, and what happened
            // meanwhile wakes it once more. A failed run hears its notices again next time.
            const settledCtx = lifetime.named("spaces-prioritizing-settled");
            void (async () => {
                await this.#settleBrief(settledCtx, owner, settlement.error === undefined);
                await this.#applyIfDue(settledCtx, owner, "settled");
                await this.#reportToHappy(settledCtx, owner, scope.agent.id);
                await this.#wake(settledCtx, owner);
            })().catch((error: unknown) => {
                ctx.log.warn("The sidebar batch could not be applied.", {}, error);
            });
        },
        // Sessions under a person's rows are Prioritizing's to give icons and to show or hide.
        agentCreatedTransact: async (ctx, _scope, agent) => {
            if (
                this.#creatingPrioritizing.has(agent.id) ||
                agent.metadata?.["subtaskConversation"] === true
            )
                return;
            const title = agent.metadata?.["title"];
            // Only the fact: whether the person should see it is Prioritizing's call, from its prompt.
            for (const row of await this.#sessionRows(ctx, agent.id))
                await this.#queueSidebarBrief(
                    ctx,
                    row.ownerUserId,
                    `New session ${agent.id}${typeof title === "string" ? ` "${title}"` : ""} started under row ${row.id}.`,
                    { wake: true },
                );
        },
        metadataChangedTransact: async (ctx, _scope, change) => {
            if (typeof change.update["archivedAt"] !== "number") return;
            const focus = await queryOwnerByPrioritizingAgent(ctx, change.agentId);
            if (focus !== undefined) await this.#removeFocusRow(ctx, focus.ownerUserId);
            for (const row of await querySpacesByAgent(ctx, change.agentId))
                if (row.role === "voice") await this.#removeVoiceRow(ctx, row.ownerUserId, row.id);
            for (const owner of await this.#sessionOwners(ctx, change.agentId))
                await this.#sidebarLifecycle(ctx, owner, { remove: change.agentId });
        },
        messageAcceptedTransact: async (ctx, scope, accepted) => {
            // Another agent's message, such as the task it created, arrives as an agent's.
            if (accepted.message.role !== "user" && accepted.message.role !== "agent") return;
            const fromPerson =
                accepted.message.role === "user" && isUserOriginMetadata(accepted.metadata);
            // Happy handed Prioritizing work: when that turn ends, Happy hears what came of it.
            // Its opening task is Happy's only when onboarding gave it one, which startFocus marks.
            if (accepted.message.role === "agent") {
                const focus = await queryOwnerByPrioritizingAgent(ctx, scope.agent.id);
                if (focus !== undefined) {
                    const text = accepted.message.content
                        .flatMap((block) => (block.type === "text" ? [block.text] : []))
                        .join("\n")
                        .trim();
                    if (
                        accepted.message.author.id ===
                            (await this.#happyAgentId(ctx, focus.ownerUserId)) &&
                        !(await this.#opensConversation(ctx, scope.agent.id, text))
                    )
                        await writeOwnerState(ctx, { ...focus, happyAsked: true });
                    return;
                }
            }
            // The person wrote to Prioritizing itself: what it changes in answer is their request.
            const asked = fromPerson
                ? await queryOwnerByPrioritizingAgent(ctx, scope.agent.id)
                : undefined;
            if (asked !== undefined) {
                await writeOwnerState(ctx, { ...asked, applyRequestedAt: Date.now() });
                return;
            }
            const own = await querySpacesByAgent(ctx, scope.agent.id);
            const rows = own.length > 0 ? own : await this.#sessionRows(ctx, scope.agent.id);
            const text = accepted.message.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n")
                .trim();
            const now = Date.now();
            let agentText: { readonly text: string | undefined } | undefined;
            let writer: { readonly name: string | undefined } | undefined;
            for (const row of rows) {
                if (row.role === "focus" || text.length === 0) continue;
                // New work is told to Prioritizing with its first message, whoever wrote it:
                // the person, or the agent that created the task. Another agent's message counts
                // only when it opens the conversation, not a report into work that had others.
                if (
                    row.role === "item" &&
                    own.length > 0 &&
                    row.briefedAt === undefined &&
                    (row.icon === undefined || row.icon.type === "stem_cell") &&
                    (fromPerson || (await this.#opensConversation(ctx, scope.agent.id, text)))
                ) {
                    await updateSpaceBriefedAt(ctx, row.id, now);
                    const placedByPerson =
                        (await this.#ownerState(ctx, row.ownerUserId)).sidebarAuthorship?.[row.id]
                            ?.place === "person";
                    await this.#queueSidebarBrief(
                        ctx,
                        row.ownerUserId,
                        newWorkBrief(row, text, placedByPerson === true),
                        { wake: true },
                    );
                    continue;
                }
                if (!fromPerson) continue;
                // Every later message the person writes, in any of their rows or a session under
                // one, waits for the next brief with the agent's reply it answers: what they say
                // anywhere is what Focus prioritizes by. While the work still waits for its first
                // placement, the message may make its subject clear, so it wakes.
                if (!(await this.#stemCellsEnabled(ctx, row.ownerUserId))) continue;
                agentText ??= { text: await this.#lastAgentText(ctx, scope.agent.id) };
                // In a team, someone else writing in the person's work is news to them, so it
                // wakes their Prioritizing under that teammate's name.
                writer ??= { name: await this.#teammateName(ctx, accepted.metadata?.userId) };
                const teammate =
                    writer.name !== undefined && accepted.metadata?.userId !== row.ownerUserId
                        ? writer.name
                        : undefined;
                const unplaced =
                    own.length > 0 &&
                    row.placement === "pending" &&
                    (await this.#ownerState(ctx, row.ownerUserId)).sidebarPlacedIds?.includes(
                        row.id,
                    ) !== true;
                await this.#queueSidebarBrief(
                    ctx,
                    row.ownerUserId,
                    formatConversationBrief({
                        rowId: row.id,
                        ...(own.length > 0 ? {} : { sessionId: scope.agent.id }),
                        agentText: agentText.text,
                        personText: text,
                        ...(teammate === undefined ? {} : { teammate }),
                    }),
                    {
                        replaces: conversationBriefPrefix(row.id),
                        wake: unplaced || teammate !== undefined,
                    },
                );
            }
        },
    };

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        this.#lifetime = withAgentDatabase(detach(ctx), ctx.db) as RootContext;
        return this.#hooks;
    };

    async close(): Promise<void> {
        for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
        this.#lifetime = undefined;
        this.#loopLifetime.abort();
        for (const timer of this.#wakeTimers.values()) clearTimeout(timer);
        this.#wakeTimers.clear();
        for (const timer of this.#workingTimers.values()) clearTimeout(timer);
        this.#workingTimers.clear();
        await this.#checkLoop;
    }

    onEvent(listener: SpaceEventListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Who a person is as a sidebar owner: the standalone person, or a team user. */
    ownerFor(userId: string | undefined): SpaceOwnerId | undefined {
        return this.#tasks.memberFor(userId);
    }

    /**
     * A person's whole sidebar. The first read makes it: Happy, and a row for everything the
     * person already has, folded until Prioritizing's first tidy.
     */
    async snapshot(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceSnapshot> {
        return await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            return {
                spaces: sortForDisplay(await querySpaces(txCtx, ownerUserId)),
                sections: await querySections(txCtx, ownerUserId),
            };
        });
    }

    async get(ctx: Context, spaceId: string): Promise<SpaceRecord | undefined> {
        return await querySpace(ctx, spaceId);
    }

    /** The person's sidebar document. Widgets are left out of `html` unless `widgets` is set. */
    async sidebar(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        options: { readonly widgets?: boolean } = {},
    ) {
        return await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            const artifactId = await this.#ensureSidebar(txCtx, ownerUserId);
            await this.#migrateSidebar(txCtx, ownerUserId, artifactId);
            return await this.#readSidebar(txCtx, ownerUserId, artifactId, "latest", options);
        });
    }

    /** A document in the first grammar is rewritten once, as a version of its own. */
    async #migrateSidebar(ctx: Context, ownerUserId: SpaceOwnerId, artifactId: string) {
        const current = await this.#sidebarText(ctx, artifactId);
        const known = new Set((await querySpaces(ctx, ownerUserId)).map((space) => space.id));
        const html = migrateLegacySidebar(current.text, (id) => known.has(id));
        if (html === undefined) return;
        await this.#writeSidebar(
            ctx,
            artifactId,
            html,
            current.version,
            createId(),
            ownerAuthor(ownerUserId),
        );
        const state = await this.#ownerState(ctx, ownerUserId);
        await writeOwnerState(ctx, {
            ...state,
            sidebarPending: [],
            sidebarBrief: [
                ...(state.sidebarBrief ?? []),
                "The sidebar was rewritten in the current grammar. Decide which sessions to show under their rows.",
            ].slice(-32),
        });
    }

    /** One version's stored text: the canonical form, widgets included. */
    async #sidebarText(ctx: Context, artifactId: string, version: number | "latest" = "latest") {
        const file = await this.#requireArtifacts().readFile(
            ctx,
            artifactId,
            version,
            "index.html",
            { maxBytes: 128 * 1024 },
        );
        return { version: file.version, text: new TextDecoder().decode(file.bytes) };
    }

    async #sidebarDocument(
        ctx: Context,
        artifactId: string,
        version: number | "latest" = "latest",
    ): Promise<{ version: number; document: SpaceSidebarDocument }> {
        const { version: at, text } = await this.#sidebarText(ctx, artifactId, version);
        return { version: at, document: readSidebarDocument(text) };
    }

    /**
     * The document a batch was made against, for rebasing it, with the queued proposals before it
     * drawn in. Undefined when that version is not one the parser reads, which only a version
     * from before the grammar's rewrite can be; anchors then cannot fall back.
     */
    async #sidebarBase(
        ctx: Context,
        artifactId: string,
        version: number,
        earlier: readonly { readonly operations: readonly SpaceSidebarOperation[] }[] = [],
    ): Promise<SpaceSidebarDocument | undefined> {
        try {
            return projectSidebar(
                (await this.#sidebarDocument(ctx, artifactId, version)).document,
                earlier,
            );
        } catch (error: unknown) {
            if (error instanceof SidebarValidationError) return undefined;
            throw error;
        }
    }

    async #readSidebar(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        artifactId: string,
        version: number | "latest" = "latest",
        options: { readonly widgets?: boolean } = {},
    ) {
        const { version: at, document } = await this.#sidebarDocument(ctx, artifactId, version);
        const state = await this.#ownerState(ctx, ownerUserId);
        const open = state.sidebarProposals?.find((proposal) => proposal.status === "open");
        return {
            artifactId,
            version: at,
            html: formatSpaceSidebar(document, { widgets: options.widgets === true }),
            spaces: await querySpaces(ctx, ownerUserId),
            agentIcons: Object.fromEntries(
                Object.entries(state.agentIcons ?? {}).map(([agentId, slug]) => [
                    agentId,
                    { type: "library" as const, slug },
                ]),
            ),
            ...(state.sidebarSeed === true ? { seed: true as const } : {}),
            ...(open === undefined ? {} : { proposal: await this.#proposalResource(ctx, open) }),
        };
    }

    async #ensureSidebar(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string> {
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.sidebarArtifactId !== undefined) return state.sidebarArtifactId;
        const artifacts = this.#requireArtifacts();
        const artifactId = createId();
        const classic = await this.#classicSidebar(ctx, ownerUserId);
        const html = seedSidebar(classic);
        // Rows the person already knows are placed, not new: the two-hour rule protects them from
        // the start. Untouched new work still gets its first placement after its first message.
        const untouched = new Set(
            (await querySpaces(ctx, ownerUserId))
                .filter((space) => isUntouchedStemCell(space))
                .map((space) => space.id),
        );
        const mirrored = [...classic.surfaces, ...classic.bots, ...classic.tasks].filter(
            (id) => !untouched.has(id),
        );
        // The seed is the person's to adjust first; Prioritizing changes nothing until its next run.
        await writeOwnerState(ctx, {
            ...state,
            sidebarArtifactId: artifactId,
            sidebarSeed: true,
            sidebarPlacedIds: [...new Set([...(state.sidebarPlacedIds ?? []), ...mirrored])].slice(
                -1000,
            ),
        });
        const happy = (await querySpaces(ctx, ownerUserId)).find((space) => space.role === "happy")
            ?.contents[0];
        const actor =
            state.prioritizingAgentId === undefined
                ? ownerAuthor(ownerUserId)
                : (await artifacts.actorFor(ctx, state.prioritizingAgentId)).author;
        await artifacts.create(ctx, {
            id: artifactId,
            type: "sidebar",
            title: "Sidebar",
            files: [
                { path: "index.html", uploadId: (await artifacts.stageSidebarText(ctx, html)).id },
            ],
            author: actor,
            ...(happy?.kind === "bot"
                ? {
                      source: {
                          kind: "bot" as const,
                          botId: happy.botId,
                          ...(state.prioritizingAgentId === undefined
                              ? {}
                              : { agentId: state.prioritizingAgentId }),
                      },
                  }
                : {}),
        });
        return artifactId;
    }

    /**
     * The person's classic sidebar as the daemon knows it: joined Surfaces in their member order,
     * every bot in catalog order with Happy among them, and joined tasks in membership order.
     * Sessions under them are not part of it: the sidebar shows rows, never sessions.
     */
    async #classicSidebar(ctx: Context, ownerUserId: SpaceOwnerId): Promise<ClassicSidebar> {
        const rows = await querySpaces(ctx, ownerUserId);
        const rowFor = (match: (content: SpaceRef) => boolean) =>
            rows.find((row) => row.contents[0] !== undefined && match(row.contents[0]));
        const userId = ownerUserId === SPACE_STANDALONE_OWNER ? null : ownerUserId;
        const surfaces = (await this.#surfaces.list(ctx))
            .flatMap((surface) => {
                const member = surface.members.find((candidate) => candidate.userId === userId);
                const row = rowFor((c) => c.kind === "surface" && c.surfaceId === surface.id);
                return member === undefined || row === undefined
                    ? []
                    : [{ id: row.id, orderKey: member.orderKey }];
            })
            .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
            .map(({ id }) => id);
        let happy: string | undefined;
        const bots: string[] = [];
        for (const bot of await this.#bots.list(ctx)) {
            const row = rowFor((c) => c.kind === "bot" && c.botId === bot.id);
            if (row === undefined || bot.status !== "active") continue;
            if (row.role === "happy") happy = row.id;
            else bots.push(row.id);
        }
        const tasks: string[] = [];
        for (const { task } of await this.#tasks.listForMember(ctx, ownerUserId)) {
            const row = rowFor((c) => c.kind === "task" && c.taskId === task.id);
            if (row === undefined || task.status !== "active" || task.agentId === undefined)
                continue;
            tasks.push(row.id);
        }
        return { happy, surfaces, bots, tasks };
    }

    #requireArtifacts(): ArtifactsModule {
        if (this.#artifacts === undefined)
            throw new SpaceInputError("Sidebar artifacts are unavailable.");
        return this.#artifacts;
    }

    /** Artifact storage calls this when the sidebar artifact is made; only Spaces makes one. */
    async validateSidebarWrite(ctx: Context, artifactId: string, html: string): Promise<void> {
        const owner = await queryOwnerBySidebarArtifact(ctx, artifactId);
        if (owner === undefined)
            throw new SidebarValidationError("Sidebar artifacts are created by Spaces.");
        await this.#checkSidebarIds(ctx, owner.ownerUserId, readSidebarDocument(html));
    }

    /**
     * A top-level happy-space names one of the person's rows. A nested one names either a session
     * whose parent is the conversation it sits under, or one of the person's rows attached there;
     * a session never stands under another conversation. With `only`, just those nodes are
     * checked: the ones a batch placed, so a stale node nobody touched never blocks the person's
     * change.
     */
    async #checkSidebarIds(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        document: SpaceSidebarDocument,
        only?: ReadonlySet<string>,
        newRowIds: ReadonlySet<string> = new Set(),
    ): Promise<void> {
        if (only?.size === 0) return;
        const byId = new Map((await querySpaces(ctx, ownerUserId)).map((row) => [row.id, row]));
        const check = async (
            node: SpaceSidebarSpaceNode,
            parentAgent: string | undefined | null,
        ): Promise<void> => {
            // A proposal's new row stands only at the top level, alone.
            if (parentAgent === null && newRowIds.has(node.id)) {
                if (node.children.length > 0)
                    throw new SidebarValidationError(`New row ${node.id} holds nothing nested.`);
                return;
            }
            const row = byId.has(node.id);
            if (only === undefined || only.has(node.id)) {
                if (parentAgent === null || row) {
                    if (!row) throw new SidebarValidationError(`Unknown space ${node.id}.`);
                } else if (
                    parentAgent === undefined ||
                    (await this.#parentOf(ctx, node.id)) !== parentAgent
                ) {
                    throw new SidebarValidationError(
                        `${node.id} is not a session of the happy-space it is nested in, nor one of the person's spaces.`,
                    );
                }
            }
            let agent: string | undefined = node.id;
            if (row) {
                const content = byId.get(node.id)?.contents[0];
                agent =
                    content === undefined || content.kind === "surface"
                        ? undefined
                        : content.agentId;
            }
            for (const child of node.children) await check(child, agent);
        };
        for (const item of document.items) if (item.type === "space") await check(item, null);
    }

    async #rowIds(ctx: Context, ownerUserId: SpaceOwnerId): Promise<Set<string>> {
        return new Set((await querySpaces(ctx, ownerUserId)).map((row) => row.id));
    }

    /** An attachment someone takes out goes back to the top level, after the row that held it. */
    async #liftRemoved(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        document: SpaceSidebarDocument,
        operations: readonly SpaceSidebarOperation[],
    ): Promise<SpaceSidebarOperation[]> {
        if (!operations.some((operation) => operation.type === "remove")) return [...operations];
        const rows = await this.#rowIds(ctx, ownerUserId);
        return liftRemovedAttachments(document, operations, (id) => rows.has(id));
    }

    /**
     * The person's batch of operations, applied to the current version and rebased from the one
     * it was made against. A retry with the same mutation ID answers as the first did.
     */
    async applySidebarOperations(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: {
            readonly mutationId: string;
            readonly baseVersion: number;
            readonly operations: readonly SpaceSidebarOperation[];
        },
    ) {
        const { artifactId } = await this.sidebar(ctx, ownerUserId);
        return await ctx.inTx(async (txCtx) => {
            const digest = sidebarDigest("operations", {
                baseVersion: input.baseVersion,
                operations: input.operations,
            });
            const replay = await this.#replaySidebarMutation(
                txCtx,
                ownerUserId,
                artifactId,
                input.mutationId,
                digest,
            );
            if (replay !== undefined) return replay;
            const current = await this.#sidebarDocument(txCtx, artifactId);
            if (input.baseVersion > current.version)
                throw new SidebarConflictError(
                    current.version,
                    `The sidebar is at version ${String(current.version)}, before ${String(input.baseVersion)}.`,
                );
            const base =
                input.baseVersion === current.version
                    ? current.document
                    : await this.#sidebarBase(txCtx, artifactId, input.baseVersion);
            if (base !== undefined)
                try {
                    applySpaceSidebarOperations(base, input.operations);
                } catch (error: unknown) {
                    if (error instanceof SpaceSidebarOperationError)
                        throw new SidebarValidationError(error.message, 0, error.operationIndex);
                    throw error;
                }
            let applied: ReturnType<typeof applySpaceSidebarOperations>;
            try {
                const rows = await this.#rowIds(txCtx, ownerUserId);
                applied = applySpaceSidebarOperations(
                    current.document,
                    liftRemovedAttachments(
                        current.document,
                        input.operations,
                        (id) => rows.has(id),
                        base,
                    ),
                    base === undefined ? {} : { base },
                );
            } catch (error: unknown) {
                if (error instanceof SpaceSidebarOperationError)
                    throw new SidebarConflictError(
                        current.version,
                        error.message,
                        error.operationIndex,
                    );
                throw error;
            }
            const version = await this.#commitPersonBatch(txCtx, ownerUserId, {
                artifactId,
                current,
                applied,
                requested: input.operations,
                mutationId: input.mutationId,
                digest,
            });
            return {
                artifactId,
                version,
                html: formatSpaceSidebar(applied.document),
                operations: applied.operations,
            };
        });
    }

    /** A whole-document write from a client that predates operations, turned into operations. */
    async updateSidebar(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: { html: string; baseVersion: number; mutationId: string },
    ) {
        const { artifactId } = await this.sidebar(ctx, ownerUserId);
        return await ctx.inTx(async (txCtx) => {
            const digest = sidebarDigest("document", {
                baseVersion: input.baseVersion,
                html: input.html,
            });
            const replay = await this.#replaySidebarMutation(
                txCtx,
                ownerUserId,
                artifactId,
                input.mutationId,
                digest,
                "The mutation ID already belongs to different content.",
            );
            if (replay !== undefined)
                return await this.#readSidebar(txCtx, ownerUserId, artifactId, replay.version);
            const current = await this.#sidebarDocument(txCtx, artifactId);
            if (current.version !== input.baseVersion)
                throw new SidebarConflictError(current.version);
            const operations = await this.#liftRemoved(
                txCtx,
                ownerUserId,
                current.document,
                sidebarDiff(current.document, readSidebarDocument(input.html), {
                    widgets: false,
                }),
            );
            const version = await this.#commitPersonBatch(txCtx, ownerUserId, {
                artifactId,
                current,
                applied: applySpaceSidebarOperations(current.document, operations),
                mutationId: input.mutationId,
                digest,
            });
            return await this.#readSidebar(txCtx, ownerUserId, artifactId, version);
        });
    }

    /**
     * An ordinary artifact update of the sidebar. The person's is a whole-document write applied
     * at once, like the sidebar route's; Prioritizing's is turned into operations and queued for
     * the end of its turn. `html` is absent when only the title or background changes.
     */
    async writeSidebarArtifact(
        ctx: Context,
        artifactId: string,
        input: {
            readonly html: string | undefined;
            readonly author: ArtifactAuthor;
            readonly baseVersion: number;
            readonly operationId: string;
            readonly metadata: Pick<UpdateArtifactInput, "title" | "background">;
        },
    ): Promise<void> {
        const owner = await queryOwnerBySidebarArtifact(ctx, artifactId);
        if (owner === undefined)
            throw new SidebarValidationError("Sidebar artifacts are created by Spaces.");
        if (input.author.kind === "user") {
            if ((input.author.userId ?? SPACE_STANDALONE_OWNER) !== owner.ownerUserId)
                throw new SpaceNotFoundError();
            const current = await this.#sidebarDocument(ctx, artifactId);
            if (current.version !== input.baseVersion)
                throw new SidebarConflictError(current.version);
            const operations =
                input.html === undefined
                    ? []
                    : await this.#liftRemoved(
                          ctx,
                          owner.ownerUserId,
                          current.document,
                          sidebarDiff(current.document, readSidebarDocument(input.html), {
                              widgets: true,
                          }),
                      );
            await this.#commitPersonBatch(ctx, owner.ownerUserId, {
                artifactId,
                current,
                applied: applySpaceSidebarOperations(current.document, operations),
                operationId: input.operationId,
                metadata: input.metadata,
            });
            return;
        }
        if (input.author.agentId !== owner.prioritizingAgentId)
            throw new SidebarValidationError("Only Focus may edit this sidebar as an agent.");
        await this.#requirePrioritizingEnabled(ctx, owner.ownerUserId);
        const view = await this.#prioritizingView(ctx, owner);
        if (view.version !== input.baseVersion) throw new SidebarConflictError(view.version);
        const queued = await this.#queueSidebarProposal(
            ctx,
            owner,
            view,
            input.html === undefined ? view.document : readSidebarDocument(input.html),
            input.operationId,
            input.metadata,
        );
        if (queued.notes.length > 0) {
            const fresh = await this.#ownerState(ctx, owner.ownerUserId);
            await writeOwnerState(ctx, {
                ...fresh,
                sidebarBrief: [...new Set([...(fresh.sidebarBrief ?? []), ...queued.notes])].slice(
                    -32,
                ),
            });
        }
    }

    /** The first answer to a retried batch, or a conflict when the ID names another request. */
    async #replaySidebarMutation(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        artifactId: string,
        mutationId: string,
        digest: string,
        message = "The mutation ID already belongs to a different request.",
    ) {
        const mutation = await querySidebarMutation(ctx, ownerUserId, mutationId);
        if (mutation === undefined) return undefined;
        if (mutation.digest !== digest)
            throw new SidebarConflictError(
                (await this.#sidebarText(ctx, artifactId)).version,
                message,
            );
        const at = await this.#sidebarDocument(ctx, artifactId, mutation.version);
        return {
            artifactId,
            version: mutation.version,
            html: formatSpaceSidebar(at.document),
            operations: mutation.operations,
        };
    }

    /**
     * Commits the person's applied batch: the nodes it placed must be theirs to place, the
     * version records them as the author, Prioritizing hears what changed, and the seed ends.
     * Returns the version the batch left, unchanged when it changed nothing.
     */
    async #commitPersonBatch(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: {
            readonly artifactId: string;
            readonly current: { readonly version: number; readonly document: SpaceSidebarDocument };
            readonly applied: ReturnType<typeof applySpaceSidebarOperations>;
            /** The operations the person sent, when they sent operations. */
            readonly requested?: readonly SpaceSidebarOperation[];
            readonly mutationId?: string;
            readonly digest?: string;
            readonly operationId?: string;
            readonly metadata?: Pick<UpdateArtifactInput, "title" | "background">;
        },
    ): Promise<number> {
        const { current, applied } = input;
        await this.#checkSidebarIds(
            ctx,
            ownerUserId,
            applied.document,
            placedSidebarIds(applied.operations),
        );
        const metadata = input.metadata ?? {};
        let version = current.version;
        if (
            applied.operations.length > 0 ||
            metadata.title !== undefined ||
            metadata.background !== undefined
        )
            version = await this.#commitSidebarVersion(ctx, ownerUserId, {
                artifactId: input.artifactId,
                previousVersion: current.version,
                before: current.document,
                after: applied.document,
                operations: applied.operations,
                author: "person",
                operationId:
                    input.operationId ??
                    (input.mutationId === undefined
                        ? createId()
                        : `sidebar:${createHash("sha256").update(input.mutationId).digest("hex")}`),
                ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
                metadata,
            });
        const changed = [
            ...new Set([
                ...applied.operations.map(sidebarTarget),
                ...regroupedSidebarIds(current.document, applied.document),
            ]),
        ];
        const { sidebarSeed: _seed, ...state } = await this.#ownerState(ctx, ownerUserId);
        // A `set` that changes nothing still says what the person wants, such as keeping a row
        // open, so the aspects it names become theirs.
        await writeOwnerState(ctx, {
            ...state,
            sidebarAuthorship: affirmSidebarAuthorship(
                state.sidebarAuthorship ?? {},
                applied.document,
                input.requested ?? [],
            ),
        });
        if (changed.length > 0)
            await this.#queueSidebarBrief(
                ctx,
                ownerUserId,
                `The person changed sidebar placement or disclosure for: ${changed.join(", ")}.`,
                { wake: true },
            );
        if (input.mutationId !== undefined && input.digest !== undefined)
            await insertSidebarMutation(ctx, {
                ownerUserId,
                mutationId: input.mutationId,
                version,
                author: "person",
                digest: input.digest,
                operations: applied.operations,
                appliedAt: Date.now(),
            });
        return version;
    }

    /**
     * Writes one sidebar version in canonical form, records who set what, and announces the
     * operations that turn the previous version into it.
     */
    async #commitSidebarVersion(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: {
            readonly artifactId: string;
            readonly previousVersion: number;
            readonly before: SpaceSidebarDocument;
            readonly after: SpaceSidebarDocument;
            readonly operations: readonly SpaceSidebarOperation[];
            readonly author: SidebarAuthor | "daemon";
            readonly operationId: string;
            readonly mutationId?: string;
            readonly metadata?: Pick<UpdateArtifactInput, "title" | "background">;
        },
    ): Promise<number> {
        const state = await this.#ownerState(ctx, ownerUserId);
        const record = await this.#writeSidebar(
            ctx,
            input.artifactId,
            formatSpaceSidebar(input.after),
            input.previousVersion,
            input.operationId,
            input.author === "prioritizing" && state.prioritizingAgentId !== undefined
                ? { kind: "agent", agentId: state.prioritizingAgentId }
                : ownerAuthor(ownerUserId),
            input.metadata,
        );
        await writeOwnerState(ctx, {
            ...state,
            sidebarAuthorship: recordSidebarAuthorship(
                state.sidebarAuthorship ?? {},
                input.before,
                input.after,
                input.operations,
                input.author,
            ),
        });
        await this.#commitEvents(ctx, ownerUserId, input.mutationId, [
            {
                type: "sidebar_changed",
                artifactId: input.artifactId,
                previousVersion: input.previousVersion,
                version: record.latestVersion,
                author: input.author,
                operations: [...input.operations],
            },
        ]);
        return record.latestVersion;
    }

    async #writeSidebar(
        ctx: Context,
        artifactId: string,
        html: string,
        baseVersion: number,
        operationId: string,
        author: ArtifactAuthor,
        metadata: Pick<UpdateArtifactInput, "title" | "background"> = {},
    ) {
        const artifacts = this.#requireArtifacts();
        const upload = await artifacts.stageSidebarText(ctx, html);
        const source =
            author.kind === "agent"
                ? (await artifacts.actorFor(ctx, author.agentId)).source
                : undefined;
        return await artifacts.commitSidebar(ctx, {
            ...metadata,
            artifactId,
            baseVersion,
            operationId,
            files: [{ path: "index.html", uploadId: upload.id }],
            author,
            ...(source === undefined ? {} : { source }),
        });
    }

    /**
     * The document as Prioritizing sees it: the current version with its own queued proposals
     * drawn in, at the version its next edit names, one past the current version per proposal.
     */
    async #prioritizingView(ctx: Context, state: SpaceOwnerState): Promise<PrioritizingView> {
        if (state.sidebarArtifactId === undefined) throw new SpaceNotFoundError();
        const current = await this.#sidebarDocument(ctx, state.sidebarArtifactId);
        const pending = state.sidebarPending ?? [];
        return {
            artifactId: state.sidebarArtifactId,
            current,
            document: projectSidebar(current.document, pending),
            version: current.version + pending.length,
        };
    }

    /** What Prioritizing's operations are judged against, from the person's current state. */
    async #prioritizingRules(ctx: Context, state: SpaceOwnerState): Promise<PrioritizingRules> {
        const rows = await querySpaces(ctx, state.ownerUserId);
        const fresh = new Set<string>();
        for (const row of rows) {
            if (row.role === "focus") continue;
            // New pending work may still receive its first placement.
            const firstPlacement =
                row.placement === "pending" && state.sidebarPlacedIds?.includes(row.id) !== true;
            if (firstPlacement) fresh.add(row.id);
        }
        const authorship = state.sidebarAuthorship ?? {};
        return {
            fresh,
            // A change the person asked for in their own words needs no proposal.
            direct: state.applyRequestedAt === undefined,
            focusId: rows.find((row) => row.role === "focus")?.id,
            person: (id, aspect) => authorship[id]?.[aspect] === "person",
            rows: new Set(rows.map((row) => row.id)),
            manual: new Set(rows.filter((row) => row.manualAt !== undefined).map((row) => row.id)),
        };
    }

    /**
     * Turns Prioritizing's proposed document into operations against the document it read and
     * queues those the rules allow until its turn ends. Returns how many were queued and a note
     * for each one dropped.
     */
    async #queueSidebarProposal(
        ctx: Context,
        state: SpaceOwnerState,
        view: PrioritizingView,
        proposed: SpaceSidebarDocument,
        operationId: string,
        metadata: Pick<UpdateArtifactInput, "title" | "background">,
    ): Promise<{ queued: number; notes: string[] }> {
        const pending = state.sidebarPending ?? [];
        if (pending.some((proposal) => proposal.operationId === operationId))
            return { queued: 0, notes: [] };
        if (pending.length >= 32)
            throw new SpaceInputError("Apply the pending sidebar batch before adding more edits.");
        const rules = await this.#prioritizingRules(ctx, state);
        const operations = await this.#liftRemoved(
            ctx,
            state.ownerUserId,
            view.document,
            sidebarDiff(view.document, proposed, { widgets: true }),
        );
        // While the sidebar still mirrors the classic one, Prioritizing may only show its own
        // conversation under Happy and take out its own row.
        if (
            state.sidebarSeed === true &&
            !operations.every((operation) => {
                const target = sidebarTarget(operation);
                return target === rules.focusId || target === state.prioritizingAgentId;
            })
        )
            throw new SidebarValidationError(
                "The sidebar still mirrors the person's classic sidebar. Change nothing but your own conversation under Happy until your next notice.",
            );
        const reviewed = applyPrioritizingOperations(view.document, operations, rules, undefined);
        await this.#checkSidebarIds(
            ctx,
            state.ownerUserId,
            reviewed.document,
            placedSidebarIds(reviewed.operations),
        );
        if (
            reviewed.operations.length === 0 &&
            metadata.title === undefined &&
            metadata.background === undefined
        )
            return { queued: 0, notes: reviewed.notes };
        await writeOwnerState(ctx, {
            ...state,
            sidebarPending: [
                ...pending,
                {
                    operations: reviewed.operations,
                    baseVersion: view.current.version,
                    operationId,
                    ...metadata,
                },
            ],
        });
        return { queued: reviewed.operations.length, notes: reviewed.notes };
    }

    async prioritizingSidebar(ctx: Context, ownerUserId: SpaceOwnerId) {
        const current = await this.sidebar(ctx, ownerUserId);
        const state = await this.#ownerState(ctx, ownerUserId);
        const view = await this.#prioritizingView(ctx, state);
        const authorship = state.sidebarAuthorship ?? {};
        // Information for the prompt only; nothing refuses an edit because of it.
        const kept = keptAboveSeparator(
            view.current.document,
            (id) =>
                authorship[id]?.place === "person" ||
                current.spaces.some((space) => space.id === id && space.manualAt !== undefined),
        );
        const now = Date.now();
        const age = (at: number | undefined) =>
            at === undefined ? undefined : `${formatConversationAge(now - at)} ago`;
        const spaces = [];
        const sessions: {
            id: string;
            parentId: string;
            title: string | undefined;
            working: boolean;
            lastActive: string | undefined;
            icon: string | undefined;
        }[] = [];
        // Voice is Happy's subtask but never work under Happy's row.
        const voices = new Set(
            current.spaces.flatMap((space) =>
                space.role === "voice" && space.contents[0]?.kind === "agent"
                    ? [space.contents[0].agentId]
                    : [],
            ),
        );
        const visit = async (parentId: string, depth: number): Promise<void> => {
            if (depth > 3) return;
            for (const id of await this.#requireAgents().childOf(ctx, parentId)) {
                if (sessions.length >= 200 || id === state.prioritizingAgentId || voices.has(id))
                    continue;
                const metadata = (await this.#requireAgents().config(ctx, id))?.metadata;
                if (typeof metadata?.["archivedAt"] === "number") continue;
                sessions.push({
                    id,
                    parentId,
                    title: typeof metadata?.["title"] === "string" ? metadata["title"] : undefined,
                    working: this.#events.activeRunId(id) !== undefined,
                    lastActive: age(
                        await this.#history.latestUserOrFinalAssistantTextMessageAt(ctx, id),
                    ),
                    icon: state.agentIcons?.[id],
                });
                await visit(id, depth + 1);
            }
        };
        for (const space of current.spaces) {
            const description = await this.describe(ctx, space);
            const placedByPerson =
                space.manualAt !== undefined || authorship[space.id]?.place === "person";
            spaces.push({
                id: space.id,
                kind:
                    space.role === "happy"
                        ? "happy"
                        : space.role === "focus"
                          ? "your own row"
                          : space.role === "voice"
                            ? "Voice's row"
                            : (description.target?.kind ?? "empty"),
                title: description.named ? description.title : undefined,
                ...(space.contents[0] === undefined || space.contents[0].kind === "surface"
                    ? {}
                    : { agentId: space.contents[0].agentId }),
                icon: space.icon?.type === "library" ? space.icon.slug : space.icon?.type,
                working: description.working,
                lastActive: age(description.lastActivityAt),
                ...(isUntouchedStemCell(space)
                    ? { newWork: "waiting for the person's first message; leave it alone" }
                    : space.placement === "pending" &&
                        !placedByPerson &&
                        state.sidebarPlacedIds?.includes(space.id) !== true
                      ? { newWork: "not placed yet" }
                      : {}),
                ...(placedByPerson ? { placedByPerson: true } : {}),
                ...(kept.has(space.id) ? { keepInPlace: true } : {}),
                // Nothing to read with read_conversations.
                ...(space.contents[0]?.kind === "surface" ? { noConversation: true } : {}),
            });
            const content = space.contents[0];
            if (content !== undefined && content.kind !== "surface" && !isUntouchedStemCell(space))
                await visit(content.agentId, 1);
        }
        // Happy and new work waiting for its first message sit outside the budget.
        const exempt = new Set(
            current.spaces
                .filter(
                    (space) =>
                        space.role === "happy" ||
                        space.role === "focus" ||
                        space.role === "voice" ||
                        isUntouchedStemCell(space),
                )
                .map((space) => space.id),
        );
        return {
            artifactId: current.artifactId,
            version: view.version,
            html: formatSpaceSidebar(view.document),
            spaces,
            sessions,
            visibleRows: {
                shown: shownSidebarRows(view.document).filter((id) => !exempt.has(id)).length,
                budget: SIDEBAR_VISIBLE_BUDGET,
            },
            manualIds: Object.entries(authorship)
                .filter(([, aspects]) => Object.values(aspects).includes("person"))
                .map(([id]) => id),
            proposal: await this.#openProposalView(ctx, state),
            decidedProposals: (state.sidebarProposals ?? [])
                .filter((proposal) => proposal.status !== "open")
                .slice(-3)
                .map((proposal) => ({
                    artifactId: proposal.artifactId,
                    status: proposal.status,
                    decided: age(proposal.decidedAt),
                    ...(proposal.archived === undefined || proposal.archived.length === 0
                        ? {}
                        : { archived: proposal.archived }),
                })),
        };
    }

    /** The open proposal as Prioritizing revises it, or `null`. */
    async #openProposalView(ctx: Context, state: SpaceOwnerState) {
        const open = state.sidebarProposals?.find((proposal) => proposal.status === "open");
        if (open === undefined) return null;
        const latest = await this.#sidebarDocument(ctx, open.artifactId);
        return {
            artifactId: open.artifactId,
            version: latest.version,
            html: formatSpaceSidebar(latest.document),
            opened: `${formatConversationAge(Date.now() - open.createdAt)} ago`,
            ...(open.newRows === undefined || open.newRows.length === 0
                ? {}
                : { newRows: open.newRows }),
            personSet: Object.entries(open.authorship ?? {})
                .filter(([, aspects]) => Object.values(aspects).includes("person"))
                .map(([id]) => id),
        };
    }

    /**
     * Several conversations at once, each a row's (by space ID) or a session's under one of the
     * person's rows (by agent ID): its latest turns, each the person's or another agent's message
     * with the agent's last replies to it. Tool calls, their output, reasoning, and hidden
     * messages are left out, and the answer is bounded so reading many rows stays cheap. The
     * `machine` scope, Voice's, also reads any other conversation on a standalone machine; with a
     * team, "this machine" holds other members' conversations, so it stays the person's own.
     */
    async readConversations(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: {
            readonly ids: readonly string[];
            readonly turns: number;
            readonly replies: number;
            readonly scope?: "rows" | "machine";
        },
    ): Promise<string> {
        const reads = [];
        for (const id of input.ids)
            reads.push({ id, text: await this.#readConversation(ctx, ownerUserId, id, input) });
        return formatConversationReads(reads, CONVERSATIONS_TEXT_LIMIT);
    }

    /** Voice's fixed sidebar tools: read-only, with rearrangement asked of Prioritizing. */
    voiceSidebarTools(ownerUserId: SpaceOwnerId, agentId: string): AnyAgentTool[] {
        return voiceSidebarTools(this, ownerUserId, agentId);
    }

    /**
     * The person's sidebar as names, in its order: the document's rows under their sections and
     * the sessions it shows under a row, or the classic list for a person without Stem Cells.
     */
    async sidebarOutline(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceSidebarOutline> {
        if (this.#artifacts === undefined || !(await this.#stemCellsEnabled(ctx, ownerUserId))) {
            return await ctx.inTx(async (txCtx) => {
                await this.#ensureOwner(txCtx, ownerUserId);
                const classic = await this.#classicSidebar(txCtx, ownerUserId);
                const rows = [];
                for (const id of [
                    ...(classic.happy === undefined ? [] : [classic.happy]),
                    ...classic.bots,
                    ...classic.tasks,
                    ...classic.surfaces,
                ])
                    rows.push(await this.#outlineRow(txCtx, ownerUserId, id, false, []));
                return { groups: [{ label: undefined, folded: false, rows }] };
            });
        }
        const current = await this.sidebar(ctx, ownerUserId);
        const { document } = await this.#sidebarDocument(ctx, current.artifactId);
        const groups: SpaceSidebarOutlineGroup[] = [];
        let group = {
            label: undefined as string | undefined,
            folded: false,
            rows: [] as SpaceSidebarOutlineRow[],
        };
        const close = () => {
            if (group.label !== undefined || group.rows.length > 0) groups.push(group);
        };
        for (const item of document.items) {
            if (item.type === "section" || item.type === "separator") {
                close();
                group =
                    item.type === "section"
                        ? { label: item.label, folded: item.collapsed, rows: [] }
                        : { label: undefined, folded: false, rows: [] };
            } else if (item.type === "space") {
                group.rows.push(
                    await this.#outlineRow(ctx, ownerUserId, item.id, item.expanded, item.children),
                );
            }
        }
        close();
        return { groups };
    }

    async #outlineRow(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        id: string,
        expanded: boolean,
        children: readonly SpaceSidebarSpaceNode[],
    ): Promise<SpaceSidebarOutlineRow> {
        const row = await querySpace(ctx, id);
        let name: string;
        let agentId: string | undefined;
        if (row !== undefined && row.ownerUserId === ownerUserId) {
            const description = await this.describe(ctx, row);
            name = description.named ? description.title : "New chat";
            const content = row.contents[0];
            agentId =
                content === undefined || content.kind === "surface" ? undefined : content.agentId;
        } else {
            const title = (await this.#requireAgents().config(ctx, id))?.metadata?.["title"];
            name = typeof title === "string" ? title : "Untitled conversation";
            agentId = id;
        }
        const shown = [];
        if (expanded)
            for (const child of children)
                shown.push(
                    await this.#outlineRow(
                        ctx,
                        ownerUserId,
                        child.id,
                        child.expanded,
                        child.children,
                    ),
                );
        return {
            name,
            agentId,
            children: shown,
            foldedChildren: expanded ? 0 : children.length,
        };
    }

    /**
     * Voice's own row, made with Voice and never work. With Stem Cells it is inserted into the
     * document once, by the daemon, below Happy, or below Prioritizing's row when that follows
     * Happy; once the person removed it, it is never put back. A row of an earlier Voice gives
     * way to the new one.
     */
    async ensureVoiceRow(ctx: Context, ownerUserId: SpaceOwnerId, agentId: string): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            const voices = (await querySpaces(txCtx, ownerUserId)).filter(
                (row) => row.role === "voice",
            );
            if (
                voices.some(
                    (row) =>
                        row.contents[0]?.kind === "agent" && row.contents[0].agentId === agentId,
                )
            )
                return;
            for (const row of voices) await this.#removeVoiceRow(txCtx, ownerUserId, row.id);
            const now = Date.now();
            const space: SpaceRecord = {
                id: createId(),
                ownerUserId,
                role: "voice",
                icon: { type: "library", slug: VOICE_ICON },
                contents: [{ kind: "agent", agentId }],
                orderKey: "3",
                placement: "settled",
                visibility: "shown",
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            if (!(await insertSpaceIfAbsent(txCtx, space))) return;
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                { type: "space_created", space },
            ]);
            if (
                this.#artifacts === undefined ||
                !(await this.#stemCellsEnabled(txCtx, ownerUserId))
            )
                return;
            const artifactId = await this.#ensureSidebar(txCtx, ownerUserId);
            await this.#migrateSidebar(txCtx, ownerUserId, artifactId);
            const current = await this.#sidebarDocument(txCtx, artifactId);
            const rows = await querySpaces(txCtx, ownerUserId);
            const happyId = rows.find((row) => row.role === "happy")?.id;
            const focusId = rows.find((row) => row.role === "focus")?.id;
            const happyAt = current.document.items.findIndex(
                (item) => item.type === "space" && item.id === happyId,
            );
            const next = happyAt < 0 ? undefined : current.document.items[happyAt + 1];
            const applied = applySpaceSidebarOperations(current.document, [
                {
                    type: "insert",
                    node: { type: "space", id: space.id },
                    to:
                        next?.type === "space" && next.id === focusId
                            ? { after: focusId }
                            : newSpacePosition(
                                  current.document,
                                  happyId === undefined ? {} : { happyId },
                              ),
                },
            ]);
            if (applied.operations.length === 0) return;
            await this.#commitSidebarVersion(txCtx, ownerUserId, {
                artifactId,
                previousVersion: current.version,
                before: current.document,
                after: applied.document,
                operations: applied.operations,
                author: "daemon",
                operationId: createId(),
            });
        });
    }

    /**
     * Happy's onboarding starts the person's Prioritizing, as Focus, and shows it at once: its own
     * row right after Happy's, as the daemon's one change. With a task, that task is Happy's first message to it, or
     * Happy's next message when it already runs. Answers with its agent ID and the model it was
     * made on, or `undefined` when the person has not turned Stem Cells on, or it cannot run.
     */
    async startFocus(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        task?: string,
    ): Promise<
        | {
              readonly agentId: string;
              readonly model?: {
                  readonly modelId: string;
                  readonly providerId: string;
                  readonly name: string;
              };
          }
        | undefined
    > {
        return await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            if (!(await this.#stemCellsEnabled(txCtx, ownerUserId))) return undefined;
            const running = await this.#livePrioritizing(txCtx, ownerUserId);
            if (running === undefined)
                await this.#ensurePrioritizing(
                    txCtx,
                    ownerUserId,
                    task ?? PRIORITIZING_ONBOARDING_OPENING,
                );
            const agentId = await this.#livePrioritizing(txCtx, ownerUserId);
            if (agentId === undefined) return undefined;
            if (task !== undefined)
                await writeOwnerState(txCtx, {
                    ...(await this.#ownerState(txCtx, ownerUserId)),
                    happyAsked: true,
                });
            const happyAgentId = await this.#happyAgentId(txCtx, ownerUserId);
            if (running !== undefined && task !== undefined && happyAgentId !== undefined)
                await this.#collaboration?.sendMessage(
                    txCtx,
                    happyAgentId,
                    { toAgentId: agentId, explanation: "Focus's task", text: task },
                    createId(),
                );
            await this.#showFocus(txCtx, ownerUserId, agentId);
            const route = await this.#prioritizingRoute(txCtx, ownerUserId);
            const model =
                route === undefined
                    ? undefined
                    : this.#config.models.find(
                          (candidate) =>
                              candidate.providerId === route.providerId &&
                              candidate.id === route.model,
                      );
            return {
                agentId,
                ...(model === undefined
                    ? {}
                    : {
                          model: {
                              modelId: model.id,
                              providerId: model.providerId,
                              name: model.name,
                          },
                      }),
            };
        });
    }

    /**
     * Focus's own row, with its target icon, placed in the header right after Happy's row where its
     * prompt keeps it, as the daemon's one change. A row already in the document stays put.
     */
    async #showFocus(ctx: Context, ownerUserId: SpaceOwnerId, agentId: string): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            if (this.#artifacts === undefined) return;
            await this.#setSessionIcon(txCtx, ownerUserId, agentId, FOCUS_ICON).catch(
                () => undefined,
            );
            const focusId = (await querySpaceByRef(txCtx, ownerUserId, "focus"))?.id;
            const happyId = (await querySpaceByRef(txCtx, ownerUserId, "happy"))?.id;
            if (focusId === undefined || happyId === undefined) return;
            const artifactId = await this.#ensureSidebar(txCtx, ownerUserId);
            await this.#migrateSidebar(txCtx, ownerUserId, artifactId);
            const current = await this.#sidebarDocument(txCtx, artifactId);
            if (
                locateSpaceSidebarNode(current.document, focusId) !== undefined ||
                locateSpaceSidebarNode(current.document, happyId) === undefined
            )
                return;
            const applied = applySpaceSidebarOperations(current.document, [
                { type: "insert", node: { type: "space", id: focusId }, to: { after: happyId } },
            ]);
            await this.#commitSidebarVersion(txCtx, ownerUserId, {
                artifactId,
                previousVersion: current.version,
                before: current.document,
                after: applied.document,
                operations: applied.operations,
                author: "daemon",
                operationId: createId(),
            });
        });
    }

    /**
     * The person pressed Discover in onboarding: Prioritizing may now read, with discover_work,
     * the places Happy disclosed for this assistant, and nothing else.
     */
    async allowDiscovery(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        assistant: SpaceDiscoveryAssistant,
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            await writeOwnerState(txCtx, {
                ...(await this.#ownerState(txCtx, ownerUserId)),
                discovery: { assistant },
            });
        });
    }

    /** Prioritizing's discover_work: the disclosed places, read-only, once the person agreed. */
    async discover(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string> {
        const discovery = (await this.#ownerState(ctx, ownerUserId)).discovery;
        if (discovery === undefined)
            return "Nothing was read: the person has not agreed to let you read their work.";
        const home = this.#config.processEnvironment["HOME"]?.trim() || homedir();
        return (
            (await discoverWork(home, discovery.assistant)) ??
            `Found nothing: no ${discovery.assistant === "codex" ? "Codex" : "Claude Code"} session named a project.`
        );
    }

    /**
     * Prioritizing answers Happy as its sub-agent: a turn that received Happy's message ends with
     * one message to Happy naming the open proposal, if any, and what Prioritizing said.
     */
    async #reportToHappy(ctx: Context, ownerUserId: SpaceOwnerId, agentId: string): Promise<void> {
        const collaboration = this.#collaboration;
        await ctx.inTx(async (txCtx) => {
            const state = await this.#ownerState(txCtx, ownerUserId);
            if (state.happyAsked !== true) return;
            const { happyAsked: _asked, ...rest } = state;
            await writeOwnerState(txCtx, rest);
            const happyAgentId = await this.#happyAgentId(txCtx, ownerUserId);
            if (collaboration === undefined || happyAgentId === undefined) return;
            const open = state.sidebarProposals?.find((proposal) => proposal.status === "open");
            // Only Focus's words: its own Good to go stays in its chat, so Happy's shows one.
            const said = (await this.#lastAgentText(txCtx, agentId))
                ?.replace(/<menu\b[\s\S]*?<\/menu>/gu, "")
                .trim();
            await collaboration.sendMessage(
                txCtx,
                agentId,
                {
                    toAgentId: happyAgentId,
                    explanation: open === undefined ? "Focus finished" : "Focus's proposal",
                    text: [
                        open === undefined
                            ? "Focus finished without a proposal."
                            : `Focus finished. Its open proposal is ${open.artifactId}.`,
                        ...(said ? [`Focus said: ${said.slice(0, 2_000)}`] : []),
                    ].join("\n\n"),
                },
                createId(),
            );
        });
    }

    async #removeVoiceRow(ctx: Context, ownerUserId: SpaceOwnerId, spaceId: string): Promise<void> {
        await deleteSpace(ctx, spaceId);
        await this.#commitEvents(ctx, ownerUserId, undefined, [{ type: "space_removed", spaceId }]);
    }

    /** Whether an agent is a live conversation on this machine rather than archived or unknown. */
    async #localConversation(ctx: Context, agentId: string): Promise<boolean> {
        const config = await this.#requireAgents().config(ctx, agentId);
        return config !== undefined && typeof config.metadata?.["archivedAt"] !== "number";
    }

    async #readConversation(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        id: string,
        input: {
            readonly turns: number;
            readonly replies: number;
            readonly scope?: "rows" | "machine";
        },
    ): Promise<string> {
        const now = Date.now();
        let agentId = id;
        let heading: string;
        const row = await querySpace(ctx, id);
        if (row !== undefined && row.ownerUserId === ownerUserId) {
            const content = row.contents[0];
            if (content === undefined) return `Row ${id} has no conversation.`;
            const description = await this.describe(ctx, row);
            const title = description.named ? `"${description.title}"` : "a new chat";
            if (content.kind === "surface")
                return `Row ${id} (${title}) is a shared Surface; it has no conversation of its own.`;
            agentId = content.agentId;
            heading = `Row ${id} (${title})${description.working ? ", running now" : ""}${description.lastActivityAt === undefined ? "" : `, last active ${formatConversationAge(now - description.lastActivityAt)} ago`}:`;
        } else if (
            row === undefined &&
            (await this.#sessionOwners(ctx, id)).includes(ownerUserId)
        ) {
            const title = (await this.#requireAgents().config(ctx, id))?.metadata?.["title"];
            heading = `Session ${id}${typeof title === "string" ? ` ("${title}")` : ""}${this.#events.activeRunId(id) === undefined ? "" : ", running now"}:`;
        } else if (
            row === undefined &&
            input.scope === "machine" &&
            !this.#team.enabled &&
            (await this.#localConversation(ctx, id))
        ) {
            const title = (await this.#requireAgents().config(ctx, id))?.metadata?.["title"];
            heading = `Conversation ${id}${typeof title === "string" ? ` ("${title}")` : ""}${this.#events.activeRunId(id) === undefined ? "" : ", running now"}:`;
        } else {
            return input.scope === "machine"
                ? `${id} is not a conversation the person can see on this machine.`
                : `${id} is not one of the person's rows or sessions.`;
        }
        const page = await this.#history.read(ctx, agentId, {
            from: "end",
            roles: ["user", "assistant", "agent"],
            limit: Math.min(input.turns * 24, 500),
        });
        const lines = page.messages.flatMap(({ message }) => {
            if (message.hideFromUser === true) return [];
            const text = message.blocks
                .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
                .filter((part) => part.length > 0)
                .join("\n\n");
            if (text.length === 0) return [];
            const role =
                message.role === "user" ? "user" : message.role === "agent" ? "agent" : "assistant";
            return [{ role, text, at: message.at } as const];
        });
        return `${heading}\n${formatConversationTurns(lines, {
            turns: input.turns,
            replies: input.replies,
            now,
            messageLimit: CONVERSATION_MESSAGE_LIMIT,
            limit: CONVERSATION_TEXT_LIMIT,
        })}`;
    }

    /**
     * Prioritizing's exact-text edits of the document it reads. A stale base still applies when
     * every old text occurs exactly once in the current document.
     */
    async editSidebar(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: { baseVersion: number; edits: readonly { oldText: string; newText: string }[] },
        operationId: string,
    ): Promise<string> {
        const { artifactId } = await this.sidebar(ctx, ownerUserId);
        return await ctx.inTx(async (txCtx) => {
            const state = await this.#ownerState(txCtx, ownerUserId);
            if (
                state.sidebarPending?.some((proposal) => proposal.operationId === operationId) ||
                (await this.#requireArtifacts().versionForOperation(
                    txCtx,
                    artifactId,
                    operationId,
                )) !== undefined
            )
                return "This edit was already accepted.";
            await this.#requirePrioritizingEnabled(txCtx, ownerUserId);
            const view = await this.#prioritizingView(txCtx, state);
            const read = formatSpaceSidebar(view.document);
            let html = read;
            for (const edit of input.edits) {
                const at = html.indexOf(edit.oldText);
                if (
                    edit.oldText.length === 0 ||
                    at < 0 ||
                    html.indexOf(edit.oldText, at + 1) !== -1
                ) {
                    if (view.version !== input.baseVersion)
                        throw new SidebarConflictError(view.version);
                    throw new SidebarValidationError("Each oldText must occur exactly once.");
                }
                html = html.slice(0, at) + edit.newText + html.slice(at + edit.oldText.length);
            }
            if (html === read) return "Nothing changed; no version was queued.";
            const queued = await this.#queueSidebarProposal(
                txCtx,
                state,
                view,
                readSidebarDocument(html),
                operationId,
                {},
            );
            const dropped =
                queued.notes.length === 0
                    ? ""
                    : `\n\n${queued.notes.join("\n")}\nRead the sidebar again before your next edit.`;
            if (queued.queued === 0) {
                if (queued.notes.length === 0) return "Nothing changed; no version was queued.";
                throw new SidebarValidationError(`Nothing was queued.${dropped}`);
            }
            return `Sidebar version ${String(view.version + 1)} queued; it applies when this turn ends.${dropped}`;
        });
    }

    /**
     * Prioritizing's proposal: the first version of a new one drafted from the sidebar it reads, or
     * the next version of the open one. Its edits are exact-text replacements, as in edit_sidebar.
     * What the person set in the proposal, age labels, and offers to archive work that may not be
     * archived are dropped with a note.
     */
    async proposeSidebar(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: {
            baseVersion: number;
            edits: readonly { oldText: string; newText: string }[];
            newRows?: readonly ProposedNewRow[];
        },
        operationId: string,
    ): Promise<{ readonly text: string; readonly artifact?: ArtifactRecord }> {
        await this.sidebar(ctx, ownerUserId);
        return await ctx.inTx(async (txCtx) => {
            await this.#requirePrioritizingEnabled(txCtx, ownerUserId);
            const artifacts = this.#requireArtifacts();
            const state = await this.#ownerState(txCtx, ownerUserId);
            const agentId = state.prioritizingAgentId;
            if (agentId === undefined) throw new SpaceNotFoundError();
            // A repeated call answers with the version it made.
            for (const record of state.sidebarProposals ?? [])
                if (
                    (await artifacts.versionForOperation(txCtx, record.artifactId, operationId)) !==
                    undefined
                ) {
                    const artifact = await artifacts.get(txCtx, record.artifactId);
                    return {
                        text: "This proposal version was already made.",
                        ...(artifact === undefined ? {} : { artifact }),
                    };
                }
            const open = state.sidebarProposals?.find((proposal) => proposal.status === "open");
            let base: { version: number; document: SpaceSidebarDocument };
            let sidebarVersion: number;
            if (open === undefined) {
                const view = await this.#prioritizingView(txCtx, state);
                if (view.version !== input.baseVersion)
                    throw new SidebarConflictError(view.version);
                base = { version: view.version, document: view.document };
                sidebarVersion = view.current.version;
            } else {
                base = await this.#sidebarDocument(txCtx, open.artifactId);
                if (base.version !== input.baseVersion)
                    throw new SidebarConflictError(
                        base.version,
                        "The proposal changed. Read it again with list_sidebar.",
                    );
                sidebarVersion = open.baseVersion;
            }
            const read = formatSpaceSidebar(base.document);
            // New rows are named by Prioritizing and reserved here: each name becomes a space ID
            // that exists once the proposal is accepted.
            const newRows = reserveNewRows(open?.newRows ?? [], input.newRows ?? []);
            const html = applyExactEdits(
                read,
                input.edits.map((edit) => ({
                    oldText: edit.oldText,
                    newText: newRows.rename(edit.newText),
                })),
            );
            if (html === read && !newRows.changed)
                return { text: "Nothing changed; no proposal version was made." };
            const rows = new Map(
                (await querySpaces(txCtx, ownerUserId)).map((row) => [row.id, row]),
            );
            const authorship = open?.authorship ?? {};
            const reviewed = reviewProposalOperations(
                base.document,
                sidebarDiff(base.document, readSidebarDocument(html), { widgets: true }),
                {
                    person: (id, aspect) => authorship[id]?.[aspect] === "person",
                    // Accepting archives a task; nothing else is archived that way.
                    mayNotArchive: (id) => {
                        const row = rows.get(id);
                        return row?.role !== "item" || row.contents[0]?.kind !== "task"
                            ? `${id} is not a task's row; only tasks are offered for archiving.`
                            : undefined;
                    },
                },
            );
            const notes = reviewed.notes.length === 0 ? "" : `\n\n${reviewed.notes.join("\n")}`;
            if (reviewed.operations.length === 0 && !newRows.changed) {
                if (reviewed.notes.length === 0)
                    return { text: "Nothing changed; no proposal version was made." };
                throw new SidebarValidationError(`Nothing was proposed.${notes}`);
            }
            await this.#checkProposal(
                txCtx,
                ownerUserId,
                reviewed.document,
                placedSidebarIds(reviewed.operations),
                new Set(newRows.rows.map((row) => row.id)),
            );
            const actor = await artifacts.actorFor(txCtx, agentId);
            let record = open;
            if (record === undefined) {
                record = {
                    artifactId: createId(),
                    baseVersion: sidebarVersion,
                    status: "open",
                    createdAt: Date.now(),
                    ...(newRows.rows.length === 0 ? {} : { newRows: newRows.rows }),
                };
                await this.#writeProposals(txCtx, ownerUserId, record);
                await artifacts.create(txCtx, {
                    id: record.artifactId,
                    type: "sidebar_proposal",
                    title: "Sidebar proposal",
                    display: "inline_expanded",
                    files: [
                        {
                            path: "index.html",
                            uploadId: (await artifacts.stageSidebarText(txCtx, read)).id,
                        },
                    ],
                    author: actor.author,
                    source: actor.source,
                });
                base = { version: 1, document: base.document };
            } else if (newRows.changed) {
                record = { ...record, newRows: newRows.rows };
                await this.#writeProposals(txCtx, ownerUserId, record);
            }
            const artifact = await artifacts.commitSidebar(txCtx, {
                artifactId: record.artifactId,
                baseVersion: base.version,
                operationId,
                files: [
                    {
                        path: "index.html",
                        uploadId: (
                            await artifacts.stageSidebarText(
                                txCtx,
                                formatSpaceSidebar(reviewed.document),
                            )
                        ).id,
                    },
                ],
                author: actor.author,
                source: actor.source,
            });
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                {
                    type: "proposal_changed",
                    proposal: await this.#proposalResource(txCtx, record),
                    previousVersion: base.version,
                    author: "prioritizing",
                    operations: reviewed.operations,
                },
            ]);
            const reserved =
                newRows.reserved.length === 0
                    ? ""
                    : `\n\nNew rows, by the space ID each now has: ${newRows.reserved.map((row) => `${row.name} is ${row.id}`).join(", ")}.`;
            return {
                text: `Proposal ${record.artifactId} is at version ${String(artifact.latestVersion)}. The person sees it as a card in your conversation; offer Good to go in your reply, and do not repeat the card or its tag.${reserved}${notes}`,
                artifact,
            };
        });
    }

    /** A proposal of the person's and its latest document. */
    async sidebarProposal(ctx: Context, ownerUserId: SpaceOwnerId, artifactId: string) {
        return await ctx.inTx(async (txCtx) => {
            const record = await this.#ownedProposal(txCtx, ownerUserId, artifactId);
            const latest = await this.#sidebarDocument(txCtx, artifactId);
            return {
                proposal: await this.#proposalResource(txCtx, record),
                html: formatSpaceSidebar(latest.document),
            };
        });
    }

    /**
     * The person's edit of an open proposal, rebased like a sidebar batch. What they set is
     * recorded on the proposal, so Prioritizing's revisions keep it.
     */
    async applyProposalOperations(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        artifactId: string,
        input: {
            readonly mutationId: string;
            readonly baseVersion: number;
            readonly operations: readonly SpaceSidebarOperation[];
        },
    ) {
        return await ctx.inTx(async (txCtx) => {
            const record = await this.#ownedProposal(txCtx, ownerUserId, artifactId);
            const digest = sidebarDigest("proposal", {
                artifactId,
                baseVersion: input.baseVersion,
                operations: input.operations,
            });
            const replay = await querySidebarMutation(txCtx, ownerUserId, input.mutationId);
            if (replay !== undefined) {
                if (replay.digest !== digest)
                    throw new SidebarConflictError(
                        replay.version,
                        "The mutation ID already belongs to a different request.",
                    );
                const at = await this.#sidebarDocument(txCtx, artifactId, replay.version);
                return {
                    artifactId,
                    version: replay.version,
                    html: formatSpaceSidebar(at.document),
                    operations: replay.operations,
                };
            }
            if (record.status !== "open")
                throw new SpaceConflictError("This proposal was already decided.");
            const current = await this.#sidebarDocument(txCtx, artifactId);
            if (input.baseVersion > current.version)
                throw new SidebarConflictError(
                    current.version,
                    `The proposal is at version ${String(current.version)}, before ${String(input.baseVersion)}.`,
                );
            const base =
                input.baseVersion === current.version
                    ? current.document
                    : (await this.#sidebarDocument(txCtx, artifactId, input.baseVersion)).document;
            try {
                applySpaceSidebarOperations(base, input.operations);
            } catch (error: unknown) {
                if (error instanceof SpaceSidebarOperationError)
                    throw new SidebarValidationError(error.message, 0, error.operationIndex);
                throw error;
            }
            let applied: ReturnType<typeof applySpaceSidebarOperations>;
            try {
                applied = applySpaceSidebarOperations(current.document, input.operations, { base });
            } catch (error: unknown) {
                if (error instanceof SpaceSidebarOperationError)
                    throw new SidebarConflictError(
                        current.version,
                        error.message,
                        error.operationIndex,
                    );
                throw error;
            }
            await this.#checkProposal(
                txCtx,
                ownerUserId,
                applied.document,
                placedSidebarIds(applied.operations),
                new Set((record.newRows ?? []).map((row) => row.id)),
            );
            let version = current.version;
            if (applied.operations.length > 0) {
                const artifacts = this.#requireArtifacts();
                version = (
                    await artifacts.commitSidebar(txCtx, {
                        artifactId,
                        baseVersion: current.version,
                        operationId: `proposal:${createHash("sha256").update(input.mutationId).digest("hex")}`,
                        files: [
                            {
                                path: "index.html",
                                uploadId: (
                                    await artifacts.stageSidebarText(
                                        txCtx,
                                        formatSpaceSidebar(applied.document),
                                    )
                                ).id,
                            },
                        ],
                        author: ownerAuthor(ownerUserId),
                    })
                ).latestVersion;
                const next: SidebarProposalRecord = {
                    ...record,
                    authorship: recordSidebarAuthorship(
                        record.authorship ?? {},
                        current.document,
                        applied.document,
                        applied.operations,
                        "person",
                    ),
                };
                await this.#writeProposals(txCtx, ownerUserId, next);
                await this.#queueSidebarBrief(
                    txCtx,
                    ownerUserId,
                    `The person edited your proposal ${artifactId}. Keep their edits if you revise it.`,
                    { replaces: `The person edited your proposal ${artifactId}`, wake: true },
                );
                await this.#commitEvents(txCtx, ownerUserId, input.mutationId, [
                    {
                        type: "proposal_changed",
                        proposal: await this.#proposalResource(txCtx, next),
                        previousVersion: current.version,
                        author: "person",
                        operations: applied.operations,
                    },
                ]);
            }
            await insertSidebarMutation(txCtx, {
                ownerUserId,
                mutationId: input.mutationId,
                version,
                author: "person",
                digest,
                operations: applied.operations,
                appliedAt: Date.now(),
            });
            return {
                artifactId,
                version,
                html: formatSpaceSidebar(applied.document),
                operations: applied.operations,
            };
        });
    }

    /**
     * The person accepted a proposal: the difference between its first and latest version applies
     * to the sidebar as their batch, rebased from the first, skipping what no longer applies; the
     * tasks in its Archive block that the person may archive are archived.
     */
    async acceptProposal(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        artifactId: string,
        mutationId: string,
    ) {
        const { artifactId: sidebarId } = await this.sidebar(ctx, ownerUserId);
        return await ctx.inTx(async (txCtx) => {
            const record = await this.#ownedProposal(txCtx, ownerUserId, artifactId);
            const digest = sidebarDigest("accept", { artifactId });
            const replay = await querySidebarMutation(txCtx, ownerUserId, mutationId);
            if (replay !== undefined) {
                if (replay.digest !== digest || record.decisionMutationId !== mutationId)
                    throw new SidebarConflictError(
                        replay.version,
                        "The mutation ID already belongs to a different request.",
                    );
                const at = await this.#sidebarDocument(txCtx, sidebarId, replay.version);
                return {
                    proposal: await this.#proposalResource(txCtx, record),
                    sidebar: {
                        artifactId: sidebarId,
                        version: replay.version,
                        html: formatSpaceSidebar(at.document),
                        operations: replay.operations,
                    },
                    archived: record.archived ?? [],
                    started: record.started ?? [],
                };
            }
            if (record.status !== "open")
                throw new SpaceConflictError("This proposal was already decided.");
            const first = await this.#sidebarDocument(txCtx, artifactId, 1);
            const latest = await this.#sidebarDocument(txCtx, artifactId);
            const rows = new Map(
                (await querySpaces(txCtx, ownerUserId)).map((row) => [row.id, row]),
            );
            const archiving: { spaceId: string; task: TaskRecord }[] = [];
            const offered = new Set(archiveOffers(latest.document));
            for (const id of offered) {
                const content = rows.get(id)?.contents[0];
                const task =
                    content?.kind === "task"
                        ? await this.#tasks.get(txCtx, content.taskId)
                        : undefined;
                if (task?.status === "active" && (await this.#mayArchive(txCtx, ownerUserId, task)))
                    archiving.push({ spaceId: id, task });
            }
            const archived = new Set(archiving.map(({ spaceId }) => spaceId));
            // The new rows still in the proposal become chats first, so each is moved into the
            // place the proposal gives it, as the person's batch, like any other row.
            const started = await this.#startNewRows(
                txCtx,
                ownerUserId,
                (record.newRows ?? []).filter(
                    (row) => locateSpaceSidebarNode(latest.document, row.id) !== undefined,
                ),
            );
            const created = new Set(started.map(({ spaceId }) => spaceId));
            // A row that cannot be archived stays wherever it is in the sidebar.
            const operations = sidebarDiff(
                first.document,
                withoutArchive(latest.document, offered),
                {
                    widgets: true,
                },
            ).filter(
                (operation) =>
                    operation.type !== "remove" ||
                    !offered.has(operation.id) ||
                    archived.has(operation.id),
            );
            const current = await this.#sidebarDocument(txCtx, sidebarId);
            let working = current.document;
            let base = first.document;
            const applied: SpaceSidebarOperation[] = [];
            for (const operation of operations) {
                // A new row exists now, below Happy where new work arrives: it moves into place.
                const effective: SpaceSidebarOperation =
                    operation.type === "insert" &&
                    operation.node.type === "space" &&
                    created.has(operation.node.id)
                        ? { type: "move", id: operation.node.id, to: operation.to }
                        : operation;
                // One the proposal offered but that could not start is left out.
                if (
                    operation.type === "insert" &&
                    operation.node.type === "space" &&
                    !created.has(operation.node.id) &&
                    record.newRows?.some((row) => row.id === operation.node.id) === true
                ) {
                    base = projectSidebar(base, [{ operations: [operation] }]);
                    continue;
                }
                try {
                    const step = applySpaceSidebarOperations(working, [effective], { base });
                    await this.#checkSidebarIds(
                        txCtx,
                        ownerUserId,
                        step.document,
                        placedSidebarIds(step.operations),
                    );
                    working = step.document;
                    applied.push(...step.operations);
                } catch (error: unknown) {
                    if (
                        !(error instanceof SpaceSidebarError) &&
                        !(error instanceof SidebarValidationError)
                    )
                        throw error;
                }
                base = projectSidebar(base, [{ operations: [operation] }]);
            }
            const version = await this.#commitPersonBatch(txCtx, ownerUserId, {
                artifactId: sidebarId,
                current,
                applied: { document: working, operations: applied },
                mutationId,
                digest,
            });
            for (const { task } of archiving)
                await this.#tasks.archive(txCtx, task.id, task.version);
            const decided: SidebarProposalRecord = {
                ...record,
                status: "accepted",
                decidedAt: Date.now(),
                acceptedVersion: version,
                decisionMutationId: mutationId,
                archived: [...archived],
                ...(started.length === 0 ? {} : { started }),
            };
            await this.#writeProposals(txCtx, ownerUserId, decided);
            const proposal = await this.#proposalResource(txCtx, decided);
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                {
                    type: "proposal_changed",
                    proposal,
                    previousVersion: proposal.version,
                    author: "person",
                    operations: [],
                },
            ]);
            await this.#queueSidebarBrief(
                txCtx,
                ownerUserId,
                `The person accepted your sidebar proposal ${artifactId}; the sidebar now follows it${archived.size === 0 ? "" : `, and ${String(archived.size)} finished ${archived.size === 1 ? "task was" : "tasks were"} archived`}${started.length === 0 ? "" : `, and ${String(started.length)} new ${started.length === 1 ? "chat was" : "chats were"} started read-only`}.`,
                { wake: true },
            );
            return {
                proposal,
                sidebar: {
                    artifactId: sidebarId,
                    version,
                    html: formatSpaceSidebar(working),
                    operations: applied,
                },
                archived: [...archived],
                started,
            };
        });
    }

    /**
     * Good to go: the person accepts the proposal by pressing it in a chat, with the press's
     * message ID as the mutation. Answers with what the press returns to clients, what the
     * conversation's model reads, and each started chat with the section it stands under.
     */
    async acceptProposalByPress(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        artifactId: string,
        mutationId: string,
    ): Promise<{
        readonly result: {
            readonly proposal: string;
            readonly started: readonly { readonly spaceId: string; readonly agentId: string }[];
        };
        readonly outcome: string;
        readonly chats: readonly SpaceStartedChat[];
    }> {
        const accepted = await this.acceptProposal(ctx, ownerUserId, artifactId, mutationId);
        const record = await this.#ownedProposal(ctx, ownerUserId, artifactId);
        const items = readSidebarDocument(accepted.sidebar.html).items;
        const sectionOf = (id: string): string | undefined => {
            let label: string | undefined;
            for (const item of items) {
                if (item.type === "section") label = item.label;
                else if (item.type === "separator") label = undefined;
                else if (item.id === id) return label;
            }
            return undefined;
        };
        const chats = accepted.started.map(({ spaceId, agentId }) => {
            const section = sectionOf(spaceId);
            return {
                spaceId,
                agentId,
                title: record.newRows?.find((row) => row.id === spaceId)?.title ?? "A new chat",
                ...(section === undefined ? {} : { section }),
            };
        });
        const outcome = [
            "Focus's proposal is accepted, and the sidebar now follows it.",
            ...(chats.length === 0
                ? []
                : [
                      `Started ${String(chats.length)} ${chats.length === 1 ? "chat" : "chats"}, each making a read-only plan and waiting for them before it changes anything:`,
                      ...chats.map(
                          (chat) =>
                              `- ${chat.title}${chat.section === undefined ? "" : `, under ${chat.section}`} (data-item ${chat.spaceId})`,
                      ),
                  ]),
            ...(accepted.archived.length === 0
                ? []
                : [
                      `Archived ${String(accepted.archived.length)} finished ${accepted.archived.length === 1 ? "task" : "tasks"}.`,
                  ]),
        ].join("\n");
        return { result: { proposal: artifactId, started: accepted.started }, outcome, chats };
    }

    /** The person's Prioritizing, when it is the conversation with this agent ID. */
    async isFocus(ctx: Context, ownerUserId: SpaceOwnerId, agentId: string): Promise<boolean> {
        return (await this.#livePrioritizing(ctx, ownerUserId)) === agentId;
    }

    /**
     * Each accepted new row becomes a chat with the space ID the proposal reserved, named and
     * iconed as proposed from the start, then sent its first message as the person's, read-only,
     * on the person's default model. A row whose chat cannot be made is left out.
     */
    async #startNewRows(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        rows: readonly SidebarProposalNewRow[],
    ): Promise<{ spaceId: string; agentId: string }[]> {
        const started: { spaceId: string; agentId: string }[] = [];
        const route = await this.#prioritizingRoute(ctx, ownerUserId);
        for (const row of rows) {
            if ((await querySpace(ctx, row.id)) !== undefined) continue;
            const agentId = createId();
            try {
                const creation = await this.#tasks.createWithResult(ctx, {
                    id: createId(),
                    agentId,
                    name: row.title,
                });
                await this.createStemCell(ctx, ownerUserId, {
                    spaceId: row.id,
                    task: creation.task,
                    icon: { type: "library", slug: row.icon },
                });
            } catch (error: unknown) {
                ctx.log.warn("A proposed chat could not be started.", {}, error);
                continue;
            }
            started.push({ spaceId: row.id, agentId });
            if (route === undefined) continue;
            const mode = {
                providerId: route.providerId,
                modelId: route.model,
                effort: route.effort,
                serviceTier: null,
                permissionMode: "read_only" as const,
            };
            await this.#requireAgents().send(
                ctx,
                agentId,
                { role: "user", content: [{ type: "text", text: row.firstMessage }] },
                {
                    id: createId(),
                    metadata: { ...USER_MESSAGE_ORIGIN_METADATA, mode },
                    provider: route.providerId,
                    model: route.model,
                    effort: route.effort,
                    serviceTier: null,
                    permissionMode: "read_only",
                },
            );
            await this.#requireAgents().updateMetadata(ctx, agentId, {
                lastMode: mode,
                updatedAt: Date.now(),
            });
        }
        return started;
    }

    /** The person declined a proposal: the sidebar stays as it is, and Prioritizing is told. */
    async declineProposal(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        artifactId: string,
        mutationId?: string,
    ): Promise<{ readonly proposal: SidebarProposal }> {
        return await ctx.inTx(async (txCtx) => {
            const record = await this.#ownedProposal(txCtx, ownerUserId, artifactId);
            if (record.status === "accepted")
                throw new SpaceConflictError("This proposal was already accepted.");
            if (record.status === "declined")
                return { proposal: await this.#proposalResource(txCtx, record) };
            const decided: SidebarProposalRecord = {
                ...record,
                status: "declined",
                decidedAt: Date.now(),
                ...(mutationId === undefined ? {} : { decisionMutationId: mutationId }),
            };
            await this.#writeProposals(txCtx, ownerUserId, decided);
            const proposal = await this.#proposalResource(txCtx, decided);
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                {
                    type: "proposal_changed",
                    proposal,
                    previousVersion: proposal.version,
                    author: "person",
                    operations: [],
                },
            ]);
            await this.#queueSidebarBrief(
                txCtx,
                ownerUserId,
                `The person declined your sidebar proposal ${artifactId}; the sidebar stays as it was. Do not propose the same change again unless they ask.`,
                { wake: true },
            );
            return { proposal };
        });
    }

    /** Artifact storage calls this when a proposal artifact is made; only Spaces makes one. */
    async validateProposalWrite(ctx: Context, artifactId: string): Promise<void> {
        for (const state of await queryOwnerStates(ctx))
            if (state.sidebarProposals?.some((proposal) => proposal.artifactId === artifactId))
                return;
        throw new SidebarValidationError("Sidebar proposals are made by Focus.");
    }

    async #ownedProposal(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        artifactId: string,
    ): Promise<SidebarProposalRecord> {
        const record = (await this.#ownerState(ctx, ownerUserId)).sidebarProposals?.find(
            (proposal) => proposal.artifactId === artifactId,
        );
        if (record === undefined) throw new SpaceNotFoundError("The proposal was not found.");
        return record;
    }

    /** Stores one proposal's record, newest last, keeping the latest twenty. */
    async #writeProposals(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        record: SidebarProposalRecord,
    ): Promise<void> {
        const state = await this.#ownerState(ctx, ownerUserId);
        const others = (state.sidebarProposals ?? []).filter(
            (proposal) => proposal.artifactId !== record.artifactId,
        );
        const index = (state.sidebarProposals ?? []).findIndex(
            (proposal) => proposal.artifactId === record.artifactId,
        );
        const proposals =
            index < 0
                ? [...others, record]
                : [...others.slice(0, index), record, ...others.slice(index)];
        await writeOwnerState(ctx, { ...state, sidebarProposals: proposals.slice(-20) });
    }

    async #proposalResource(ctx: Context, record: SidebarProposalRecord): Promise<SidebarProposal> {
        return {
            artifactId: record.artifactId,
            version:
                (await this.#requireArtifacts().get(ctx, record.artifactId))?.latestVersion ?? 1,
            baseVersion: record.baseVersion,
            status: record.status,
            createdAt: record.createdAt,
            decidedAt: record.decidedAt ?? null,
            acceptedVersion: record.acceptedVersion ?? null,
            newRows: (record.newRows ?? []).map((row) => ({
                id: row.id,
                title: row.title,
                icon: { type: "library" as const, slug: row.icon },
                why: row.why ?? null,
                firstMessage: row.firstMessage,
            })),
            started: record.started ?? [],
        };
    }

    /**
     * A proposal holds the sidebar's document rules, and its Archive block holds only the
     * person's task rows.
     */
    async #checkProposal(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        document: SpaceSidebarDocument,
        placed: ReadonlySet<string>,
        newRowIds: ReadonlySet<string> = new Set(),
    ): Promise<void> {
        await this.#checkSidebarIds(ctx, ownerUserId, document, placed, newRowIds);
        const rows = new Map((await querySpaces(ctx, ownerUserId)).map((row) => [row.id, row]));
        for (const id of archiveOffers(document)) {
            const row = rows.get(id);
            if (row?.role !== "item" || row.contents[0]?.kind !== "task")
                throw new SidebarValidationError(
                    `Only task rows may stand in the Archive block; ${id} is not one.`,
                );
        }
    }

    /** Whether the person may archive this task: its owner, or the team's owner. */
    async #mayArchive(ctx: Context, ownerUserId: SpaceOwnerId, task: TaskRecord): Promise<boolean> {
        if (!this.#team.enabled) return true;
        if (task.ownerUserId !== undefined && task.ownerUserId === ownerUserId) return true;
        return (await this.#team.getUser(ctx, ownerUserId))?.isOwner === true;
    }

    sidebarArtifactTools(agentId: string): AnyAgentTool[] {
        return this.#artifacts?.sidebarTools(agentId) ?? [];
    }

    /**
     * Hold a notice for Prioritizing's next brief. Notices starting with `replaces` are one
     * conversation's: only the latest few are kept, so a busy chat never crowds out the rest.
     * With `wake`, the notice is an event Prioritizing acts on — the person's own change or new
     * work — and wakes it shortly after this commits; any other notice waits for the next wake.
     * Prioritizing's own writes never wake it.
     */
    async #queueSidebarBrief(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        text: string,
        options: { readonly replaces?: string; readonly wake?: boolean } = {},
    ): Promise<void> {
        if (!(await this.#stemCellsEnabled(ctx, ownerUserId))) return;
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.sidebarArtifactId === undefined) return;
        let earlier = state.sidebarBrief ?? [];
        const replaces = options.replaces;
        if (replaces !== undefined) {
            const same = earlier.filter((notice) => notice.startsWith(replaces));
            const stale = new Set(same.slice(0, -(CONVERSATION_BRIEFS_KEPT - 1)));
            earlier = earlier.filter((notice) => !stale.has(notice));
        }
        await writeOwnerState(ctx, {
            ...state,
            sidebarBrief: [...new Set([...earlier, text.slice(0, 2_000)])].slice(-32),
            ...(options.wake === true ? { sidebarWakeAt: state.sidebarWakeAt ?? Date.now() } : {}),
        });
        if (options.wake === true)
            afterCommit(ctx, () => {
                this.#scheduleWake(ownerUserId);
            });
    }

    /**
     * Publish the rows of this conversation again once its runs have stopped starting and settling
     * for a moment, so `working` follows the conversation without an event per run. Read after the
     * delay, the run a settlement ends is gone, and one that started meanwhile is counted.
     */
    #scheduleWorking(agentId: string): void {
        const lifetime = this.#lifetime;
        if (lifetime === undefined || this.#workingTimers.has(agentId)) return;
        const timer = setTimeout(() => {
            this.#workingTimers.delete(agentId);
            void this.#publishWorking(lifetime.named("spaces-working"), agentId).catch(
                (error: unknown) => {
                    lifetime.log.warn("A row's working state could not be published.", {}, error);
                },
            );
        }, WORKING_DELAY_MS);
        timer.unref?.();
        this.#workingTimers.set(agentId, timer);
    }

    async #publishWorking(ctx: Context, agentId: string): Promise<void> {
        // Every row event carries `working` as it is then, so whatever a client saw last may be
        // stale; each burst publishes once, whatever it was.
        await ctx.inTx(async (txCtx) => {
            for (const row of await querySpacesByAgent(txCtx, agentId)) {
                const target = row.contents[0];
                if (target === undefined || target.kind === "surface" || target.agentId !== agentId)
                    continue;
                // The version grows so clients take the copy; the row's own change time stays.
                const next: SpaceRecord = { ...row, version: row.version + 1 };
                await updateSpace(txCtx, next, row.version);
                await this.#commitEvents(txCtx, row.ownerUserId, undefined, [
                    { type: "space_updated", space: next },
                ]);
            }
        });
    }

    /** Wake Prioritizing once the burst this event belongs to has had time to arrive. */
    #scheduleWake(ownerUserId: SpaceOwnerId): void {
        const lifetime = this.#lifetime;
        if (lifetime === undefined || this.#wakeTimers.has(ownerUserId)) return;
        const timer = setTimeout(() => {
            this.#wakeTimers.delete(ownerUserId);
            void this.#wake(lifetime.named("spaces-wake"), ownerUserId).catch((error: unknown) => {
                lifetime.log.warn("Focus could not be told.", {}, error);
            });
        }, WAKE_DELAY_MS);
        timer.unref?.();
        this.#wakeTimers.set(ownerUserId, timer);
    }

    /**
     * Brief Prioritizing with every waiting notice, if an event asked for it. While it is still
     * deciding, the wake waits for the end of that turn, so a burst makes one more run at most.
     */
    async #wake(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const state = await queryOwnerState(txCtx, ownerUserId);
            if (state?.sidebarWakeAt === undefined) return;
            if (
                state.prioritizingAgentId !== undefined &&
                this.#busyPrioritizing.has(state.prioritizingAgentId)
            )
                return;
            await this.#brief(txCtx, ownerUserId, "Here is what changed since your last notice.");
        });
    }

    /**
     * A brief's notices are kept until a run of Prioritizing ends well. A run that failed, such as
     * for a provider without credentials, puts them back for the next brief.
     */
    async #settleBrief(ctx: Context, ownerUserId: SpaceOwnerId, succeeded: boolean): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const state = await queryOwnerState(txCtx, ownerUserId);
            if (state === undefined || (state.sidebarBriefSent ?? []).length === 0) return;
            const { sidebarBriefSent: sent = [], ...rest } = state;
            await writeOwnerState(
                txCtx,
                succeeded
                    ? rest
                    : {
                          ...rest,
                          sidebarBrief: [
                              ...new Set([...sent, ...(state.sidebarBrief ?? [])]),
                          ].slice(-32),
                      },
            );
        });
    }

    /**
     * The daemon's own change: new work is inserted where it is expected, and work that left is
     * removed with its sessions, after the spaces attached under it move out to the top level.
     * Nobody is recorded as its author.
     */
    async #sidebarLifecycle(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        change: { add?: string; remove?: string; sectionId?: string },
        mutationId?: string,
    ): Promise<void> {
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.sidebarArtifactId === undefined) return;
        await this.#migrateSidebar(ctx, ownerUserId, state.sidebarArtifactId);
        const current = await this.#sidebarDocument(ctx, state.sidebarArtifactId);
        const rows = change.remove === undefined ? undefined : await this.#rowIds(ctx, ownerUserId);
        const operations: SpaceSidebarOperation[] =
            change.remove === undefined
                ? []
                : [
                      ...liftAttachmentsOut(current.document, change.remove, (id) => rows!.has(id)),
                      { type: "remove", id: change.remove },
                  ];
        const cleared = applySpaceSidebarOperations(current.document, operations).document;
        if (change.add !== undefined && locateSpaceSidebarNode(cleared, change.add) === undefined) {
            const happyId = (await querySpaces(ctx, ownerUserId)).find(
                (space) => space.role === "happy",
            )?.id;
            operations.push({
                type: "insert",
                node: { type: "space", id: change.add },
                to: newSpacePosition(cleared, {
                    ...(change.sectionId === undefined ? {} : { headingId: change.sectionId }),
                    ...(happyId === undefined ? {} : { happyId }),
                }),
            });
        }
        const applied = applySpaceSidebarOperations(current.document, operations);
        if (applied.operations.length === 0) return;
        await this.#commitSidebarVersion(ctx, ownerUserId, {
            artifactId: state.sidebarArtifactId,
            previousVersion: current.version,
            before: current.document,
            after: applied.document,
            operations: applied.operations,
            author: "daemon",
            operationId: createId(),
            ...(mutationId === undefined ? {} : { mutationId }),
        });
        const added = change.add === undefined ? undefined : await querySpace(ctx, change.add);
        if (added === undefined) {
            await this.#queueSidebarBrief(
                ctx,
                ownerUserId,
                `${change.remove} left the sidebar with the sessions under it.`,
            );
            return;
        }
        // New work is told to Prioritizing with its first message, not when it appears.
        if (isUntouchedStemCell(added)) return;
        const description = await this.describe(ctx, added);
        await this.#queueSidebarBrief(
            ctx,
            ownerUserId,
            `New space ${added.id}${description.named ? ` "${description.title.slice(0, 200)}"` : ""} was inserted${change.sectionId === undefined ? " below Happy" : ` after ${change.sectionId}`}. Give it an icon, and place it once its subject is clear.`,
            { wake: true },
        );
    }

    async section(ctx: Context, sectionId: string): Promise<SpaceSectionRecord | undefined> {
        return await querySection(ctx, sectionId);
    }

    async batches(ctx: Context, ownerUserId: SpaceOwnerId, limit: number): Promise<SpaceBatch[]> {
        return await queryBatches(ctx, ownerUserId, Math.max(1, Math.min(limit, 100)));
    }

    /** Resolve a row's content for display: its live title, what a click opens, and its activity. */
    async describe(ctx: Context, space: SpaceRecord): Promise<SpaceDescription> {
        const primary = space.contents[0];
        if (primary === undefined) return blankDescription("Untitled", undefined);
        switch (primary.kind) {
            case "task": {
                const task = await this.#tasks.get(ctx, primary.taskId);
                return await this.#agentDescription(ctx, space, {
                    title: task?.name ?? "Task",
                    named: task === undefined || task.nameConfigured,
                    target: {
                        kind: "task",
                        id: primary.taskId,
                        agentId: primary.agentId,
                        ...(task === undefined ? {} : { workspaceId: task.workspaceId }),
                    },
                    archived: task === undefined || task.status === "archived",
                    imageUrl: undefined,
                });
            }
            case "bot": {
                const bot = await this.#bots.get(ctx, primary.botId);
                return await this.#agentDescription(ctx, space, {
                    title: space.role === "happy" ? "Happy" : (bot?.name ?? "Bot"),
                    named: true,
                    target: {
                        kind: "bot",
                        id: primary.botId,
                        agentId: primary.agentId,
                        ...(bot === undefined ? {} : { workspaceId: bot.workspaceId }),
                    },
                    archived: bot === undefined || bot.status === "archived",
                    imageUrl: bot?.avatar === undefined ? undefined : `/v0/bots/${bot.id}/avatar`,
                });
            }
            case "agent": {
                const config = await this.#requireAgents().config(ctx, primary.agentId);
                const title = config?.metadata?.["title"];
                const happy = await this.#bots.chiefOfStaff(ctx);
                return await this.#agentDescription(ctx, space, {
                    title: typeof title === "string" ? title : "Focus Agent",
                    named: true,
                    target: {
                        kind: "agent",
                        id: primary.agentId,
                        agentId: primary.agentId,
                        ...(happy === undefined ? {} : { workspaceId: happy.workspaceId }),
                    },
                    archived:
                        config === undefined || typeof config.metadata?.["archivedAt"] === "number",
                    imageUrl: undefined,
                });
            }
            case "surface": {
                const surface = (await this.#surfaces.list(ctx)).find(
                    (candidate) => candidate.id === primary.surfaceId,
                );
                return {
                    title: surface?.name ?? "List",
                    named: true,
                    target: { kind: "surface", id: primary.surfaceId },
                    archived: surface === undefined,
                    working: false,
                    lastActivityAt: surface?.updatedAt,
                    imageUrl:
                        surface?.image === null || surface === undefined
                            ? undefined
                            : `/v0/surfaces/${surface.id}/image`,
                };
            }
        }
    }

    /**
     * Onboarding's real sidebar replacing the example: the default Bots and Tasks headings go
     * while nothing is under them, so no heading disappears later and moves the rows below it.
     */
    async removeEmptyDefaultHeadings(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        const sidebar = await this.sidebar(ctx, ownerUserId);
        const operations: SpaceSidebarOperation[] = emptyDefaultHeadings(
            readSidebarDocument(sidebar.html).items,
        ).map((item) => ({ type: "remove", id: item.id }));
        if (operations.length === 0) return;
        await this.applySidebarOperations(ctx, ownerUserId, {
            mutationId: createId(),
            baseVersion: sidebar.version,
            operations,
        });
    }

    /**
     * Wrap a freshly created task in a stem-cell row. Without a section it waits under Happy for
     * Prioritizing; with one, the person already chose where it goes, so it is settled at the top.
     */
    async createStemCell(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        input: {
            readonly spaceId: string;
            readonly task: TaskRecord;
            readonly sectionId?: string;
            readonly mutationId?: string;
            /** Work that already knows what it is wears its icon from the start, never growing one. */
            readonly icon?: SpaceIcon;
        },
    ): Promise<SpaceRecord> {
        return await ctx.inTx(async (txCtx) => {
            const existing = await querySpace(txCtx, input.spaceId);
            if (existing !== undefined) {
                if (existing.ownerUserId !== ownerUserId) throw new SpaceNotFoundError();
                return existing;
            }
            await this.#ensureOwner(txCtx, ownerUserId);
            let legacySectionId: string | undefined;
            if (input.sectionId !== undefined) {
                const section = await querySection(txCtx, input.sectionId);
                if (section?.ownerUserId === ownerUserId) legacySectionId = section.id;
                const sidebar =
                    this.#artifacts === undefined
                        ? undefined
                        : await this.sidebar(txCtx, ownerUserId);
                const authored =
                    sidebar !== undefined &&
                    readSidebarDocument(sidebar.html).items.some(
                        (item) => isSidebarHeading(item) && item.id === input.sectionId,
                    );
                if (legacySectionId === undefined && !authored) {
                    throw new SpaceNotFoundError("The section was not found.");
                }
            }
            const content: SpaceRef = {
                kind: "task",
                taskId: input.task.id,
                agentId: input.task.agentId,
            };
            // The task's own membership event may have made a plain row already; it becomes this one.
            const previous = await querySpaceByRef(txCtx, ownerUserId, spaceContentKey(content));
            const rows = await querySpaces(txCtx, ownerUserId);
            const siblings = rows.filter(
                (row) => row.sectionId === input.sectionId && row.id !== previous?.id,
            );
            const now = Date.now();
            const space: SpaceRecord = {
                id: input.spaceId,
                ownerUserId,
                role: "item",
                icon: input.icon ?? { type: "stem_cell" },
                contents: [content],
                ...(legacySectionId === undefined ? {} : { sectionId: legacySectionId }),
                orderKey: rowKeyAtTop(siblings),
                placement: input.sectionId === undefined ? "pending" : "settled",
                visibility: "shown",
                ...(input.sectionId === undefined ? {} : { manualAt: now }),
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            // The seed may have made a row for this task already; the stem cell replaces it.
            if (previous !== undefined) {
                await deleteSpace(txCtx, previous.id);
                await deletePendingChanges(txCtx, ownerUserId, [`space:${previous.id}`]);
            }
            await insertSpace(txCtx, space);
            // A sidebar row names its subject in a few words; other work keeps standard names.
            if (await this.#stemCellsEnabled(txCtx, ownerUserId)) {
                await this.#titles.nameBySubject(txCtx, input.task.agentId);
            }
            // Prioritizing begins with the person's first new work.
            await this.#ensurePrioritizing(txCtx, ownerUserId);
            if (this.#artifacts !== undefined) {
                await this.#ensureSidebar(txCtx, ownerUserId);
                await this.#sidebarLifecycle(
                    txCtx,
                    ownerUserId,
                    {
                        add: space.id,
                        ...(previous === undefined ? {} : { remove: previous.id }),
                        ...(input.sectionId === undefined ? {} : { sectionId: input.sectionId }),
                    },
                    input.mutationId,
                );
            }
            await this.#commitEvents(txCtx, ownerUserId, input.mutationId, [
                ...(previous === undefined
                    ? []
                    : [{ type: "space_removed" as const, spaceId: previous.id }]),
                { type: "space_created", space },
            ]);
            return space;
        });
    }

    /**
     * The person changed a row: moved, folded, or hid it. Their own action applies at once,
     * settles the row, and marks it as placed by hand so Prioritizing keeps it there until its
     * state changes. Giving `sectionId` moves the row, first unless `afterId` says otherwise; a
     * moved row is shown unless `visibility` says otherwise.
     */
    async update(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        spaceId: string,
        change: {
            readonly sectionId?: string | null;
            readonly afterId?: string | null;
            readonly visibility?: SpaceRecord["visibility"];
        },
        mutationId?: string,
    ): Promise<SpaceRecord> {
        if (change.afterId === spaceId) {
            throw new SpaceConflictError("A row cannot be placed after itself.");
        }
        return await ctx.inTx(async (txCtx) => {
            const space = await this.#ownedSpace(txCtx, ownerUserId, spaceId);
            const moved = change.sectionId !== undefined || change.afterId !== undefined;
            const target =
                change.sectionId === undefined ? space.sectionId : (change.sectionId ?? undefined);
            if (target !== undefined && target !== space.sectionId) {
                const section = await querySection(txCtx, target);
                if (section === undefined || section.ownerUserId !== ownerUserId) {
                    throw new SpaceNotFoundError("The section was not found.");
                }
            }
            const now = Date.now();
            const next: SpaceRecord = {
                ...space,
                placement: "settled",
                visibility: change.visibility ?? (moved ? "shown" : space.visibility),
                manualAt: now,
                version: space.version + 1,
                updatedAt: now,
            };
            if (moved) {
                const siblings = (await querySpaces(txCtx, ownerUserId)).filter(
                    (row) =>
                        row.id !== spaceId &&
                        row.visibility === "shown" &&
                        row.sectionId === target,
                );
                const afterId = change.afterId ?? null;
                if (afterId !== null && !siblings.some((row) => row.id === afterId)) {
                    throw new SpaceConflictError("The row to place after is not in that section.");
                }
                next.orderKey = rowKeyAfter(siblings, afterId);
                if (target === undefined) delete next.sectionId;
                else next.sectionId = target;
            }
            await updateSpace(txCtx, next, space.version);
            // A queued change of this row would undo the person's choice.
            await deletePendingChanges(txCtx, ownerUserId, [`space:${spaceId}`]);
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                { type: "space_updated", space: next },
            ]);
            return next;
        });
    }

    /**
     * The person removed new work they never wrote in. Its row goes and its task is archived;
     * once its conversation holds any message it is real work and is refused. Removing a row
     * that is already gone succeeds, so a retry is harmless.
     */
    async remove(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        spaceId: string,
        mutationId?: string,
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const space = await querySpace(txCtx, spaceId);
            if (space === undefined) return;
            if (space.ownerUserId !== ownerUserId) {
                throw new SpaceNotFoundError();
            }
            const primary = space.contents[0];
            if (space.role !== "item" || primary?.kind !== "task" || space.contents.length > 1) {
                throw new SpaceConflictError("Only new work can be removed; hide it instead.");
            }
            if (
                space.briefedAt !== undefined ||
                (await this.#history.stats(txCtx, primary.agentId)).messages > 0 ||
                (await this.#history.pending(txCtx, primary.agentId)).length > 0
            ) {
                throw new SpaceConflictError(
                    "This conversation has messages, so it is kept; hide it instead.",
                );
            }
            await deleteSpace(txCtx, space.id);
            await deletePendingChanges(txCtx, ownerUserId, [`space:${space.id}`]);
            const task = await this.#tasks.get(txCtx, primary.taskId);
            if (task !== undefined && task.status === "active") {
                await this.#tasks.archive(txCtx, task.id, task.version);
            }
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                { type: "space_removed", spaceId: space.id },
            ]);
        });
    }

    /** The person opened or closed a section, or its "+k more" tail. */
    async setSectionDisclosure(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        sectionId: string,
        disclosure: { readonly collapsed?: boolean; readonly tailExpanded?: boolean },
        mutationId?: string,
    ): Promise<SpaceSectionRecord> {
        return await ctx.inTx(async (txCtx) => {
            const section = await querySection(txCtx, sectionId);
            if (section === undefined || section.ownerUserId !== ownerUserId) {
                throw new SpaceNotFoundError("The section was not found.");
            }
            const next: SpaceSectionRecord = {
                ...section,
                collapsed: disclosure.collapsed ?? section.collapsed,
                tailExpanded: disclosure.tailExpanded ?? section.tailExpanded,
            };
            if (
                next.collapsed === section.collapsed &&
                next.tailExpanded === section.tailExpanded
            ) {
                return section;
            }
            next.version = section.version + 1;
            next.updatedAt = Date.now();
            await updateSection(txCtx, next, section.version);
            await this.#commitEvents(txCtx, ownerUserId, mutationId, [
                { type: "section_updated", section: next },
            ]);
            return next;
        });
    }

    /**
     * The client's view of the person's attention, still accepted but no longer needed: nothing
     * waits for it. `calm` applies a batch that is waiting while Prioritizing is not deciding, as
     * the regular check would; `interacting` changes nothing. Returns the applied batch, if any.
     */
    async reportAttention(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        attention: "interacting" | "calm",
    ): Promise<SpaceBatch | undefined> {
        if (attention === "interacting") return undefined;
        return await this.#applyIfDue(ctx, ownerUserId, "check");
    }

    /**
     * "Tidy now" is one automatic message in Prioritizing's conversation and nothing more. Before
     * the person's first new work there is no Prioritizing, and it does nothing.
     */
    async requestTidy(ctx: Context, ownerUserId: SpaceOwnerId): Promise<boolean> {
        return await ctx.inTx(async (txCtx) => {
            await this.#ensureOwner(txCtx, ownerUserId);
            if ((await this.#livePrioritizing(txCtx, ownerUserId)) === undefined) {
                // Asked to tidy with nobody to do it: Prioritizing begins, and its opening reads
                // the sidebar.
                await this.#ensurePrioritizing(txCtx, ownerUserId);
                return (await this.#livePrioritizing(txCtx, ownerUserId)) !== undefined;
            }
            await this.#brief(txCtx, ownerUserId, "Tidy the sidebar now.");
            return true;
        });
    }

    /** Queue one Prioritizing change for the end of its turn. Only Prioritizing calls this. */
    async queueChange(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        change: SpacePendingChange,
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            await this.#requirePrioritizingEnabled(txCtx, ownerUserId);
            if (change.type === "place" || change.type === "visibility") {
                const space = await this.#ownedSpace(txCtx, ownerUserId, change.spaceId);
                if (space.role !== "item") {
                    throw new SpaceConflictError("Happy cannot be moved.");
                }
                if (change.type === "visibility" && change.visibility !== "shown") {
                    const busy = await this.#recentWork(txCtx, space);
                    if (busy !== undefined)
                        return `${busy}, so it stays shown. Nothing was queued.`;
                }
            }
            if (change.type === "remove_section" || (change.type === "section" && !change.create)) {
                const section = await querySection(txCtx, change.sectionId);
                if (section === undefined || section.ownerUserId !== ownerUserId) {
                    throw new SpaceNotFoundError("The section was not found.");
                }
            }
            // Section names are unique per person: a second "Movies" becomes the first one.
            if (change.type === "section" && change.name !== undefined) {
                const twin = await this.#sectionNamed(txCtx, ownerUserId, change.name);
                if (twin !== undefined && twin !== change.sectionId) {
                    if (!change.create) {
                        throw new SpaceConflictError(
                            `Section ${twin} is already called ${change.name.trim()}. Move rows there instead.`,
                        );
                    }
                    const { sectionId: _sectionId, create: _create, name: _name, ...rest } = change;
                    if (Object.keys(rest).filter((key) => key !== "type").length > 0) {
                        await this.queueChange(txCtx, ownerUserId, {
                            ...rest,
                            type: "section",
                            sectionId: twin,
                            create: false,
                        });
                    }
                    return `Section ${twin} is already called ${change.name.trim()}; use it.`;
                }
            }
            const target =
                change.type === "place" || change.type === "visibility"
                    ? `space:${change.spaceId}`
                    : `section:${change.sectionId}`;
            // A section is changed by merging into what was already queued for it.
            let stored = change;
            if (change.type === "section") {
                const earlier = (await queryPendingChanges(txCtx, ownerUserId)).find(
                    (pending) =>
                        pending.type === "section" && pending.sectionId === change.sectionId,
                );
                if (earlier?.type === "section") {
                    stored = { ...earlier, ...change, create: earlier.create || change.create };
                }
            }
            await upsertPendingChange(txCtx, ownerUserId, target, stored, Date.now());
            const count = (await queryPendingChanges(txCtx, ownerUserId)).length;
            const what =
                change.type === "section" && change.create
                    ? `Section ${change.sectionId} queued for creation`
                    : "Change queued";
            return `${what}. ${String(count)} changes apply when this turn ends.`;
        });
    }

    /** The section this person has, or has queued, under this name, ignoring case and spaces. */
    async #sectionNamed(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        name: string,
    ): Promise<string | undefined> {
        const key = name.trim().toLowerCase();
        const pending = await queryPendingChanges(ctx, ownerUserId);
        const removed = new Set(
            pending.flatMap((change) =>
                change.type === "remove_section" ? [change.sectionId] : [],
            ),
        );
        const names = new Map<string, string>();
        for (const section of await querySections(ctx, ownerUserId)) {
            names.set(section.id, section.name);
        }
        for (const change of pending) {
            if (change.type === "section" && change.name !== undefined) {
                names.set(change.sectionId, change.name);
            }
        }
        for (const [sectionId, sectionName] of names) {
            if (!removed.has(sectionId) && sectionName.trim().toLowerCase() === key) {
                return sectionId;
            }
        }
        return undefined;
    }

    /**
     * Archive the task behind one of the person's rows now, because its work shipped. Only
     * Prioritizing calls this; whether the work shipped is its judgement. The daemon checks only
     * that the row is the person's task and that the person may archive it.
     */
    async archiveShippedTask(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        spaceId: string,
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            await this.#requirePrioritizingEnabled(txCtx, ownerUserId);
            const space = await this.#ownedSpace(txCtx, ownerUserId, spaceId);
            const primary = space.contents[0];
            if (space.role !== "item" || primary?.kind !== "task") {
                throw new SpaceConflictError("Only task rows can be archived.");
            }
            const task = await this.#tasks.get(txCtx, primary.taskId);
            if (task === undefined || task.status === "archived") {
                return "That task is already archived.";
            }
            if (!(await this.#mayArchive(txCtx, ownerUserId, task))) {
                throw new SpaceConflictError(
                    "Only the task's owner or the team owner can archive this task; offer it in a proposal instead.",
                );
            }
            await this.#tasks.archive(txCtx, task.id, task.version);
            return `Archived ${JSON.stringify(task.name)}. Its row leaves the sidebar; the person can restore it.`;
        });
    }

    /**
     * Tell a teammate's Prioritizing that another person's agent thinks a task concerns them.
     * Their Prioritizing decides whether to add it; nothing joins here. A teammate without Stem
     * Cells has no Prioritizing to tell, which the caller hears as `false`.
     */
    async forwardMention(
        ctx: Context,
        input: {
            readonly userId: string;
            readonly taskId: string;
            readonly reason: string;
            readonly fromName?: string;
        },
    ): Promise<boolean> {
        return await ctx.inTx(async (txCtx) => {
            const user = this.#team.enabled
                ? await this.#team.getUser(txCtx, input.userId)
                : undefined;
            if (user === undefined || user.authentication === "guest") return false;
            if (!(await this.#stemCellsEnabled(txCtx, user.id))) return false;
            const task = await this.#tasks.get(txCtx, input.taskId);
            if (task === undefined) return false;
            await this.#ensureOwner(txCtx, user.id);
            await this.#ensurePrioritizing(txCtx, user.id);
            if (this.#artifacts !== undefined) await this.#ensureSidebar(txCtx, user.id);
            const member = await this.#tasks.membership(txCtx, task.id, user.id);
            const about = [
                user.role === undefined ? undefined : `The person's role: ${user.role}.`,
                user.follows === undefined ? undefined : `They follow: ${user.follows}.`,
            ]
                .filter((line) => line !== undefined)
                .join(" ");
            await this.#queueSidebarBrief(
                txCtx,
                user.id,
                [
                    `${input.fromName === undefined ? "A teammate's agent" : `${input.fromName}'s agent`} mentioned the person in task ${task.id} ${JSON.stringify(task.name.slice(0, 200))}${member === undefined ? "" : ", which they are already in"}: ${input.reason}`,
                    about,
                    "If it concerns what they do or follow, add it with join_task; otherwise leave it.",
                ]
                    .filter((line) => line !== "")
                    .join(" "),
                { wake: true },
            );
            return true;
        });
    }

    /**
     * Join the person to a task and mark it new for them on every device. Only Prioritizing calls
     * this, after a teammate's agent mentioned them; whether it concerns them is its judgement.
     */
    async joinTask(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        agentId: string,
        taskId: string,
        note: string,
    ): Promise<string> {
        if (!this.#team.enabled) {
            throw new SpaceConflictError("Only a team member is added to someone else's task.");
        }
        return await ctx.inTx(async (txCtx) => {
            await this.#requirePrioritizingEnabled(txCtx, ownerUserId);
            const { joined } = await this.#tasks.loopIn(txCtx, taskId, ownerUserId, {
                agentId,
                note,
            });
            return joined
                ? "Joined the person to the task and marked it new for them. Its row arrives as new work; place it."
                : "The person was already in the task; it is marked new for them again.";
        });
    }

    /** The display name of the team member who wrote a message, if one is identified. */
    async #teammateName(ctx: Context, userId: unknown): Promise<string | undefined> {
        if (!this.#team.enabled || !Value.Check(cuid2Schema, userId)) return undefined;
        const user = await this.#team.getUser(ctx, userId);
        if (user === undefined) return undefined;
        return user.lastName === null ? user.firstName : `${user.firstName} ${user.lastName}`;
    }

    /** Set an icon now. Only Prioritizing calls this. */
    async setIcon(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        spaceId: string,
        slug: SpaceIconSlug,
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            await this.#requirePrioritizingEnabled(txCtx, ownerUserId);
            const row = await querySpace(txCtx, spaceId);
            if (row === undefined)
                return await this.#setSessionIcon(txCtx, ownerUserId, spaceId, slug);
            const space = await this.#ownedSpace(txCtx, ownerUserId, spaceId);
            if (space.role !== "item") throw new SpaceConflictError("Only item rows take icons.");
            // A stem cell stays one until the person says what they want.
            if (isUntouchedStemCell(space))
                return "This is new work with no first message yet; its icon was left alone.";
            if (space.icon?.type === "library" && space.icon.slug === slug) {
                return `The row already shows ${slug}.`;
            }
            const now = Date.now();
            const next: SpaceRecord = {
                ...space,
                icon: { type: "library", slug },
                version: space.version + 1,
                updatedAt: now,
            };
            await updateSpace(txCtx, next, space.version);
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                { type: "space_updated", space: next },
            ]);
            return `Icon set to ${slug}.`;
        });
    }

    /** A session under one of the person's rows keeps its icon even when it is not shown. */
    async #setSessionIcon(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        agentId: string,
        slug: SpaceIconSlug,
    ): Promise<string> {
        const owners = await this.#sessionOwners(ctx, agentId);
        if (!owners.includes(ownerUserId)) throw new SpaceNotFoundError();
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.agentIcons?.[agentId] === slug) return `The session already shows ${slug}.`;
        const icons = Object.entries({ ...state.agentIcons, [agentId]: slug }).filter(
            ([id]) => id !== agentId,
        );
        await writeOwnerState(ctx, {
            ...state,
            agentIcons: Object.fromEntries([...icons.slice(-999), [agentId, slug]]),
        });
        return `Icon set to ${slug}.`;
    }

    /** An agent's parent, or null for a root or an agent that does not exist. */
    async #parentOf(ctx: Context, agentId: string): Promise<string | null> {
        const agents = this.#requireAgents();
        if ((await agents.config(ctx, agentId)) === undefined) return null;
        return await agents.parentOf(ctx, agentId);
    }

    /** The people whose rows hold this session: the owners of the rows of its root conversation. */
    async #sessionOwners(ctx: Context, agentId: string): Promise<string[]> {
        return [...new Set((await this.#sessionRows(ctx, agentId)).map((row) => row.ownerUserId))];
    }

    /** The rows a session sits under: those of its root conversation, or none for a root. */
    async #sessionRows(ctx: Context, agentId: string): Promise<SpaceRecord[]> {
        let root = agentId;
        for (let depth = 0; depth < 16; depth++) {
            const parent = await this.#parentOf(ctx, root);
            if (parent === null) break;
            root = parent;
        }
        if (root === agentId) return [];
        return await querySpacesByAgent(ctx, root);
    }

    /**
     * Whether this conversation, or one above it, began as a stem cell. Making a stem cell marks
     * its conversation to be named by subject, and only a stem cell does, so that mark says it.
     */
    async #startedAsStemCell(ctx: Context, agentId: string): Promise<boolean> {
        return (await this.#titles.namingStyle(ctx, agentId)) === "subject";
    }

    /** The agent's latest reply with text, before whatever the person writes next. */
    async #lastAgentText(ctx: Context, agentId: string): Promise<string | undefined> {
        const page = await this.#history.read(ctx, agentId, {
            from: "end",
            roles: ["assistant"],
            limit: 20,
        });
        for (const { message } of [...page.messages].reverse()) {
            if (message.hideFromUser === true) continue;
            const text = message.blocks
                .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
                .filter((part) => part.length > 0)
                .join("\n\n");
            if (text.length > 0) return text;
        }
        return undefined;
    }

    /**
     * The people whose sidebar a conversation can attach to: the owners, with Stem Cells on, of
     * its own rows or, for a session, of its root conversation's rows, each with that row.
     */
    async #attachHosts(ctx: Context, agentId: string): Promise<SpaceRecord[]> {
        const own = await querySpacesByAgent(ctx, agentId);
        const rows = own.length > 0 ? own : await this.#sessionRows(ctx, agentId);
        const hosts: SpaceRecord[] = [];
        for (const row of rows)
            if (await this.#stemCellsEnabled(ctx, row.ownerUserId)) hosts.push(row);
        return hosts;
    }

    /**
     * A conversation puts a space under its own row: one of the person's rows, an existing
     * Surface, or a new one. It applies at once as Prioritizing's write, so it never overrides
     * what the person placed, and the row is expanded unless the person set its fold.
     */
    async attachToRow(
        ctx: Context,
        agentId: string,
        input: {
            readonly spaceId?: string;
            readonly surfaceId?: string;
            readonly create?: { readonly kind: SpaceAttachableSurfaceType; readonly name: string };
        },
        ids: { readonly surfaceId: string; readonly operationId: string },
    ): Promise<string> {
        if (
            [input.spaceId, input.surfaceId, input.create].filter((given) => given !== undefined)
                .length !== 1
        )
            throw new SpaceInputError("Give exactly one of spaceId, surfaceId, or create.");
        return await ctx.inTx(async (txCtx) => {
            const hosts = await this.#attachHosts(txCtx, agentId);
            if (hosts.length === 0)
                throw new SpaceInputError(
                    "This conversation has no row in a sidebar with Stem Cells turned on.",
                );
            let surfaceId = input.surfaceId;
            if (input.create !== undefined) {
                const creator = hosts[0]!.ownerUserId;
                const creatorUserId = creator === SPACE_STANDALONE_OWNER ? null : creator;
                surfaceId = (
                    await this.#surfaces.create(
                        txCtx,
                        { id: ids.surfaceId, type: input.create.kind, name: input.create.name },
                        creatorUserId,
                        undefined,
                        { userId: creatorUserId, agentId },
                    )
                ).id;
            }
            const results: string[] = [];
            for (const host of hosts) {
                const owner = host.ownerUserId;
                let space: SpaceRecord | undefined;
                if (input.spaceId !== undefined) {
                    space = await querySpace(txCtx, input.spaceId);
                    if (space?.ownerUserId !== owner) continue;
                } else {
                    space = await this.#attachableSurfaceRow(txCtx, owner, surfaceId!);
                    if (space === undefined) continue;
                }
                results.push(await this.#attachUnder(txCtx, owner, host, space, ids.operationId));
            }
            if (results.length === 0)
                throw new SpaceNotFoundError(
                    input.spaceId !== undefined
                        ? "That space is not in this person's sidebar."
                        : "That Surface is not one the person has joined, or its kind cannot be attached.",
                );
            if (surfaceId === undefined) return results.join("\n");
            const surface = await this.#surfaces.get(txCtx, surfaceId);
            return [
                ...results,
                `Surface ${surfaceId} (${surface?.type ?? "surface"}): <happy-surface id="${surfaceId}"/>. Fill it with the ordinary Surface tools.`,
            ].join("\n");
        });
    }

    /** The person's row for a Surface they joined, made now when they have none, and kept while empty. */
    async #attachableSurfaceRow(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        surfaceId: string,
    ): Promise<SpaceRecord | undefined> {
        const surface = await this.#surfaces.get(ctx, surfaceId);
        const surfaceType = surface === undefined ? undefined : surfaceTypeOf(surface.type);
        if (
            surface === undefined ||
            surfaceType === undefined ||
            surfaceType === "reference" ||
            !joinedBy(surface.members, ownerUserId)
        )
            return undefined;
        const state = await this.#ownerState(ctx, ownerUserId);
        if (state.attachedSurfaceIds?.includes(surfaceId) !== true)
            await writeOwnerState(ctx, {
                ...state,
                attachedSurfaceIds: [...(state.attachedSurfaceIds ?? []), surfaceId].slice(-1000),
            });
        await this.#addWork(
            ctx,
            ownerUserId,
            { kind: "surface", surfaceId, surfaceType },
            surface.image === null ? undefined : { type: "image" },
        );
        return await querySpaceByRef(ctx, ownerUserId, `surface:${surfaceId}`);
    }

    /** One person's attachment of `space` under `host`, committed as its own version. */
    async #attachUnder(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        host: SpaceRecord,
        space: SpaceRecord,
        operationId: string,
    ): Promise<string> {
        const title = (await this.describe(ctx, space)).title;
        if (space.id === host.id)
            throw new SpaceInputError("A row cannot be attached under itself.");
        const { artifactId } = await this.sidebar(ctx, ownerUserId);
        const current = await this.#sidebarDocument(ctx, artifactId);
        const at = locateSpaceSidebarNode(current.document, host.id);
        if (at === undefined || at.node.type !== "space")
            throw new SpaceConflictError(
                "This conversation's row is not in the sidebar right now, so nothing can go under it.",
            );
        const placed = locateSpaceSidebarNode(current.document, space.id);
        if (placed?.parentId === host.id) return `"${title}" is already under this row.`;
        const operations: SpaceSidebarOperation[] = [
            placed === undefined
                ? {
                      type: "insert",
                      node: { type: "space", id: space.id },
                      to: { parent: host.id },
                  }
                : { type: "move", id: space.id, to: { parent: host.id } },
        ];
        const state = await this.#ownerState(ctx, ownerUserId);
        if (!at.node.expanded && state.sidebarAuthorship?.[host.id]?.fold !== "person")
            operations.push({ type: "set", id: host.id, expanded: true });
        // The person asked their conversation for this, so it needs no proposal; what the person
        // placed still holds it back.
        const reviewed = applyPrioritizingOperations(
            current.document,
            operations,
            { ...(await this.#prioritizingRules(ctx, state)), direct: false },
            undefined,
        );
        if (reviewed.operations[0]?.type === "set" || reviewed.operations.length === 0)
            throw new SpaceConflictError(
                `"${title}" stays where it is. ${reviewed.notes.join(" ").replace(/^Dropped [^:]*: /, "")}`.trim(),
            );
        await this.#checkSidebarIds(
            ctx,
            ownerUserId,
            reviewed.document,
            placedSidebarIds(reviewed.operations),
        );
        await this.#commitSidebarVersion(ctx, ownerUserId, {
            artifactId,
            previousVersion: current.version,
            before: current.document,
            after: reviewed.document,
            operations: reviewed.operations,
            author: "prioritizing",
            operationId: `${operationId}:${ownerUserId}`,
        });
        await this.#queueSidebarBrief(
            ctx,
            ownerUserId,
            `The conversation of row ${host.id} attached ${space.id} under it.`,
        );
        return `Attached "${title}" under this conversation's row in the sidebar.`;
    }

    /**
     * Another agent asks for a row to move. Prioritizing decides; when the person asked for it in
     * their own words, the result applies as soon as Prioritizing finishes.
     */
    async requestPlacement(
        ctx: Context,
        actingAgentId: string,
        input: {
            readonly request: string;
            readonly agentId: string;
            readonly personAsked: boolean;
            readonly requestId: string;
        },
    ): Promise<string> {
        return await ctx.inTx(async (txCtx) => {
            let rows = await querySpacesByAgent(txCtx, input.agentId);
            if (
                rows.length === 0 &&
                !this.#config.configuration.values.feature.team.enabled &&
                (await this.#livePrioritizing(txCtx, SPACE_STANDALONE_OWNER)) !== undefined
            ) {
                await this.#ensureOwner(txCtx, SPACE_STANDALONE_OWNER);
                rows = await querySpacesByAgent(txCtx, input.agentId);
            }
            if (rows.length === 0) {
                return "That conversation is not in anyone's sidebar, so there is nothing to move.";
            }
            let briefed = false;
            for (const row of rows) {
                const description = await this.describe(txCtx, row);
                if ((await this.#livePrioritizing(txCtx, row.ownerUserId)) === undefined) continue;
                briefed = true;
                if (input.personAsked) {
                    const state = await this.#ownerState(txCtx, row.ownerUserId);
                    await writeOwnerState(txCtx, { ...state, applyRequestedAt: Date.now() });
                }
                await this.#brief(
                    txCtx,
                    row.ownerUserId,
                    [
                        `Agent ${actingAgentId} asks about the row "${description.title}" (id ${row.id}):`,
                        input.request.slice(0, MAX_BRIEF_TEXT),
                        input.personAsked
                            ? "The person asked for this explicitly, so your changes apply as soon as you finish."
                            : "Decide whether it fits the rules; it applies when you finish.",
                    ].join("\n\n"),
                    // One request is one message, however often the tool call is retried.
                    `${input.requestId}:${row.ownerUserId}`,
                );
            }
            if (!briefed) {
                return "Nothing organises that sidebar yet; the person can move the row themselves.";
            }
            return input.personAsked
                ? "The Focus Agent will make the change shortly."
                : "The Focus Agent has the request and decides shortly.";
        });
    }

    /**
     * Apply every queued change for one person as one batch: one transaction, one note in
     * Happy's chat, one recorded diff. Returns `undefined` when nothing was queued.
     */
    async applyBatch(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceBatch | undefined> {
        return await ctx.inTx(async (txCtx) => {
            if (!(await this.#stemCellsEnabled(txCtx, ownerUserId))) return undefined;
            const state = await this.#ownerState(txCtx, ownerUserId);
            if ((state.sidebarPending?.length ?? 0) > 0)
                return await this.#applySidebarBatch(txCtx, ownerUserId, state);
            const pending = await queryPendingChanges(txCtx, ownerUserId);
            const cleared: SpaceOwnerState = { ...state };
            delete cleared.applyRequestedAt;
            if (pending.length === 0) {
                if (state.applyRequestedAt !== undefined) {
                    await writeOwnerState(txCtx, cleared);
                }
                return undefined;
            }
            const spaces = await querySpaces(txCtx, ownerUserId);
            const sections = await querySections(txCtx, ownerUserId);
            // Protect the final composed outcome, including indirect folds from section removal
            // and work that came back to life after its change was queued.
            const protectedSpaceIds = new Set<string>();
            for (const space of spaces) {
                if ((await this.#recentWork(txCtx, space)) !== undefined) {
                    protectedSpaceIds.add(space.id);
                }
            }
            const titles = new Map<string, string>();
            for (const space of spaces) {
                if (space.role === "item") {
                    const description = await this.describe(txCtx, space);
                    // Work that has not named itself is never called by its placeholder.
                    titles.set(space.id, description.named ? description.title : "a new chat");
                }
            }
            const now = Date.now();
            const outcome = applySpaceChanges(
                ownerUserId,
                spaces,
                sections,
                pending,
                titles,
                now,
                protectedSpaceIds,
            );
            for (const section of outcome.createdSections) await insertSection(txCtx, section);
            for (const { section, previousVersion } of outcome.updatedSections) {
                await updateSection(txCtx, section, previousVersion);
            }
            for (const { space, previousVersion } of outcome.spaces) {
                await updateSpace(txCtx, space, previousVersion);
            }
            for (const sectionId of outcome.removedSectionIds)
                await deleteSection(txCtx, sectionId);
            await deletePendingChanges(txCtx, ownerUserId);
            await writeOwnerState(txCtx, cleared);
            const events: SpaceEventDraft[] = [
                ...outcome.createdSections.map(
                    (section): SpaceEventDraft => ({ type: "section_created", section }),
                ),
                ...outcome.updatedSections.map(
                    ({ section }): SpaceEventDraft => ({ type: "section_updated", section }),
                ),
                ...outcome.spaces.map(
                    ({ space }): SpaceEventDraft => ({ type: "space_updated", space }),
                ),
                ...outcome.removedSectionIds.map(
                    (sectionId): SpaceEventDraft => ({ type: "section_removed", sectionId }),
                ),
            ];
            if (outcome.changes.length === 0 && outcome.sectionChanges.length === 0) {
                await this.#commitEvents(txCtx, ownerUserId, undefined, events);
                return undefined;
            }
            const note = composeSpaceBatchNote(outcome.changes, outcome.sectionChanges);
            const noteMessageId = await this.#recordNote(txCtx, ownerUserId, note, now);
            const batch: SpaceBatch = {
                id: createId(),
                ownerUserId,
                note,
                ...(noteMessageId === undefined ? {} : { noteMessageId }),
                changes: [...outcome.changes],
                sections: [...outcome.sectionChanges],
                appliedAt: now,
            };
            await insertBatch(txCtx, batch);
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                ...events,
                { type: "batch_applied", batch },
            ]);
            return batch;
        });
    }

    /**
     * Prioritizing's queued proposals, applied when its turn ends as one version each, through the
     * same rebase as the person's batches. Operations that no longer apply, or that would now
     * override the person, are dropped with a note for Prioritizing; the rest still land.
     */
    async #applySidebarBatch(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        state: SpaceOwnerState,
    ): Promise<SpaceBatch | undefined> {
        if (state.sidebarArtifactId === undefined || state.prioritizingAgentId === undefined)
            return undefined;
        const artifactId = state.sidebarArtifactId;
        const pending = state.sidebarPending ?? [];
        const rules = await this.#prioritizingRules(ctx, state);
        const start = await this.#sidebarDocument(ctx, artifactId);
        let current = start;
        const notes: string[] = [];
        const applied: SpaceSidebarOperation[] = [];
        let wrote = false;
        for (const [index, proposal] of pending.entries()) {
            const result = applyPrioritizingOperations(
                current.document,
                proposal.operations,
                rules,
                await this.#sidebarBase(
                    ctx,
                    artifactId,
                    proposal.baseVersion,
                    pending.slice(0, index),
                ),
            );
            try {
                await this.#checkSidebarIds(
                    ctx,
                    ownerUserId,
                    result.document,
                    placedSidebarIds(result.operations),
                );
            } catch (error: unknown) {
                if (!(error instanceof SidebarValidationError)) throw error;
                notes.push(`Dropped a sidebar edit: ${error.message}`);
                continue;
            }
            notes.push(...result.notes);
            const metadata = {
                ...(proposal.title === undefined ? {} : { title: proposal.title }),
                ...(proposal.background === undefined ? {} : { background: proposal.background }),
            };
            if (result.operations.length === 0 && Object.keys(metadata).length === 0) continue;
            const version = await this.#commitSidebarVersion(ctx, ownerUserId, {
                artifactId,
                previousVersion: current.version,
                before: current.document,
                after: result.document,
                operations: result.operations,
                author: "prioritizing",
                operationId: proposal.operationId,
                metadata,
            });
            current = { version, document: result.document };
            applied.push(...result.operations);
            wrote = true;
        }
        const before = start.document;
        const after = current.document;
        const moved = new Set<string>(regroupedSidebarIds(before, after));
        const folded = new Set<string>();
        for (const operation of applied) {
            if (operation.type !== "set") moved.add(sidebarTarget(operation));
            else if (operation.collapsed !== undefined || operation.expanded !== undefined)
                folded.add(operation.id);
        }
        const changed = [...new Set([...moved, ...folded])];
        const fresh = await this.#ownerState(ctx, ownerUserId);
        const cleared: SpaceOwnerState = {
            ...fresh,
            sidebarPending: [],
            sidebarPlacedIds: [...new Set([...(fresh.sidebarPlacedIds ?? []), ...changed])].slice(
                -1000,
            ),
            ...(notes.length === 0
                ? {}
                : {
                      sidebarBrief: [...new Set([...(fresh.sidebarBrief ?? []), ...notes])].slice(
                          -32,
                      ),
                  }),
        };
        delete cleared.applyRequestedAt;
        await writeOwnerState(ctx, cleared);
        if (!wrote) return undefined;
        const changes: SpaceBatch["changes"] = [];
        for (const key of changed) {
            // Opening a row moves nothing; only what moved or appeared or vanished is described.
            if (
                !moved.has(key) &&
                sidebarPlacement(before, key).visibility === sidebarPlacement(after, key).visibility
            )
                continue;
            const row = (await querySpaces(ctx, ownerUserId)).find((space) => space.id === key);
            if (row?.role === "happy" || row?.role === "focus" || row?.role === "voice") continue;
            let title: string | undefined;
            if (row !== undefined) {
                const description = await this.describe(ctx, row);
                title = description.named ? description.title : "a new chat";
            } else {
                // A session under a row; sections, separators, and widgets are not work.
                const metadata = (await this.#requireAgents().config(ctx, key))?.metadata;
                if (metadata === undefined) continue;
                title = typeof metadata["title"] === "string" ? metadata["title"] : "a session";
            }
            changes.push({
                spaceId: key,
                title,
                from: { ...sidebarPlacement(before, key), placement: row?.placement ?? "settled" },
                to: { ...sidebarPlacement(after, key), placement: "settled" },
            });
        }
        const headings = (document: SpaceSidebarDocument) =>
            new Map(
                document.items.flatMap((item) =>
                    item.type === "section" || item.type === "separator"
                        ? [[item.id, item] as const]
                        : [],
                ),
            );
        const earlier = headings(before);
        const later = headings(after);
        // A section that moved carried its rows; the note names the section, not each row.
        const movedSections = [...moved].flatMap((key) => {
            const heading = later.get(key);
            return heading?.type !== "section" || !earlier.has(key) ? [] : [heading.label];
        });
        const sections: SpaceBatch["sections"] = [];
        for (const [id, heading] of later) {
            if (heading.type !== "section") continue;
            const previous = earlier.get(id);
            if (previous === undefined)
                sections.push({ sectionId: id, name: heading.label, change: "created" });
            else if (previous.type === "section" && previous.label !== heading.label)
                sections.push({ sectionId: id, name: heading.label, change: "updated" });
        }
        for (const [id, heading] of earlier)
            if (heading.type === "section" && !later.has(id))
                sections.push({ sectionId: id, name: heading.label, change: "removed" });
        // Separators have no title, so new ones are counted rather than named.
        const separators = [...later].filter(
            ([id, heading]) => heading.type === "separator" && !earlier.has(id),
        );
        if (separators.length > 0)
            sections.push({
                sectionId: separators[0]![0],
                name: separators.length === 1 ? "a separator" : `${separators.length} separators`,
                change: "created",
            });
        const addedOwnRow =
            rules.focusId !== undefined &&
            locateSpaceSidebarNode(before, rules.focusId) === undefined &&
            locateSpaceSidebarNode(after, rules.focusId) !== undefined;
        const note =
            changes.length === 0 && sections.length === 0 && movedSections.length === 0
                ? addedOwnRow
                    ? "Added this conversation to your sidebar."
                    : "Updated the sidebar."
                : composeSpaceBatchNote(changes, sections, movedSections);
        const now = Date.now();
        const noteMessageId = await this.#recordNote(ctx, ownerUserId, note, now);
        const batch: SpaceBatch = {
            id: createId(),
            ownerUserId,
            changes,
            sections,
            note,
            ...(noteMessageId === undefined ? {} : { noteMessageId }),
            appliedAt: now,
        };
        await insertBatch(ctx, batch);
        await this.#commitEvents(ctx, ownerUserId, undefined, [{ type: "batch_applied", batch }]);
        return batch;
    }

    /**
     * Apply the queued batch unless Prioritizing is still deciding: its changes land when its
     * turn ends. A request Prioritizing has not taken up yet produces nothing to apply; only the
     * end of its turn settles the request.
     */
    async #applyIfDue(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        moment: "check" | "settled",
    ): Promise<SpaceBatch | undefined> {
        const state = await queryOwnerState(ctx, ownerUserId);
        if (state === undefined) return undefined;
        if (
            state.prioritizingAgentId !== undefined &&
            this.#busyPrioritizing.has(state.prioritizingAgentId)
        )
            return undefined;
        if (
            state.applyRequestedAt !== undefined &&
            moment !== "settled" &&
            (await queryPendingChanges(ctx, ownerUserId)).length === 0 &&
            (state.sidebarPending?.length ?? 0) === 0
        )
            return undefined;
        return await this.applyBatch(ctx, ownerUserId);
    }

    /** What a restart or a lost timer left waiting: queued changes, and wakes not yet told. */
    async #checkOwners(ctx: Context): Promise<void> {
        const owners = new Set(await queryOwnersWithPendingChanges(ctx));
        for (const state of await queryOwnerStates(ctx)) {
            if (state.applyRequestedAt !== undefined || (state.sidebarPending?.length ?? 0) > 0)
                owners.add(state.ownerUserId);
            if (
                state.sidebarWakeAt !== undefined &&
                Date.now() - state.sidebarWakeAt >= WAKE_DELAY_MS
            )
                await this.#wake(ctx, state.ownerUserId);
        }
        for (const owner of owners) {
            if (!Value.Check(spaceOwnerIdSchema, owner)) continue;
            try {
                await this.#applyIfDue(ctx, owner, "check");
            } catch (error: unknown) {
                // An unreadable state was already skipped above; it must not stop everyone else.
                if (!(error instanceof SpaceStorageError)) throw error;
            }
        }
    }

    /**
     * Queue a message for the person's Prioritizing, delivered after this transaction commits.
     * A person without Prioritizing yet has nobody to tell, so nothing is queued.
     */
    async #brief(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        text: string,
        operationId?: string,
    ): Promise<void> {
        if ((await this.#livePrioritizing(ctx, ownerUserId)) === undefined) return;
        const state = await this.#ownerState(ctx, ownerUserId);
        const notices = state.sidebarBrief ?? [];
        const brief = [text, ...notices, "Start with list_sidebar."].join("\n\n").slice(0, 20_000);
        await this.#durableFunctions.invoke(ctx, {
            function: BRIEF_FUNCTION,
            arguments: {
                ownerUserId,
                messageId: createId(),
                text: brief,
                generation: state.prioritizingGeneration ?? 0,
            },
            ...(operationId === undefined ? {} : { operationId: `spaces:${operationId}` }),
        });
        const { sidebarSeed: _seed, sidebarWakeAt: _wake, ...rest } = state;
        // A notice after the opening is Prioritizing's next normal run: the seed is its to tidy.
        await writeOwnerState(ctx, {
            ...rest,
            sidebarBrief: [],
            sidebarBriefSent: [...new Set([...(state.sidebarBriefSent ?? []), ...notices])].slice(
                -32,
            ),
        });
    }

    async #deliverBrief(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        messageId: string,
        text: string,
        generation: number,
    ): Promise<void> {
        await ctx.inTx(async (ctx) => {
            if (
                ((await this.#ownerState(ctx, ownerUserId)).prioritizingGeneration ?? 0) !==
                generation
            )
                return;
            const prioritizingAgentId = await this.#livePrioritizing(ctx, ownerUserId);
            if (prioritizingAgentId === undefined) return;
            await this.#requireAgents().send(
                ctx,
                prioritizingAgentId,
                { role: "user", content: [{ type: "text", text }] },
                {
                    id: messageId,
                    metadata: { ...AGENT_MESSAGE_ORIGIN_METADATA },
                    ...(await this.#reportedMode(ctx, prioritizingAgentId)),
                    permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
                },
            );
        });
    }

    /**
     * The mode Prioritizing reports, the one the person last chose in its conversation, while this
     * installation still offers it. A notice runs on it, so neither a notice nor an earlier daemon's
     * notice moves Prioritizing off it. Without one, a notice names no model and Prioritizing stays
     * on what it was made with.
     */
    async #reportedMode(ctx: Context, agentId: string) {
        const mode = (await this.#requireAgents().config(ctx, agentId))?.metadata?.["lastMode"];
        if (!Value.Check(messageModeSchema, mode)) return {};
        const model = this.#config.models.find(
            (candidate) =>
                candidate.providerId === mode.providerId && candidate.id === mode.modelId,
        );
        const effort = mode.effort as SessionReasoningEffort;
        if (model === undefined || !model.effortLevels.includes(effort)) return {};
        return {
            provider: model.providerId,
            model: model.id,
            effort,
            ...(mode.serviceTier === null || model.serviceTiers?.includes(mode.serviceTier) === true
                ? { serviceTier: mode.serviceTier as SessionServiceTier | null }
                : {}),
        };
    }

    /** The person's Prioritizing, unless they have none yet or archived it. */
    async #livePrioritizing(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string | undefined> {
        if (!(await this.#stemCellsEnabled(ctx, ownerUserId))) return undefined;
        const agentId = (await queryOwnerState(ctx, ownerUserId))?.prioritizingAgentId;
        if (agentId === undefined) return undefined;
        const config = await this.#requireAgents().config(ctx, agentId);
        return config === undefined || typeof config.metadata?.["archivedAt"] === "number"
            ? undefined
            : agentId;
    }

    /** The sidebar experiment belongs to this person, never to the installation or another caller. */
    async #stemCellsEnabled(ctx: Context, ownerUserId: SpaceOwnerId): Promise<boolean> {
        let personCtx = ctx;
        if (this.#team.enabled) {
            const user = await this.#team.getUser(ctx, ownerUserId);
            if (user === undefined || user.authentication === "guest") return false;
            personCtx = this.#team.connectionContext(ctx, user);
        }
        return (
            (await this.#userSettings.get(personCtx, "happy-desktop.experiments.stemCells"))
                .value === true
        );
    }

    async #requirePrioritizingEnabled(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        if (!(await this.#stemCellsEnabled(ctx, ownerUserId))) {
            throw new SpaceConflictError("Turn on Stem Cells to let Focus change the sidebar.");
        }
    }

    /** Disable only this person's organiser; its conversation and every existing name stay intact. */
    async #disablePrioritizing(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const state = await queryOwnerState(txCtx, ownerUserId);
            if (state === undefined) return;
            const { applyRequestedAt: _requested, ...rest } = state;
            await deletePendingChanges(txCtx, ownerUserId);
            const { sidebarWakeAt: _wake, sidebarBriefSent: _sent, ...kept } = rest;
            await writeOwnerState(txCtx, {
                ...kept,
                sidebarPending: [],
                sidebarBrief: [],
                prioritizingGeneration: (state.prioritizingGeneration ?? 0) + 1,
            });
            if (state.prioritizingAgentId !== undefined) {
                await this.#requireAgents().abort(txCtx, state.prioritizingAgentId);
            }
        });
    }

    /** What a new Prioritizing is made on: the default model from Settings, at its own effort. */
    async #prioritizingRoute(ctx: Context, ownerUserId: SpaceOwnerId) {
        // Settings belong to whoever the context names: the standalone person, or a team member.
        let personCtx: Context | undefined = ctx;
        if (this.#team.enabled) {
            const user = await this.#team.getUser(ctx, ownerUserId);
            personCtx =
                user === undefined || user.authentication === "guest"
                    ? undefined
                    : this.#team.connectionContext(ctx, user);
        }
        return selectPrioritizingRoute(
            this.#config.models,
            personCtx === undefined
                ? null
                : (await this.#userSettings.get(personCtx, PRIORITIZING_DEFAULT_MODEL_SETTING))
                      .value,
        );
    }

    async #happyAgentId(ctx: Context, ownerUserId: SpaceOwnerId): Promise<string | undefined> {
        const happy = (await querySpaceByRef(ctx, ownerUserId, "happy"))?.contents[0];
        return happy?.kind === "bot" ? happy.agentId : undefined;
    }

    /**
     * Prioritizing is an ordinary subtask of Happy, made through the same path as any subtask
     * Happy creates, with its opening task. It is made with the person's first new work, and
     * again with the next new work after the person archived it.
     */
    async #ensurePrioritizing(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        opening: string = PRIORITIZING_OPENING,
    ): Promise<void> {
        if (!(await this.#stemCellsEnabled(ctx, ownerUserId))) return;
        if ((await this.#livePrioritizing(ctx, ownerUserId)) !== undefined) return;
        const happyAgentId = await this.#happyAgentId(ctx, ownerUserId);
        const route = await this.#prioritizingRoute(ctx, ownerUserId);
        if (happyAgentId === undefined || route === undefined) return;
        const prioritizingAgentId = createId();
        this.#creatingPrioritizing.add(prioritizingAgentId);
        afterCommit(ctx, () => {
            this.#creatingPrioritizing.delete(prioritizingAgentId);
        });
        await this.#subtasks.create(
            ctx,
            happyAgentId,
            {
                title: "Focus Agent",
                text: opening,
                provider: route.providerId,
                model: route.model,
                effort: route.effort,
            },
            prioritizingAgentId,
            undefined,
            { provider: route.providerId, model: route.model },
            // Happy hears from Prioritizing only through the batch note, one line per batch.
            { unreported: true },
        );
        await writeOwnerState(ctx, {
            ...(await this.#ownerState(ctx, ownerUserId)),
            prioritizingAgentId,
            prioritizingRevision: PRIORITIZING_REVISION,
        });
        await this.#ensureFocusRow(ctx, ownerUserId, prioritizingAgentId);
    }

    /**
     * Prioritizing's own row: a space for its conversation that the document names only once
     * Prioritizing inserts it. A row of an earlier Prioritizing gives way to the new one.
     */
    async #ensureFocusRow(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        prioritizingAgentId: string,
    ): Promise<void> {
        const existing = await querySpaceByRef(ctx, ownerUserId, "focus");
        if (existing?.contents[0]?.kind === "agent") {
            if (existing.contents[0].agentId === prioritizingAgentId) return;
            await this.#removeFocusRow(ctx, ownerUserId);
        }
        const now = Date.now();
        const space: SpaceRecord = {
            id: createId(),
            ownerUserId,
            role: "focus",
            icon: { type: "library", slug: FOCUS_ICON },
            contents: [{ kind: "agent", agentId: prioritizingAgentId }],
            orderKey: "2",
            placement: "settled",
            visibility: "shown",
            version: 1,
            createdAt: now,
            updatedAt: now,
        };
        if (await insertSpaceIfAbsent(ctx, space))
            await this.#commitEvents(ctx, ownerUserId, undefined, [
                { type: "space_created", space },
            ]);
    }

    async #removeFocusRow(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        const row = await querySpaceByRef(ctx, ownerUserId, "focus");
        if (row === undefined) return;
        await deleteSpace(ctx, row.id);
        await this.#commitEvents(ctx, ownerUserId, undefined, [
            { type: "space_removed", spaceId: row.id },
        ]);
    }

    /**
     * One line in Prioritizing's own conversation, as a finished run of its own without a model
     * turn, so it reads like any other message there, live and after a reload. Happy's
     * conversation never hears from Prioritizing.
     */
    async #recordNote(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        note: string,
        now: number,
    ): Promise<string | undefined> {
        const agentId = await this.#livePrioritizing(ctx, ownerUserId);
        if (agentId === undefined) return undefined;
        const noteMessageId = createId();
        const runId = createId();
        await this.#history.beginMaintenanceRun(ctx, agentId, runId, now);
        await this.#history.record(ctx, agentId, {
            role: "assistant",
            recordId: noteMessageId,
            runId,
            blocks: [{ type: "text", text: note }],
            at: now,
        });
        await this.#history.finishMaintenanceRun(ctx, agentId, runId, "completed", now);
        return noteMessageId;
    }

    /** Why this row's work counts as live — running now, or active in the last two hours. */
    async #recentWork(ctx: Context, space: SpaceRecord): Promise<string | undefined> {
        const description = await this.describe(ctx, space);
        if (description.working) return "This row's work is running now";
        const at = description.lastActivityAt;
        if (at !== undefined && Date.now() - at < SPACE_RECENT_WORK_MS) {
            return `This row was active ${formatConversationAge(Date.now() - at)} ago`;
        }
        return undefined;
    }

    async #ownerState(ctx: Context, ownerUserId: SpaceOwnerId): Promise<SpaceOwnerState> {
        return (await queryOwnerState(ctx, ownerUserId)) ?? { ownerUserId };
    }

    async #ownedSpace(ctx: Context, ownerUserId: SpaceOwnerId, spaceId: string) {
        const space = await querySpace(ctx, spaceId);
        if (space === undefined || space.ownerUserId !== ownerUserId) {
            throw new SpaceNotFoundError();
        }
        return space;
    }

    /**
     * Make sure the person has Happy and a row for everything they already have. Existing work
     * arrives folded and unplaced, and Prioritizing organises it when it begins.
     */
    async #ensureOwner(ctx: Context, ownerUserId: SpaceOwnerId): Promise<void> {
        const now = Date.now();
        const existing = await queryOwnerState(ctx, ownerUserId);
        const drafts: SpaceEventDraft[] = [];
        let seeded = 0;
        const add = async (space: SpaceRecord): Promise<void> => {
            if (await insertSpaceIfAbsent(ctx, space))
                drafts.push({ type: "space_created", space });
        };
        const happyBot = await this.#bots.chiefOfStaff(ctx);
        if (happyBot !== undefined) {
            await add({
                id: createId(),
                ownerUserId,
                role: "happy",
                icon: { type: "image" },
                contents: [{ kind: "bot", botId: happyBot.id, agentId: happyBot.agentId }],
                orderKey: "1",
                placement: "settled",
                visibility: "shown",
                version: 1,
                createdAt: now,
                updatedAt: now,
            });
        }
        if (existing !== undefined) {
            if (drafts.length > 0) await this.#commitEvents(ctx, ownerUserId, undefined, drafts);
            return;
        }
        const seed = async (content: SpaceRef, icon?: SpaceRecord["icon"]): Promise<void> => {
            seeded += 1;
            await add({
                id: createId(),
                ownerUserId,
                role: "item",
                ...(icon === undefined ? {} : { icon }),
                contents: [content],
                orderKey: String(seeded).padStart(6, "0"),
                placement: "pending",
                visibility: "folded",
                version: 1,
                createdAt: now,
                updatedAt: now,
            });
        };
        for (const bot of await this.#bots.list(ctx)) {
            if (bot.systemKey !== undefined || bot.status !== "active") continue;
            await seed({ kind: "bot", botId: bot.id, agentId: bot.agentId }, botIcon(bot));
        }
        for (const { task } of await this.#tasks.listForMember(ctx, ownerUserId)) {
            if (task.status !== "active") continue;
            await seed({ kind: "task", taskId: task.id, agentId: task.agentId });
        }
        for (const surface of await this.#surfaces.list(ctx)) {
            if (!joinedBy(surface.members, ownerUserId)) continue;
            const surfaceType = surfaceTypeOf(surface.type);
            if (
                surfaceType === undefined ||
                (surfaceNeedsContent(surfaceType) &&
                    !(await this.#surfaces.hasContent(ctx, surface.id)))
            )
                continue;
            await seed(
                { kind: "surface", surfaceId: surface.id, surfaceType },
                surface.image === null ? undefined : { type: "image" },
            );
        }
        // Prioritizing's opening task places the seeded rows; that first tidy applies at once.
        await writeOwnerState(ctx, {
            ownerUserId,
            ...(seeded > 0 ? { applyRequestedAt: now } : {}),
        });
        await this.#commitEvents(ctx, ownerUserId, undefined, drafts);
    }

    /** Keep rows in step with the work they hold as it is created, joined, renamed, and closed. */
    #subscribe(): void {
        if (this.#unsubscribe.length > 0) return;
        this.#unsubscribe.push(
            this.#events.subscribe((event) => {
                if (
                    (event.type === "loop.started" || event.type === "loop.settled") &&
                    event.agentId !== undefined
                )
                    this.#scheduleWorking(event.agentId);
            }),
            this.#userSettings.onEventTransactional(async (ctx, event) => {
                if (
                    event.setting.key === "happy-desktop.experiments.stemCells" &&
                    event.setting.value !== true
                ) {
                    await this.#disablePrioritizing(ctx, event.owner);
                }
            }),
            this.#tasks.onEvent(async (_eventCtx, event) => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                const ctx = lifetime.named("spaces-task-event");
                if (event.type === "task_joined") {
                    await this.#addWork(ctx, event.membership.memberId, {
                        kind: "task",
                        taskId: event.membership.taskId,
                        agentId: (await this.#tasks.get(ctx, event.membership.taskId))?.agentId,
                    });
                } else if (event.type === "task_left") {
                    await this.#closeWork(ctx, `task:${event.membership.taskId}`, [
                        event.membership.memberId,
                    ]);
                } else if (event.type === "task_deleted") {
                    await this.#closeWork(ctx, `task:${event.task.id}`);
                } else if (event.type === "task_updated") {
                    if (
                        event.task.status === "archived" &&
                        event.previousTask.status !== "archived"
                    ) {
                        await this.#closeWork(ctx, `task:${event.task.id}`);
                    } else if (
                        event.task.status === "active" &&
                        event.previousTask.status === "archived"
                    ) {
                        // Back from the archive: every member's sidebar gets it again.
                        for (const state of await queryOwnerStates(ctx)) {
                            const member = await this.#tasks.membership(
                                ctx,
                                event.task.id,
                                state.ownerUserId,
                            );
                            if (member === undefined) continue;
                            await this.#addWork(ctx, state.ownerUserId, {
                                kind: "task",
                                taskId: event.task.id,
                                agentId: event.task.agentId,
                            });
                        }
                    } else if (event.task.name !== event.previousTask.name) {
                        await this.#touchWork(ctx, `task:${event.task.id}`);
                    }
                }
            }),
            this.#bots.onEvent(async (_eventCtx, event) => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                const ctx = lifetime.named("spaces-bot-event");
                if (event.bot.systemKey !== undefined) return;
                if (event.type === "bot_deleted") {
                    await this.#closeWork(ctx, `bot:${event.bot.id}`);
                } else if (
                    event.type === "bot_created" ||
                    (event.bot.status === "active" && event.previousBot.status === "archived")
                ) {
                    for (const state of await queryOwnerStates(ctx)) {
                        await this.#addWork(
                            ctx,
                            state.ownerUserId,
                            { kind: "bot", botId: event.bot.id, agentId: event.bot.agentId },
                            botIcon(event.bot),
                        );
                    }
                } else if (
                    event.bot.status === "archived" &&
                    event.previousBot.status !== "archived"
                ) {
                    await this.#closeWork(ctx, `bot:${event.bot.id}`);
                } else if (event.bot.name !== event.previousBot.name) {
                    await this.#touchWork(ctx, `bot:${event.bot.id}`);
                }
            }),
            this.#surfaces.onEvent(async (_eventCtx, event) => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                const ctx = lifetime.named("spaces-surface-event");
                const surfaceId =
                    event.type === "surface.created"
                        ? event.payload.surface.id
                        : event.type === "todo.created"
                          ? event.payload.todo.surfaceId
                          : event.type === "calendar_event.created"
                            ? event.payload.event.surfaceId
                            : event.payload.surfaceId;
                await ctx.inTx(async (txCtx) => {
                    // Notifications are durable and may lag later membership changes. Reconcile
                    // against current state so a delayed join cannot resurrect a row after leave.
                    await this.#reconcileSurfaces(txCtx, surfaceId);
                    if (event.type === "surface.updated") {
                        // Names and pictures are projected live; advance rows and emit their
                        // complete snapshots so connected sidebars refresh those projections.
                        await this.#touchWork(txCtx, `surface:${surfaceId}`);
                    }
                });
            }),
            this.#surfaces.onDocumentChanged(async (_ctx, surfaceId) => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                await lifetime
                    .named("spaces-document-event")
                    .inTx((tx) => this.#reconcileSurfaces(tx, surfaceId));
            }),
        );
    }

    /**
     * Eligibility is current content plus membership, or membership alone for a Surface someone
     * attached under a row; existing placement remains the person's.
     */
    async #reconcileSurfaces(ctx: Context, onlySurfaceId?: string): Promise<void> {
        const owners = await queryOwnerStates(ctx);
        const ownerIds = owners.map((state) => state.ownerUserId);
        if (ownerIds.length === 0) return;
        const eligible = new Map<string, SpaceRef & { kind: "surface" }>();
        const attachable = new Map<string, SpaceRef & { kind: "surface" }>();
        const surfaces = (await this.#surfaces.list(ctx)).filter(
            (surface) => onlySurfaceId === undefined || surface.id === onlySurfaceId,
        );
        for (const surface of surfaces) {
            const surfaceType = surfaceTypeOf(surface.type);
            if (
                surfaceType === undefined ||
                !ownerIds.some((owner) => joinedBy(surface.members, owner))
            )
                continue;
            const content = { kind: "surface" as const, surfaceId: surface.id, surfaceType };
            attachable.set(surface.id, content);
            if (
                !surfaceNeedsContent(surfaceType) ||
                (await this.#surfaces.hasContent(ctx, surface.id))
            )
                eligible.set(surface.id, content);
        }
        for (const state of owners) {
            const owner = state.ownerUserId;
            const attached = new Set(state.attachedSurfaceIds ?? []);
            const eligibleFor = (surfaceId: string) =>
                eligible.get(surfaceId) ??
                (attached.has(surfaceId) ? attachable.get(surfaceId) : undefined);
            for (const row of await querySpaces(ctx, owner)) {
                const content = row.contents[0];
                if (
                    content?.kind !== "surface" ||
                    (onlySurfaceId !== undefined && content.surfaceId !== onlySurfaceId)
                )
                    continue;
                const surface = surfaces.find((candidate) => candidate.id === content.surfaceId);
                if (
                    eligibleFor(content.surfaceId) === undefined ||
                    surface === undefined ||
                    !joinedBy(surface.members, owner)
                )
                    await this.#closeWork(ctx, `surface:${content.surfaceId}`, [owner]);
            }
            // Leaving an attached Surface ends its exemption; joining again waits for content.
            const left = surfaces.filter(
                (surface) => attached.has(surface.id) && !joinedBy(surface.members, owner),
            );
            if (left.length > 0) {
                const fresh = await this.#ownerState(ctx, owner);
                await writeOwnerState(ctx, {
                    ...fresh,
                    attachedSurfaceIds: (fresh.attachedSurfaceIds ?? []).filter(
                        (id) => !left.some((surface) => surface.id === id),
                    ),
                });
            }
            for (const surface of surfaces) {
                const content = eligibleFor(surface.id);
                if (content !== undefined && joinedBy(surface.members, owner))
                    await this.#addWork(
                        ctx,
                        owner,
                        content,
                        surface.image === null ? undefined : { type: "image" },
                    );
            }
        }
    }

    /**
     * New work for one person: an unplaced row under Happy that Prioritizing places after its
     * first message. A row that already exists is left alone.
     */
    async #addWork(
        ctx: Context,
        ownerUserId: string,
        content: { kind: "task"; taskId: string; agentId: string | undefined } | SpaceRef,
        icon?: SpaceRecord["icon"],
    ): Promise<void> {
        if (!Value.Check(spaceOwnerIdSchema, ownerUserId)) return;
        if (content.kind === "task" && content.agentId === undefined) return;
        const ref = content as SpaceRef;
        await ctx.inTx(async (txCtx) => {
            if ((await queryOwnerState(txCtx, ownerUserId)) === undefined) return;
            const siblings = (await querySpaces(txCtx, ownerUserId)).filter(
                (row) => row.sectionId === undefined,
            );
            const now = Date.now();
            const space: SpaceRecord = {
                id: createId(),
                ownerUserId,
                role: "item",
                ...(icon === undefined ? {} : { icon }),
                contents: [ref],
                orderKey: rowKeyAtTop(siblings),
                placement: "pending",
                visibility: "shown",
                version: 1,
                createdAt: now,
                updatedAt: now,
            };
            if (!(await insertSpaceIfAbsent(txCtx, space))) return;
            await this.#commitEvents(txCtx, ownerUserId, undefined, [
                { type: "space_created", space },
            ]);
            // Work another agent created may have its first message before its row: tell it now.
            const first =
                ref.kind === "task" ? await this.#firstMessageText(txCtx, ref.agentId) : undefined;
            if (first !== undefined) {
                await updateSpaceBriefedAt(txCtx, space.id, now);
                await this.#queueSidebarBrief(
                    txCtx,
                    ownerUserId,
                    newWorkBrief(space, first, false),
                    {
                        wake: true,
                    },
                );
            }
        });
    }

    /** Whether this text is the first, and only, message from the person or another agent. */
    async #opensConversation(ctx: Context, agentId: string, text: string): Promise<boolean> {
        const page = await this.#history.read(ctx, agentId, {
            from: "start",
            roles: ["user", "agent"],
            limit: 2,
        });
        if (page.messages.length === 0) return true;
        return page.messages.length === 1 && (await this.#firstMessageText(ctx, agentId)) === text;
    }

    /** The text of a conversation's first message from the person or another agent. */
    async #firstMessageText(ctx: Context, agentId: string): Promise<string | undefined> {
        const page = await this.#history.read(ctx, agentId, {
            from: "start",
            roles: ["user", "agent"],
            limit: 1,
        });
        const text = page.messages[0]?.message.blocks
            .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
            .filter((part) => part.length > 0)
            .join("\n\n");
        return text === undefined || text.length === 0 ? undefined : text;
    }

    /**
     * The work was archived or left: its rows leave the sidebar at once, with anything queued
     * for them. The work itself keeps its history; unarchiving brings a fresh row back.
     */
    async #closeWork(ctx: Context, refKey: string, owners?: readonly string[]): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            for (const row of await querySpacesByRef(txCtx, refKey)) {
                if (owners !== undefined && !owners.includes(row.ownerUserId)) continue;
                if (row.role !== "item") continue;
                await deleteSpace(txCtx, row.id);
                await deletePendingChanges(txCtx, row.ownerUserId, [`space:${row.id}`]);
                await this.#commitEvents(txCtx, row.ownerUserId, undefined, [
                    { type: "space_removed", spaceId: row.id },
                ]);
            }
        });
    }

    /** The content's title changed; the row advances so clients read it again. */
    async #touchWork(ctx: Context, refKey: string): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            for (const row of await querySpacesByRef(txCtx, refKey)) {
                const next: SpaceRecord = {
                    ...row,
                    version: row.version + 1,
                    updatedAt: Date.now(),
                };
                await updateSpace(txCtx, next, row.version);
                await this.#queueSidebarBrief(
                    txCtx,
                    row.ownerUserId,
                    `Space ${row.id} was renamed or its identity changed. Read its live title with list_sidebar.`,
                );
                await this.#commitEvents(txCtx, row.ownerUserId, undefined, [
                    { type: "space_updated", space: next },
                ]);
            }
        });
    }

    async #agentDescription(
        ctx: Context,
        space: SpaceRecord,
        base: Omit<SpaceDescription, "working" | "lastActivityAt">,
    ): Promise<SpaceDescription> {
        const agentId = base.target?.agentId;
        return {
            ...base,
            working: agentId !== undefined && this.#events.activeRunId(agentId) !== undefined,
            lastActivityAt:
                agentId === undefined
                    ? undefined
                    : await this.#history.latestUserOrFinalAssistantTextMessageAt(ctx, agentId),
        };
    }

    /** Publish these changes after the transaction commits. */
    async #commitEvents(
        ctx: Context,
        ownerUserId: SpaceOwnerId,
        mutationId: string | undefined,
        drafts: readonly SpaceEventDraft[],
    ): Promise<void> {
        if (drafts.length === 0) return;
        if (this.#artifacts !== undefined) {
            for (const draft of drafts) {
                // Prioritizing inserts its own row; Voice's row is inserted once, with Voice.
                if (
                    draft.type === "space_created" &&
                    draft.space.role !== "focus" &&
                    draft.space.role !== "voice"
                )
                    await this.#sidebarLifecycle(
                        ctx,
                        ownerUserId,
                        { add: draft.space.id },
                        mutationId,
                    );
                if (draft.type === "space_removed")
                    await this.#sidebarLifecycle(
                        ctx,
                        ownerUserId,
                        { remove: draft.spaceId },
                        mutationId,
                    );
            }
        }
        const at = Date.now();
        const events = drafts.map((draft) => {
            const event = {
                ...draft,
                at,
                ownerUserId,
                ...(mutationId === undefined ? {} : { mutationId }),
            } as SpaceEvent;
            if (!Value.Check(spaceEventSchema, event))
                throw new Error("The space event is invalid.");
            return structuredClone(event);
        });
        afterCommit(ctx, async (eventCtx) => {
            for (const event of events) {
                for (const listener of [...this.#listeners]) {
                    try {
                        await listener(eventCtx, event);
                    } catch (error: unknown) {
                        eventCtx.log.error("A sidebar subscriber failed.", { ownerUserId }, error);
                    }
                }
            }
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The spaces module has not started.");
        return this.#agents;
    }
}

/** The document as Prioritizing reads it, with its queued proposals drawn in. */
interface PrioritizingView {
    readonly artifactId: string;
    readonly current: { readonly version: number; readonly document: SpaceSidebarDocument };
    readonly document: SpaceSidebarDocument;
    /** The version Prioritizing's next edit names. */
    readonly version: number;
}

type SpaceEventDraft = SpaceEvent extends infer Event
    ? Event extends SpaceEvent
        ? Omit<Event, "at" | "ownerUserId" | "mutationId">
        : never
    : never;

function newWorkBrief(row: SpaceRecord, text: string, placedByPerson: boolean): string {
    // The whole notice fits one entry of the brief.
    const excerpt = text.length > NEW_WORK_EXCERPT ? `${text.slice(0, NEW_WORK_EXCERPT)}…` : text;
    return [
        `New work started in row ${row.id}. Its first message:`,
        excerpt,
        row.placement === "pending" && !placedByPerson
            ? "Choose its icon now with set_space_icon. If its subject is clear, place it into the section it belongs in with edit_sidebar; if not, leave it and place it once later messages make it clear."
            : "The person already placed it. Choose its icon now with set_space_icon; do not move it.",
    ].join("\n\n");
}

/** Sequential exact-text replacements; each old text must occur exactly once. */
function applyExactEdits(
    text: string,
    edits: readonly { readonly oldText: string; readonly newText: string }[],
): string {
    let html = text;
    for (const edit of edits) {
        const at = html.indexOf(edit.oldText);
        if (edit.oldText.length === 0 || at < 0 || html.indexOf(edit.oldText, at + 1) !== -1)
            throw new SidebarValidationError("Each oldText must occur exactly once.");
        html = html.slice(0, at) + edit.newText + html.slice(at + edit.oldText.length);
    }
    return html;
}

/** What a request asked for, so a retry is told apart from another request under the same ID. */
function sidebarDigest(
    kind: "operations" | "document" | "proposal" | "accept",
    request: unknown,
): string {
    return createHash("sha256")
        .update(JSON.stringify([kind, request]))
        .digest("hex");
}

/** The operations that turn one document into another, refused as the writer's mistake. */
function sidebarDiff(
    current: SpaceSidebarDocument,
    proposed: SpaceSidebarDocument,
    options: { readonly widgets: boolean },
): SpaceSidebarOperation[] {
    try {
        return diffSpaceSidebar(current, proposed, options);
    } catch (error: unknown) {
        if (error instanceof SpaceSidebarError) throw new SidebarValidationError(error.message);
        throw error;
    }
}

/** The node an operation names. */
function sidebarTarget(operation: SpaceSidebarOperation): string {
    return operation.type === "insert" ? operation.node.id : operation.id;
}

/** New work nobody has written in yet: it stays a stem cell until its first message. */
function isUntouchedStemCell(row: SpaceRecord): boolean {
    return row.role === "item" && row.icon?.type === "stem_cell" && row.briefedAt === undefined;
}

function ownerAuthor(ownerUserId: SpaceOwnerId): ArtifactAuthor {
    return {
        kind: "user",
        ...(ownerUserId === SPACE_STANDALONE_OWNER ? {} : { userId: ownerUserId }),
    };
}

function blankDescription(title: string, target: SpaceDescription["target"]): SpaceDescription {
    return {
        title,
        named: true,
        target,
        archived: false,
        working: false,
        lastActivityAt: undefined,
        imageUrl: undefined,
    };
}

function botIcon(bot: BotRecord): SpaceRecord["icon"] {
    return bot.avatar === undefined ? undefined : { type: "image" };
}

function joinedBy(
    members: readonly { readonly userId: string | null }[],
    ownerUserId: SpaceOwnerId,
): boolean {
    const userId = ownerUserId === SPACE_STANDALONE_OWNER ? null : ownerUserId;
    return members.some((member) => member.userId === userId);
}

function surfaceTypeOf(
    type: string,
): "todo" | "document" | "calendar" | "chat" | "reference" | undefined {
    return type === "todo" ||
        type === "document" ||
        type === "calendar" ||
        type === "chat" ||
        type === "reference"
        ? type
        : undefined;
}

function surfaceNeedsContent(type: NonNullable<ReturnType<typeof surfaceTypeOf>>): boolean {
    return type === "todo" || type === "document" || type === "calendar";
}

/** Rows by key; Happy leads because it holds the first key. */
function sortForDisplay(spaces: readonly SpaceRecord[]): SpaceRecord[] {
    return [...spaces].sort(compareRows);
}

/** The default Bots and Tasks headings a fresh sidebar starts with, while nothing is under them. */
function emptyDefaultHeadings(
    items: SpaceSidebarDocument["items"],
): Extract<SpaceSidebarDocument["items"][number], { type: "section" }>[] {
    return items.flatMap((item, index) =>
        item.type === "section" &&
        (item.id === "bots" || item.id === "tasks") &&
        items[index + 1]?.type !== "space"
            ? [item]
            : [],
    );
}

/** A new row as Prioritizing proposes it: `id` is a `new-…` name, or a reserved space ID. */
export interface ProposedNewRow {
    readonly id: string;
    readonly title: string;
    readonly icon: SpaceIconSlug;
    readonly why?: string;
    readonly firstMessage: string;
}

/**
 * A proposal's new rows after Prioritizing's call: a row naming a reserved ID revises it, a
 * `new-…` name reserves a space ID, and `rename` puts those IDs in place of the names in its edits.
 */
function reserveNewRows(
    existing: readonly SidebarProposalNewRow[],
    proposed: readonly ProposedNewRow[],
): {
    readonly rows: SidebarProposalNewRow[];
    readonly reserved: { readonly name: string; readonly id: string }[];
    readonly changed: boolean;
    rename(text: string): string;
} {
    const rows = [...existing];
    const reserved: { name: string; id: string }[] = [];
    let changed = false;
    for (const row of proposed) {
        const { id: name, ...fields } = row;
        const at = rows.findIndex((each) => each.id === name);
        if (at >= 0) {
            const next = { ...rows[at]!, ...fields };
            if (JSON.stringify(next) !== JSON.stringify(rows[at])) changed = true;
            rows[at] = next;
            continue;
        }
        if (!/^new-[a-z0-9-]{1,60}$/u.test(name))
            throw new SidebarValidationError(
                `New row ${name} needs a name like new-release-ci, or the space ID it was given.`,
            );
        if (reserved.some((each) => each.name === name))
            throw new SidebarValidationError(`New row ${name} is named twice.`);
        const id = createId();
        reserved.push({ name, id });
        rows.push({ id, ...fields });
        changed = true;
    }
    if (rows.length > 16)
        throw new SidebarValidationError("A proposal offers at most 16 new rows.");
    return {
        rows,
        reserved,
        changed,
        rename: (text) =>
            reserved.reduce(
                (current, { name, id }) => current.replaceAll(`id="${name}"`, `id="${id}"`),
                text,
            ),
    };
}

/** A chat accepting a proposal started, as a press reports it. */
export interface SpaceStartedChat {
    readonly spaceId: string;
    readonly agentId: string;
    readonly title: string;
    /** The section it stands under, when one heads it. */
    readonly section?: string;
}
