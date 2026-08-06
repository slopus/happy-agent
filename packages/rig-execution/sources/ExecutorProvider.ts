import type { BaseProvider } from "@slopus/rig-providers";

import type { ExecutorModelProfile } from "@/ExecutorModelProfile.js";
import type { HostedCapability } from "@/HostedCapability.js";
import type { ProfilePromptContext, ServiceTier } from "@/types.js";
import type { ExecutorImageGeneration } from "@/ExecutorImageGeneration.js";

export interface ExecutorProvider {
    destroy?(): Promise<void> | void;
    extendProfilePromptContext?: (
        context: ProfilePromptContext,
    ) => ProfilePromptContext | Promise<ProfilePromptContext>;
    /**
     * Which provider-run searches this definition would declare on a request built right now.
     *
     * The answer belongs to the definition rather than to whoever asks, because it depends on the
     * permission mode at the moment of asking and that changes underneath a live session. A
     * definition whose backend runs no search of its own leaves this out.
     */
    hostedCapabilitiesForRequest?: () => readonly HostedCapability[];
    id: string;
    imageGeneration?: ExecutorImageGeneration;
    /**
     * This definition as it may be lent to an isolate, when that differs.
     *
     * An isolate is a side channel: an auxiliary query the person never asked for and never sees.
     * A provider-run capability is not Rig's to lend into one, because Rig cannot intercept, show,
     * or account for what it does. A definition that has none needs nothing here.
     */
    isolated?: () => ExecutorProvider;
    native: BaseProvider | ((profile: ExecutorModelProfile) => Promise<BaseProvider>);
    nativeKey?: (profile: ExecutorModelProfile) => string;
    profiles: readonly ExecutorModelProfile[];
    serviceTiers?: readonly ServiceTier[];
    sessionId?: string;
}
