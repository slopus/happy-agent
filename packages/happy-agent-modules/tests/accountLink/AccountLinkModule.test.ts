import { readFile, stat } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    createAccountLinkWorld,
    removeAccountLinkWorlds,
    type AccountLinkWorld,
} from "./support/accountLinkWorld.js";
import { FakeAccounts } from "./support/fakeAccounts.js";

const OWNER = "11111111-1111-4111-8111-111111111111";

let accounts: FakeAccounts;
const worlds: AccountLinkWorld[] = [];

beforeEach(async () => {
    accounts = await FakeAccounts.start();
});

afterEach(async () => {
    await Promise.all(worlds.splice(0).map((world) => world.close()));
    await accounts.close();
    await removeAccountLinkWorlds();
});

async function world(
    options: Parameters<typeof createAccountLinkWorld>[0] = {},
): Promise<AccountLinkWorld> {
    const created = await createAccountLinkWorld({
        accountsUrl: accounts.url,
        relayUrl: accounts.relayUrl,
        ...options,
    });
    worlds.push(created);
    return created;
}

async function link(target: AccountLinkWorld): Promise<string> {
    const started = await target.run("link_happy_account");
    if (started.state !== "linking") throw new Error("Linking did not start.");
    accounts.approve(started.userCode, OWNER);
    const linked = await target.waitFor((status) => status.state === "linked");
    if (linked.state !== "linked") throw new Error("Unreachable.");
    return linked.endpointId;
}

describe("AccountLinkModule tools", () => {
    it("offers its tools only to active admin bots and rechecks the caller on execution", async () => {
        const target = await world();

        await expect(target.toolNames("admin-agent")).resolves.toEqual([
            "link_happy_account",
            "get_happy_account_status",
            "set_happy_account_reachable",
            "unlink_happy_account",
        ]);
        await expect(target.toolNames("ordinary-agent")).resolves.toEqual([]);
        await expect(target.toolNames("archived-admin-agent")).resolves.toEqual([]);
        await expect(target.toolNames("human-agent")).resolves.toEqual([]);

        const refusal = "Only an active admin bot can manage the Happy account link.";
        await expect(target.module.startLink(target.ctx, "ordinary-agent")).rejects.toThrow(
            refusal,
        );
        await expect(
            target.module.setReachable(target.ctx, "archived-admin-agent", true),
        ).rejects.toThrow(refusal);
        await expect(target.module.unlink(target.ctx, "human-agent")).rejects.toThrow(refusal);
        await expect(target.module.getStatus(target.ctx, "ordinary-agent")).rejects.toThrow(
            "Only an active admin bot can inspect the Happy account link.",
        );
        expect(accounts.requests).toEqual([]);
    });

    it("offers nothing and contacts nobody when the feature is not configured", async () => {
        const target = await createAccountLinkWorld();
        worlds.push(target);

        await expect(target.toolNames("admin-agent")).resolves.toEqual([]);
        expect(target.module.currentStatus()).toEqual({
            reason: "Happy account linking is not configured on this computer.",
            state: "unavailable",
        });
        await expect(target.module.startLink(target.ctx, "admin-agent")).rejects.toThrow(
            "Happy account linking is not configured on this computer.",
        );
    });

    it("refuses to link a team server", async () => {
        const target = await world({ team: true });

        await expect(target.run("link_happy_account")).rejects.toThrow(
            "A team server cannot be linked to a personal Happy account.",
        );
        expect(accounts.requests).toEqual([]);
    });

    it("reviews every change in Auto and never the status read", async () => {
        const target = await world();
        const review = async (name: string, input: unknown) => {
            const tool = await target.tool("admin-agent", name);
            const context = undefined as never;
            return {
                elevated:
                    (await tool.shouldRunInFullAccessInAutoMode?.(input as never, context)) ??
                    false,
                requiresAuto: tool.requiresAutoOrFullAccess === true,
                reviewed: await tool.shouldReviewInAutoMode(input as never, context),
            };
        };
        const gated = { elevated: true, requiresAuto: true, reviewed: true };

        await expect(review("link_happy_account", {})).resolves.toEqual(gated);
        await expect(review("set_happy_account_reachable", { reachable: true })).resolves.toEqual(
            gated,
        );
        await expect(review("set_happy_account_reachable", { reachable: false })).resolves.toEqual(
            gated,
        );
        await expect(review("unlink_happy_account", {})).resolves.toEqual(gated);
        await expect(review("get_happy_account_status", {})).resolves.toEqual({
            elevated: false,
            requiresAuto: false,
            reviewed: false,
        });
        const reachable = await target.tool("admin-agent", "set_happy_account_reachable");
        expect(
            await reachable.describeAutoPermissionAction?.(
                { reachable: true } as never,
                undefined as never,
            ),
        ).toBe(
            "opening this Happy Agent API to its linked Happy account through the Happy Relay on the internet",
        );
    });
});

