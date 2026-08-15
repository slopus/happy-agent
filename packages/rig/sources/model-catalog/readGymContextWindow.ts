export function readGymContextWindow(env: NodeJS.ProcessEnv): number | undefined {
    const raw = env.RIG_GYM_CONTEXT_WINDOW;
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
