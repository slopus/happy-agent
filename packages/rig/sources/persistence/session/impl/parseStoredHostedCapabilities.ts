import { parseHostedCapabilities, type HostedCapability } from "@slopus/rig-execution";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const storedHostedCapabilitiesSchema = Type.Array(Type.String());

export function parseStoredHostedCapabilities(
    value: string | undefined,
): readonly HostedCapability[] | undefined {
    if (value === undefined) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (!Value.Check(storedHostedCapabilitiesSchema, parsed)) {
        throw new Error("The stored session hosted capabilities must be a list of names.");
    }
    const capabilities = parseHostedCapabilities(parsed);
    return capabilities.length === 0 ? undefined : capabilities;
}