describe("AccountLinkModule linking", () => {
    it("shows one code until it is approved, then stores the owner and an unreachable link", async () => {
        const target = await world();

        const started = await target.run("link_happy_account");
        expect(started).toMatchObject({ state: "linking" });
        if (started.state !== "linking") return;
        expect(started.verificationUrl).toBe(
            `${accounts.url}/device?user_code=${started.userCode}`,
        );
        expect(accounts.grant(started.userCode)).toMatchObject({
            name: "Test Workstation",
            platform: process.platform === "darwin" ? "macos" : "linux",
        });
        await expect(target.run("link_happy_account")).resolves.toEqual(started);
        expect(accounts.pendingUserCodes).toEqual([started.userCode]);
        await expect(readFile(target.credentialsPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });

        accounts.approve(started.userCode, OWNER);
        const linked = await target.waitFor((status) => status.state === "linked");

        const endpoint = accounts.endpoints[0];
        expect(linked).toEqual({
            accountId: OWNER,
            endpointId: endpoint?.id,
            reachable: false,
            relay: "off",
            state: "linked",
        });
        const stored = JSON.parse(await readFile(target.credentialsPath, "utf8")) as object;
        expect(stored).toMatchObject({
            accountId: OWNER,
            accountsUrl: accounts.url,
            endpointId: endpoint?.id,
            reachable: false,
            refreshToken: endpoint?.liveRefresh,
        });
        expect((await stat(target.credentialsPath)).mode & 0o777).toBe(0o600);
        await expect(target.run("link_happy_account")).rejects.toThrow(
            "This computer is already linked to a Happy account.",
        );
    });

    it("stays unlinked and says why when the person refuses the code", async () => {
        const target = await world();
        const started = await target.run("link_happy_account");
        if (started.state !== "linking") throw new Error("Linking did not start.");

        accounts.deny(started.userCode);

        await expect(target.waitFor((status) => status.state === "unlinked")).resolves.toEqual({
            error: "The link was refused in the browser.",
            state: "unlinked",
        });
        await expect(readFile(target.credentialsPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("refuses to become reachable before it is linked", async () => {
        const target = await world();

        await expect(
            target.run("set_happy_account_reachable", { reachable: true }),
        ).rejects.toThrow("Link this computer to a Happy account before making it reachable.");
    });

    it("cancels a waiting code on unlink so a late approval links nothing", async () => {
        const target = await world();
        const started = await target.run("link_happy_account");
        if (started.state !== "linking") throw new Error("Linking did not start.");

        await expect(target.run("unlink_happy_account")).resolves.toEqual({ state: "unlinked" });
        accounts.approve(started.userCode, OWNER);
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        expect(target.module.currentStatus()).toEqual({ state: "unlinked" });
        expect(accounts.endpoints).toEqual([]);
    });
});

describe("AccountLinkModule credentials", () => {
    it("revokes the credential at accounts and deletes the stored one on unlink", async () => {
        const target = await world();
        const endpointId = await link(target);

        await expect(target.run("unlink_happy_account")).resolves.toEqual({ state: "unlinked" });

        expect(accounts.endpoint(endpointId).revoked).toBe(true);
        await expect(readFile(target.credentialsPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("unlinks locally and says so when accounts cannot be reached", async () => {
        const target = await world();
        await link(target);
        await accounts.close();

        const status = await target.run("unlink_happy_account");

        expect(status).toEqual({
            error: "This computer is unlinked, but Happy accounts could not be told. Remove it from the account's devices.",
            state: "unlinked",
        });
        await expect(readFile(target.credentialsPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
        accounts = await FakeAccounts.start();
    });

    it("keeps the link across a restart and rotates the refresh token each time it is used", async () => {
        // Shorter than the refresh margin, so every use of the endpoint token refreshes it.
        accounts.accessTtlSeconds = 30;
        const first = await world();
        const endpointId = await link(first);
        const issued = accounts.endpoint(endpointId).liveRefresh;
        await first.close();

        const second = await world({ root: first.root });
        expect(second.module.currentStatus()).toMatchObject({ endpointId, state: "linked" });
        await second.run("set_happy_account_reachable", { reachable: false });
        const rotated = accounts.endpoint(endpointId).liveRefresh;
        expect(rotated).not.toBe(issued);
        expect(JSON.parse(await readFile(second.credentialsPath, "utf8"))).toMatchObject({
            refreshToken: rotated,
        });
        await second.close();

        const third = await world({ root: first.root });
        await expect(third.run("unlink_happy_account")).resolves.toEqual({ state: "unlinked" });
        expect(accounts.endpoint(endpointId).revoked).toBe(true);
        expect(accounts.requests.filter((entry) => entry === "POST /token").length).toBeGreaterThan(
            2,
        );
    });

    it("becomes unlinked when the owner removed the computer from the account", async () => {
        accounts.accessTtlSeconds = 30;
        const target = await world();
        const endpointId = await link(target);
        accounts.revoke(endpointId);

        await target
            .run("set_happy_account_reachable", { reachable: false })
            .catch(() => undefined);

        expect(target.module.currentStatus()).toEqual({
            error: "Happy accounts no longer recognizes this computer. Link it again.",
            state: "unlinked",
        });
        await expect(readFile(target.credentialsPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("never sends a stored credential to a different accounts service", async () => {
        const first = await world();
        await link(first);
        await first.close();
        const other = await FakeAccounts.start();
        try {
            const moved = await world({ accountsUrl: other.url, root: first.root });

            expect(moved.module.currentStatus()).toEqual({
                error: "This computer was linked through a different Happy accounts service. Link it again.",
                state: "unlinked",
            });
            await expect(moved.run("unlink_happy_account")).resolves.toEqual({ state: "unlinked" });
            expect(other.requests).toEqual([]);
            await expect(readFile(moved.credentialsPath, "utf8")).rejects.toMatchObject({
                code: "ENOENT",
            });
        } finally {
            await other.close();
        }
    });
});
