import { type PlatformKey } from "./platform.js";
import { resolveBinaryForTarget } from "./impl/resolveBinaryForTarget.js";

export function resolveSupervisorBinary(binaryPath?: string): string {
    const key = `${process.platform}-${process.arch}` as PlatformKey;
    if (
        key !== "darwin-arm64" &&
        key !== "darwin-x64" &&
        key !== "linux-arm64" &&
        key !== "linux-x64" &&
        key !== "win32-x64"
    ) {
        throw new Error(
            `The Happy agent supervisor does not support ${process.platform} ${process.arch}.`,
        );
    }
    return resolveBinaryForTarget(key, binaryPath);
}
