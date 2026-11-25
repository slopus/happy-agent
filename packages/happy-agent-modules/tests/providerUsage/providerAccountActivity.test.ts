import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAgentSQLiteDatabase, withAgentDatabase } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    ConfigModule,
    type ProviderLoginChange,
    type ProviderLoginTimes,
} from "../../sources/config/index.js";
import {
    PROVIDER_LAST_USED_INTERVAL_MS,
    ProviderUsageModule,
    type ProviderUsageEntry,
} from "../../sources/providerUsage/index.js";
import { providerAccountActivityMigrations } from "../../sources/providerUsage/persistence/accountActivity.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/**
 * One installation: a real configuration and database, with its vendor logins, served responses,
 * and renewal outcomes scripted. `restart` starts a new module over the same database.
 */
async function createInstallation() {
    const root = await mkdtemp(join(tmpdir(), "provider-account-activity-"));
    const owner = await openAgentSQLiteDatabase(join(root, "agent.sqlite"));
    cleanups.push(async () => {
        await owner.close();
        await rm(root, { recursive: true, force: true });
    });
    const migrate = withAgentDatabase(createRootContext(), owner.database);
    for (const [, migration] of providerAccountActivityMigrations) {
        await migration(migrate, owner.database);
    }

    const logins = new Map<string, ProviderLoginTimes | null>();
    let served: ((providerId: string) => void) | undefined;
    let loginChanged: ((providerId: string, change: ProviderLoginChange) => void) | undefined;

    const start = async () => {
        const config = await ConfigModule.load(join(root, ".happy"));
        vi.spyOn(config, "hasProviderUsageSource").mockReturnValue(false);
        vi.spyOn(config, "readProviderUsage").mockResolvedValue(null);
        vi.spyOn(config, "providerLogin").mockImplementation(async (providerId) =>
            providerId === "bedrock" ? undefined : (logins.get(providerId) ?? null),
        );
        vi.spyOn(config, "onProviderAccountServed").mockImplementation((listener) => {
            served = listener;
            return () => undefined;
        });
        vi.spyOn(config, "onProviderLoginChanged").mockImplementation((listener) => {
            loginChanged = listener;
            return () => undefined;
        });
        const module = new ProviderUsageModule(config);
        const events: ProviderUsageEntry[] = [];
        module.onChanged((entry) => events.push(entry));
        const ctx: Context = withAgentDatabase(
            createRootContext().named("provider-account-activity-test"),
            owner.database,
        );
        await module.beforeStart(ctx);
        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            await module.close();
        };
        cleanups.push(close);
        return {
            module,
            events,
            close,
            entry: (providerId: string) =>
                module.list().find((entry) => entry.providerId === providerId),
        };
    };

    return {
        logins,
        start,
        serve: (providerId: string) => served?.(providerId),
        changeLogin: (providerId: string, change: ProviderLoginChange) =>
            loginChanged?.(providerId, change),
    };
}

/** Let queued activity changes finish without moving any faked clock. */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn++) await new Promise((done) => setImmediate(done));
}

describe("provider account activity", () => {
    it("reads each account's login at startup and gives other accounts none", async () => {
        const installation = await createInstallation();
        installation.logins.set("codex", { refreshedAt: 1_000, expiresAt: 9_000 });
        const daemon = await installation.start();

        expect(daemon.entry("codex")).toMatchObject({
            lastUsedAt: null,
            login: { refreshedAt: 1_000, expiresAt: 9_000, refreshError: null },
        });
        expect(daemon.entry("claude")).toMatchObject({ lastUsedAt: null, login: null });
        const bedrock = daemon.entry("bedrock");
        expect(bedrock).toBeDefined();
        expect(bedrock).not.toHaveProperty("lastUsedAt");
        expect(bedrock).not.toHaveProperty("login");
    });

    it("announces use at most once a minute, and the latest use when the minute ends", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(1_000_000);
        const installation = await createInstallation();
        const daemon = await installation.start();
        daemon.events.length = 0;

        installation.serve("codex");
        await settle();
        expect(daemon.events.map((entry) => entry.lastUsedAt)).toEqual([1_000_000]);

        vi.setSystemTime(1_010_000);
        installation.serve("codex");
        vi.setSystemTime(1_020_000);
        installation.serve("codex");
        installation.serve("bedrock");
        await settle();
        expect(daemon.events).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(PROVIDER_LAST_USED_INTERVAL_MS);
        await settle();
        expect(daemon.events.map((entry) => entry.lastUsedAt)).toEqual([1_000_000, 1_020_000]);
        expect(daemon.entry("codex")?.lastUsedAt).toBe(1_020_000);
    });

    it("keeps a failure streak's start and remembers it and the last use across a restart", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(5_000_000);
        const installation = await createInstallation();
        installation.logins.set("codex", { refreshedAt: 1_000, expiresAt: 9_000 });
        const first = await installation.start();
        installation.serve("codex");
        installation.changeLogin("codex", {
            kind: "refresh_failed",
            status: 503,
            code: "server_error",
            permanent: false,
        });
        await settle();
        vi.setSystemTime(6_000_000);
        installation.changeLogin("codex", {
            kind: "refresh_failed",
            status: 401,
            code: "refresh_token_reused",
            permanent: true,
        });
        await settle();
        const failed = {
            refreshedAt: 1_000,
            expiresAt: 9_000,
            refreshError: {
                status: 401,
                code: "refresh_token_reused",
                permanent: true,
                since: 5_000_000,
                at: 6_000_000,
            },
        };
        expect(first.entry("codex")).toMatchObject({ lastUsedAt: 5_000_000, login: failed });

        await first.close();
        const second = await installation.start();
        expect(second.entry("codex")).toMatchObject({ lastUsedAt: 5_000_000, login: failed });

        installation.changeLogin("codex", { kind: "signed_in" });
        await settle();
        expect(second.entry("codex")?.login?.refreshError).toBeNull();
        await second.close();
        const third = await installation.start();
        expect(third.entry("codex")?.login?.refreshError).toBeNull();
        expect(third.entry("codex")?.lastUsedAt).toBe(5_000_000);
    });

    it("ends a failure streak when the login was renewed elsewhere since", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(5_000_000);
        const installation = await createInstallation();
        installation.logins.set("grok", { refreshedAt: 1_000, expiresAt: 9_000 });
        const daemon = await installation.start();
        installation.changeLogin("grok", {
            kind: "refresh_failed",
            status: null,
            code: null,
            permanent: false,
        });
        await settle();
        expect(daemon.entry("grok")?.login?.refreshError).toEqual({
            status: null,
            code: null,
            permanent: false,
            since: 5_000_000,
            at: 5_000_000,
        });

        // The vendor's own program renewed the login; the next use reads it again.
        installation.logins.set("grok", { refreshedAt: 5_500_000, expiresAt: 99_000_000 });
        vi.setSystemTime(5_600_000);
        installation.serve("grok");
        await settle();

        expect(daemon.entry("grok")).toMatchObject({
            lastUsedAt: 5_600_000,
            login: { refreshedAt: 5_500_000, expiresAt: 99_000_000, refreshError: null },
        });
    });

    it("remembers a use that was still waiting for its minute when the daemon stops", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(1_000_000);
        const installation = await createInstallation();
        const first = await installation.start();
        installation.serve("claude");
        await settle();
        vi.setSystemTime(1_030_000);
        installation.serve("claude");
        await first.close();

        const second = await installation.start();
        expect(second.entry("claude")?.lastUsedAt).toBe(1_030_000);
    });
});
