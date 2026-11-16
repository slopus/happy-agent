import type { HappyLink } from "@slopus/happy-agent-client";

/**
 * Whether a link someone wrote names this installation: a `happy://` link without an instance, or
 * an instance link or share link naming this one. A link to another installation names nothing
 * here. `instanceId` is the config module's `loadedInstanceId`.
 */
export function isHappyLinkHere(instanceId: string | undefined, link: HappyLink): boolean {
    return link.instanceId === undefined || link.instanceId === instanceId;
}
