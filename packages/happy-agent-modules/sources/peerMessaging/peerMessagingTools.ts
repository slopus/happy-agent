import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { peerConnectionSchema, peerNodeIdSchema } from "../config/index.js";
import {
    peerAcceptedSchema,
    peerCheckSchema,
    peerDebugSchema,
    peerMutationAcceptedSchema,
} from "./PeerProtocol.js";
import type { PeerMessagingModule } from "./PeerMessagingModule.js";
import { stableId } from "./stableId.js";

/** Fixed common tool arrays; authority is checked again in each public operation. */
export function peerMessagingTools(
    module: PeerMessagingModule,
    agentId: string,
    admin: boolean,
    enabled: boolean,
) {
    const toLLM = (result: unknown) => [{ type: "text" as const, text: JSON.stringify(result) }];
    const administration = [
        defineAgentTool({
            name: "configure_peer_messaging",
            defer: true,
            capabilities: ["Configure this installation's peer messaging listener and identity."],
            searchKeywords: [
                "configure peer messaging",
                "peer listener",
                "node identity",
                "WebSocket server",
            ],
            description:
                "Enable or disable peer messaging. Set listen=true only on the reachable node that accepts incoming WebSocket sessions; listen defaults false so a desktop can connect outward without binding a port. Supply a stable node_id. Listener default host is 127.0.0.1 and port is 24780. Durably admits settings; poll debug_peer_connections to confirm application. Only active admin bots may configure it. Configure the other installation through independently authorized administration access.",
            parameters: Type.Object(
                {
                    enabled: Type.Boolean(),
                    listen: Type.Optional(Type.Boolean()),
                    node_id: Type.Optional(peerNodeIdSchema),
                    host: Type.Optional(
                        Type.String({
                            minLength: 1,
                            maxLength: 253,
                            pattern: "^[A-Za-z0-9.:%_-]+$",
                        }),
                    ),
                    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
                },
                { additionalProperties: false },
            ),
            returnType: peerMutationAcceptedSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => true,
            describeAutoPermissionAction: () =>
                "changing private machine settings, including optionally exposing or closing a separate WebSocket listener for authenticated peer messages",
            execute: async (ctx, args) => await module.configure(ctx, agentId, args),
            toLLM,
        }),
        defineAgentTool({
            name: "set_peer_connection",
            defer: true,
            capabilities: [
                "Connect a known remote installation for bidirectional agent messaging.",
            ],
            searchKeywords: [
                "add peer",
                "connect remote installation",
                "pair nodes",
                "shared peer token",
            ],
            description:
                "Register or replace a known peer with shared 43-character base64url token. On the initiating node use role=connect and its peer's ws:// or wss:// origin. On the listener use role=accept with only the token; no reverse URL is needed. One persistent session supports messages in both directions. Pair tokens must match and be unique per peer; never repeat tokens in output. Durably admits settings; poll debug_peer_connections. Only active admin bots may use this tool.",
            parameters: Type.Object(
                { node_id: peerNodeIdSchema, connection: peerConnectionSchema },
                { additionalProperties: false },
            ),
            returnType: peerMutationAcceptedSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => true,
            describeAutoPermissionAction: () =>
                "saving private shared credentials and granting a remote installation agent-message authority",
            execute: async (ctx, args) =>
                await module.setPeer(ctx, agentId, args.node_id, args.connection),
            toLLM,
        }),
        defineAgentTool({
            name: "remove_peer_connection",
            defer: true,
            capabilities: ["Disable a configured peer and revoke its messaging authority."],
            searchKeywords: ["remove peer", "disconnect node", "revoke peer token"],
            description:
                "Durably admit disabling a peer in this installation's generated runtime settings, revoking its inbound messaging token and outbound route. Inspect debug_peer_connections to confirm application. Does not alter the remote installation. Only active admin bots may use this tool.",
            parameters: Type.Object({ node_id: peerNodeIdSchema }, { additionalProperties: false }),
            returnType: peerMutationAcceptedSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => true,
            describeAutoPermissionAction: () =>
                "revoking a configured peer's messaging authority in private machine settings",
            execute: async (ctx, args) =>
                await module.setPeer(ctx, agentId, args.node_id, { enabled: false }),
            toLLM,
        }),
        defineAgentTool({
            name: "check_peer_connection",
            defer: true,
            capabilities: ["Check whether a configured peer messaging connection is ready."],
            searchKeywords: ["ping peer", "peer health", "check remote node connection"],
            description:
                "Ping a known peer over its existing authenticated WebSocket session. Both connector and listener use that same connection; this never opens a reverse connection. Returns bounded credential-free readiness diagnostics. Only active admin bots may use this tool.",
            parameters: Type.Object({ node_id: peerNodeIdSchema }, { additionalProperties: false }),
            returnType: peerCheckSchema,
            durable: false,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () =>
                "contacting the configured remote peer outside the workspace sandbox with its shared credential",
            execute: async (ctx, args) => await module.check(ctx, agentId, args.node_id),
            toLLM,
        }),
        defineAgentTool({
            name: "debug_peer_connections",
            defer: true,
            capabilities: ["Inspect local peer configuration, session status, and diagnostics."],
            searchKeywords: [
                "debug peers",
                "peer connection status",
                "peer diagnostics",
                "listener status",
            ],
            description:
                "Inspect local peer listener state, configured peer endpoints, and last health or send diagnostics. Does not contact peers or return tokens or message content. Only active admin bots may use this tool.",
            parameters: Type.Object({}, { additionalProperties: false }),
            returnType: peerDebugSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            autoReview: "never",
            execute: async (ctx) => await module.debug(ctx, agentId),
            toLLM,
        }),
    ];
    const messaging = [
        defineAgentTool({
            name: "send_peer_agent_message",
            defer: true,
            capabilities: ["Send messages to known agents on configured peer installations."],
            searchKeywords: ["remote agent message", "peer node", "P2P messaging"],
            description:
                "Send text to a known Agent ID on a configured peer node. Both node_id and to_agent_id must already be shared; there is no discovery. This runs outside the local workspace boundary and can start work on the remote installation. Returns only durable inbox admission, not a reply or task completion. A reply arrives separately. A missing acknowledgment may mean delivery occurred; do not automatically retry. To deliberately repeat the same delivery, reuse its message_id.",
            parameters: Type.Object(
                {
                    node_id: peerNodeIdSchema,
                    to_agent_id: cuid2Schema,
                    text: Type.String({ minLength: 1, maxLength: 16384 }),
                    message_id: Type.Optional(cuid2Schema),
                },
                { additionalProperties: false },
            ),
            returnType: peerAcceptedSchema,
            durable: false,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: (args) =>
                `sending an agent message to node ${args.node_id}, agent ${args.to_agent_id}, where it can trigger remote work outside the workspace sandbox`,
            execute: async (ctx, args, call) =>
                await module.send(
                    ctx,
                    agentId,
                    args.node_id,
                    args.to_agent_id,
                    args.text,
                    args.message_id ?? stableId(`${agentId}\0${call.id}`),
                ),
            toLLM,
        }),
    ];
    return [...(admin ? administration : []), ...(enabled ? messaging : [])];
}
