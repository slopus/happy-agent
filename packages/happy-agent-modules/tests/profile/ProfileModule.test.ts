import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    PROFILE_MIGRATION_KEY,
    PROFILE_PHOTO_MIGRATION_KEY,
} from "../../sources/profile/ProfileModule.js";
import {
    profileChangedEventSchema,
    profilePhotoAssetSchema,
    profileSchema,
    profileVersionSchema,
    type ProfileChangedEvent,
} from "../../sources/profile/ProfileTypes.js";
import { ProfileVersionConflictError } from "../../sources/profile/ProfileVersionConflictError.js";
import { MAX_PROFILE_PHOTO_BYTES } from "../../sources/profile/normalizeProfilePhoto.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { testProfileModule } from "../support/testProfileModule.js";

const LOCAL_INSTANCE_ID = "alocalinstance000000001";
const OTHER_INSTANCE_ID = "anotherinstance00000001";

async function createFixture(name: string) {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: ProfileChangedEvent[] = [];
    const profiles = testProfileModule();
    const unsubscribe = profiles.onEvent((_ctx, event) => {
        events.push(event);
    });
    const test = moduleDatabase(profiles.migrations, name);
    await test.ready;
    await profiles.open(test.context, LOCAL_INSTANCE_ID);
    return { events, profiles, test, unsubscribe };
}

async function png(
    red: number,
    green: number,
    blue: number,
    width = 80,
    height = 50,
): Promise<Buffer> {
    return await sharp({
        create: {
            background: { alpha: 0.75, b: blue, g: green, r: red },
            channels: 4,
            height,
            width,
        },
    })
        .png()
        .toBuffer();
}

