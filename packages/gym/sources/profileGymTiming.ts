export function profileGymTiming(id: string, phase: string, startedAt: number): void {
    if (process.env.HAPPY_TERMINAL_GYM_PROFILE !== "1") return;
    process.stderr.write(
        `[gym-profile] ${id} ${phase} ${(performance.now() - startedAt).toFixed(1)}ms\n`,
    );
}
