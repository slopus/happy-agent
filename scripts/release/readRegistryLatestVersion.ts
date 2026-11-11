import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const RegistryLatestVersion = Type.Union([Type.String(), Type.Tuple([Type.String()])]);

export function readRegistryLatestVersion(json: string): string {
    const result: unknown = JSON.parse(json);
    if (!Value.Check(RegistryLatestVersion, result)) {
        throw new Error("Expected npm latest to be a version string or a single-result array.");
    }
    return typeof result === "string" ? result : result[0];
}