describe("ProfileModule", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("appends photo storage without changing the released profile migration", async () => {
        const fixture = await createFixture("profile-migrations");
        try {
            expect(fixture.profiles.migrations.map(([key]) => key)).toEqual([
                PROFILE_MIGRATION_KEY,
                PROFILE_PHOTO_MIGRATION_KEY,
            ]);
        } finally {
            fixture.test.close();
        }
    });

    it("materializes one stable empty singleton without reporting a user-visible update", async () => {
        const fixture = await createFixture("profile-empty");
        const ctx = fixture.test.context;
        try {
            await expect(fixture.profiles.get(ctx)).resolves.toBeUndefined();
            const profile = await fixture.profiles.ensure(ctx);
            expect(Value.Check(profileSchema, profile)).toBe(true);
            expect(profile).toMatchObject({
                createdAt: 1_000,
                email: null,
                name: null,
                parentInstanceId: LOCAL_INSTANCE_ID,
                photo: null,
                updatedAt: 1_000,
            });
            expect(Value.Check(profileVersionSchema, profile.version)).toBe(true);
            await expect(fixture.profiles.ensure(ctx)).resolves.toEqual(profile);
            await expect(fixture.profiles.getById(ctx, profile.id)).resolves.toEqual(profile);
            await expect(fixture.profiles.isLocal(ctx, profile.id)).resolves.toBe(true);
            expect(fixture.events).toEqual([]);
        } finally {
            fixture.test.close();
        }
    });

    it("can create the complete P2P identity once and emits its UUIDv7 creation", async () => {
        const fixture = await createFixture("profile-create");
        const ctx = fixture.test.context;
        try {
            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });
            expect(profile.photo).toBeNull();
            expect(Value.Check(profileVersionSchema, profile.version)).toBe(true);
            expect(fixture.events).toEqual([
                {
                    createdAt: 1_000,
                    data: {
                        previousVersion: null,
                        profileId: profile.id,
                        version: profile.version,
                    },
                    id: profile.version,
                    type: "profile_changed",
                },
            ]);
            await expect(
                fixture.profiles.create(ctx, { email: "other@example.test", name: "Other" }),
            ).rejects.toThrow("This installation already has a profile.");
        } finally {
            fixture.test.close();
        }
    });

    it("updates and clears nullable metadata with atomic expected-version checks", async () => {
        const fixture = await createFixture("profile-update-clear");
        const ctx = fixture.test.context;
        try {
            const original = await fixture.profiles.ensure(ctx);
            vi.setSystemTime(2_000);
            const named = await fixture.profiles.update(
                ctx,
                original.id,
                { email: "steve@example.test", name: "Steve" },
                { expectedVersion: original.version },
            );
            expect(named).toBeDefined();
            expect(named!.version > original.version).toBe(true);
            expect(named).toMatchObject({
                email: "steve@example.test",
                name: "Steve",
                updatedAt: 2_000,
            });

            await expect(
                fixture.profiles.update(
                    ctx,
                    original.id,
                    { name: "Stale" },
                    { expectedVersion: original.version },
                ),
            ).rejects.toMatchObject({
                current: named,
                name: "ProfileVersionConflictError",
            });

            vi.setSystemTime(3_000);
            const cleared = await fixture.profiles.update(
                ctx,
                original.id,
                { email: null, name: null },
                { expectedVersion: named!.version },
            );
            expect(cleared).toMatchObject({
                email: null,
                name: null,
                updatedAt: 3_000,
            });
            expect(cleared!.version > named!.version).toBe(true);
            expect(fixture.events.map((event) => event.data.previousVersion)).toEqual([
                original.version,
                named!.version,
            ]);
        } finally {
            fixture.test.close();
        }
    });

    it("rejects malformed metadata and protects the installation-owned identity", async () => {
        const fixture = await createFixture("profile-validation");
        const ctx = fixture.test.context;
        try {
            for (const name of ["", "Steve\u202eK", "Steve\u0007"]) {
                await expect(
                    fixture.profiles.create(ctx, { email: "steve@example.test", name }),
                ).rejects.toThrow("The profile name or email address is not valid.");
            }
            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });
            await expect(fixture.profiles.update(ctx, profile.id, {})).rejects.toThrow(
                "The profile update is not valid.",
            );
            await expect(
                fixture.profiles.update(ctx, profile.id, { email: "not-an-email" }),
            ).rejects.toThrow("The profile update is not valid.");

            const elsewhere = testProfileModule();
            await elsewhere.open(ctx, OTHER_INSTANCE_ID);
            await expect(elsewhere.isLocal(ctx, profile.id)).resolves.toBe(false);
            await expect(elsewhere.update(ctx, profile.id, { name: "Stolen" })).rejects.toThrow(
                "Only this profile's own installation may change it.",
            );
            await expect(fixture.profiles.get(ctx)).resolves.toEqual(profile);
        } finally {
            fixture.test.close();
        }
    });

    it("normalizes, hashes, placeholders, replaces, and deletes the one retained photo", async () => {
        const fixture = await createFixture("profile-photo");
        const ctx = fixture.test.context;
        try {
            const original = await fixture.profiles.ensure(ctx);
            const firstInput = await png(240, 30, 60);
            vi.setSystemTime(2_000);
            const first = await fixture.profiles.putPhoto(ctx, firstInput, "image/png", {
                expectedVersion: original.version,
            });
            expect(first.photo).not.toBeNull();
            expect(first.photo?.thumbhash).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
            const firstAsset = await fixture.profiles.getPhoto(ctx);
            expect(firstAsset).toBeDefined();
            expect(Value.Check(profilePhotoAssetSchema, firstAsset)).toBe(true);
            expect(firstAsset).toMatchObject({
                contentHash: first.photo?.contentHash,
                contentType: "image/webp",
                etag: `"${first.photo?.contentHash}"`,
                height: 50,
                thumbhash: first.photo?.thumbhash,
                width: 80,
            });
            expect(createHash("sha256").update(firstAsset!.bytes).digest("hex")).toBe(
                firstAsset!.contentHash,
            );
            await expect(sharp(firstAsset!.bytes).metadata()).resolves.toMatchObject({
                format: "webp",
                height: 50,
                width: 80,
            });

            const secondInput = await png(10, 80, 220, 60, 90);
            vi.setSystemTime(3_000);
            const second = await fixture.profiles.putPhoto(ctx, secondInput, "image/png", {
                expectedVersion: first.version,
            });
            const secondAsset = await fixture.profiles.getPhoto(ctx);
            expect(secondAsset?.contentHash).toBe(second.photo?.contentHash);
            expect(secondAsset?.contentHash).not.toBe(firstAsset?.contentHash);
            expect(second.version > first.version).toBe(true);

            vi.setSystemTime(4_000);
            const deleted = await fixture.profiles.deletePhoto(ctx, {
                expectedVersion: second.version,
            });
            expect(deleted.photo).toBeNull();
            expect(deleted.version > second.version).toBe(true);
            await expect(fixture.profiles.getPhoto(ctx)).resolves.toBeUndefined();

            const eventCount = fixture.events.length;
            await expect(
                fixture.profiles.deletePhoto(ctx, { expectedVersion: deleted.version }),
            ).resolves.toEqual(deleted);
            expect(fixture.events).toHaveLength(eventCount);
        } finally {
            fixture.test.close();
        }
    });

    it("bounds photo input and refuses a misleading or unsupported content type", async () => {
        const fixture = await createFixture("profile-photo-validation");
        const ctx = fixture.test.context;
        try {
            const input = await png(20, 40, 60);
            await expect(fixture.profiles.putPhoto(ctx, input, "image/jpeg")).rejects.toThrow(
                "does not match its content type",
            );
            await expect(
                fixture.profiles.putPhoto(
                    ctx,
                    new Uint8Array(MAX_PROFILE_PHOTO_BYTES + 1),
                    "image/png",
                ),
            ).rejects.toThrow("no larger than 8 MiB");
            await expect(fixture.profiles.get(ctx)).resolves.toBeUndefined();
            await expect(fixture.profiles.getPhoto(ctx)).resolves.toBeUndefined();
        } finally {
            fixture.test.close();
        }
    });

    it("retains identity, media, and monotonic versions across a module restart and clock rollback", async () => {
        const fixture = await createFixture("profile-restart");
        const ctx = fixture.test.context;
        try {
            const original = await fixture.profiles.ensure(ctx);
            const withPhoto = await fixture.profiles.putPhoto(
                ctx,
                await png(50, 100, 150),
                "image/png",
                { expectedVersion: original.version },
            );
            const asset = await fixture.profiles.getPhoto(ctx);

            const restarted = testProfileModule();
            await restarted.open(ctx, LOCAL_INSTANCE_ID);
            vi.setSystemTime(500);
            await expect(restarted.get(ctx)).resolves.toEqual(withPhoto);
            await expect(restarted.getPhoto(ctx)).resolves.toEqual(asset);
            const updated = await restarted.update(
                ctx,
                withPhoto.id,
                { name: "After restart" },
                { expectedVersion: withPhoto.version },
            );
            expect(updated?.id).toBe(original.id);
            expect(updated!.version > withPhoto.version).toBe(true);
        } finally {
            fixture.test.close();
        }
    });

    it("publishes validated chained events after commit and isolates failed listeners", async () => {
        const fixture = await createFixture("profile-events");
        const ctx = fixture.test.context;
        try {
            fixture.profiles.onEvent(() => {
                throw new Error("listener exploded");
            });
            const observed: string[] = [];
            const stop = fixture.profiles.onEvent((_eventCtx, event) => {
                observed.push(event.id);
            });

            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });
            const updated = await fixture.profiles.update(ctx, profile.id, { name: "Steve K" });
            expect(updated).toBeDefined();
            expect(
                fixture.events.every((event) => Value.Check(profileChangedEventSchema, event)),
            ).toBe(true);
            expect(fixture.events[1]?.data.previousVersion).toBe(profile.version);
            expect(observed).toEqual([profile.version, updated!.version]);

            stop();
            stop();
            await fixture.profiles.update(ctx, profile.id, { name: "Steve Korshakov" });
            expect(observed).toHaveLength(2);
        } finally {
            fixture.test.close();
        }
    });

    it("exposes a typed conflict carrying an immutable authoritative snapshot", async () => {
        const fixture = await createFixture("profile-conflict");
        const ctx = fixture.test.context;
        try {
            const profile = await fixture.profiles.ensure(ctx);
            const updated = await fixture.profiles.update(ctx, profile.id, { name: "Steve" });
            try {
                await fixture.profiles.update(
                    ctx,
                    profile.id,
                    { name: "Stale" },
                    { expectedVersion: profile.version },
                );
                expect.unreachable();
            } catch (error: unknown) {
                expect(error).toBeInstanceOf(ProfileVersionConflictError);
                expect((error as ProfileVersionConflictError).current).toEqual(updated);
            }
        } finally {
            fixture.test.close();
        }
    });
});
