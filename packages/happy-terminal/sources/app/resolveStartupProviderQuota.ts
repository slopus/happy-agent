export const STARTUP_PROVIDER_QUOTA_BUDGET_MS = 200;

/** Startup shows quota only when the probe answers within its budget; it never blocks. */
export async function resolveStartupProviderQuota<T>(
    load: () => Promise<T>,
    budgetMs = STARTUP_PROVIDER_QUOTA_BUDGET_MS,
): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, budgetMs));
        timer.unref?.();
    });
    const loading = load().catch(() => undefined);
    return Promise.race([loading, unavailable]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}
