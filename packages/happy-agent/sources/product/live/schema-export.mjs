// Capture private original transport data without editing its reference source.
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import { LiveProviderEventSchema } from "../../../../happy-agent-modules/sources/live/impl/liveProviderTransport.ts";
import { Type } from "@sinclair/typebox";
import {
    liveSessionCreatedPayloadSchema,
    liveSessionUpdatedPayloadSchema,
} from "@slopus/happy-agent-client";
const transport = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/live/impl/liveProviderTransport.ts",
        import.meta.url,
    ),
    [
        "Credential",
        "Input",
        "Append",
        "Envelope",
        "Id",
        "Ready",
        "PublicAnswer",
        "PublicTranscript",
        "NativeTranscript",
        "PublicDelegation",
        "NativeDelegation",
        "Usage",
        "Closed",
        "ProviderError",
    ],
);
const persistence = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/live/persistence/liveSessions.ts",
        import.meta.url,
    ),
    ["storedSchema"],
);
export const liveSchemas = {
    // LiveModule.ts exports this exact structural event union as a type only.
    ownerLiveEvent: Type.Union([
        Type.Object({
            ownerId: Type.String(),
            type: Type.Literal("live.session.created"),
            payload: liveSessionCreatedPayloadSchema,
        }),
        Type.Object({
            ownerId: Type.String(),
            type: Type.Literal("live.session.updated"),
            payload: liveSessionUpdatedPayloadSchema,
        }),
    ]),
    ownerLiveStored: persistence.storedSchema,
    ownerLiveProviderCredential: transport.Credential,
    ownerLiveProviderInput: transport.Input,
    ownerLiveProviderAppend: transport.Append,
    ownerLiveProviderEnvelope: transport.Envelope,
    ownerLiveProviderId: transport.Id,
    ownerLiveProviderReady: transport.Ready,
    ownerLiveProviderPublicAnswer: transport.PublicAnswer,
    ownerLiveProviderPublicTranscript: transport.PublicTranscript,
    ownerLiveProviderNativeTranscript: transport.NativeTranscript,
    ownerLiveProviderPublicDelegation: transport.PublicDelegation,
    ownerLiveProviderNativeDelegation: transport.NativeDelegation,
    ownerLiveProviderUsage: transport.Usage,
    ownerLiveProviderClosed: transport.Closed,
    ownerLiveProviderError: transport.ProviderError,
    ownerLiveProviderEvent: LiveProviderEventSchema,
};
