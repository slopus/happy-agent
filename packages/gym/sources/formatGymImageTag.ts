export function formatGymImageTag(runtimeFingerprint: string): string {
    const id = runtimeFingerprint
        .trim()
        .replaceAll(/[^a-fA-F0-9]/gu, "")
        .slice(0, 16);
    if (id.length < 12) throw new Error("Gym runtime fingerprint must contain a hash.");
    return `happy-terminal-gym:runtime-${id}`;
}
