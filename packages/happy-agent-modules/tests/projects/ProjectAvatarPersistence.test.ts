import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/index.js";
import { type ProjectEvent, projectMigrations } from "../../sources/projects/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsModuleFor } from "../support/projectsModule.js";

describe("project avatar persistence", () => {
    it("atomically persists normalized bytes, public metadata, and exact lifecycle events", async () => {
        expect(projectMigrations.at(-1)?.[0]).toBe("008-project-avatar-assets");
        const database = moduleDatabase(projectMigrations, "project-avatar-persistence");
        await database.ready;
        try {
            const config = await temporaryTestConfig();
            const projects = projectsModuleFor(config, new GitModule());
            const events: ProjectEvent[] = [];
            projects.onEventTransactional((_ctx, event) => {
                if (
                    event.type === "project_avatar_updated" ||
                    event.type === "project_avatar_cleared"
                ) {
                    events.push(event);
                }
            });
            const created = await projects.create(database.context, {
                name: "Avatar persistence",
                repositoryRef: "/tmp/projects/avatar-persistence",
            });

            const first = await projects.setAvatar(database.context, {
                bytes: await png(220, 40, 80, 640, 320),
                contentType: "image/png",
                expectedVersion: created.version,
                projectId: created.id,
                source: "user",
            });
            expect(first.avatar).toEqual({
                kind: "image",
                source: "user",
                thumbhash: expect.any(String),
            });
            expect(Object.keys(first.avatar ?? {}).sort()).toEqual(["kind", "source", "thumbhash"]);
            const firstAsset = await projects.avatarAsset(database.context, created.id);
            expect(firstAsset).toMatchObject({
                contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
                contentType: "image/webp",
                etag: expect.stringMatching(/^"[a-f0-9]{64}"$/u),
                height: 128,
                thumbhash: first.avatar?.thumbhash,
                width: 256,
            });
            await expect(sharp(firstAsset?.bytes).metadata()).resolves.toMatchObject({
                format: "webp",
                height: 128,
                width: 256,
            });

            const reopened = projectsModuleFor(config, new GitModule());
            await expect(reopened.avatarAsset(database.context, created.id)).resolves.toEqual(
                firstAsset,
            );

            const second = await projects.setAvatar(database.context, {
                bytes: await png(40, 80, 220, 120, 180),
                expectedVersion: first.version,
                projectId: created.id,
                source: "generated",
            });
            expect(second.avatar).toMatchObject({ kind: "image", source: "generated" });
            expect(second.avatar?.thumbhash).not.toBe(first.avatar?.thumbhash);

            const cleared = await projects.clearAvatar(database.context, {
                expectedVersion: second.version,
                projectId: created.id,
            });
            expect(cleared.avatar).toBeUndefined();
            await expect(
                projects.avatarAsset(database.context, created.id),
            ).resolves.toBeUndefined();

            expect(events).toHaveLength(3);
            expectAvatarEventChain(events[0]!, "project_avatar_updated", created, first);
            expectAvatarEventChain(events[1]!, "project_avatar_updated", first, second);
            expectAvatarEventChain(events[2]!, "project_avatar_cleared", second, cleared);
        } finally {
            database.close();
        }
    });

    it("rejects a mismatched declared content type without changing the project", async () => {
        const database = moduleDatabase(projectMigrations, "project-avatar-content-type");
        await database.ready;
        try {
            const projects = projectsModuleFor(await temporaryTestConfig(), new GitModule());
            const created = await projects.create(database.context, {
                name: "Avatar content type",
                repositoryRef: "/tmp/projects/avatar-content-type",
            });
            await expect(
                projects.setAvatar(database.context, {
                    bytes: await png(10, 20, 30),
                    contentType: "image/jpeg",
                    expectedVersion: created.version,
                    projectId: created.id,
                    source: "user",
                }),
            ).rejects.toThrow("does not match its content type");
            await expect(projects.get(database.context, created.id)).resolves.toEqual(created);
            await expect(
                projects.avatarAsset(database.context, created.id),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });
});

function expectAvatarEventChain(
    event: ProjectEvent,
    type: "project_avatar_updated" | "project_avatar_cleared",
    previousProject: { readonly version: number },
    project: { readonly version: number },
): void {
    expect(event.type).toBe(type);
    if (event.type !== "project_avatar_updated" && event.type !== "project_avatar_cleared") {
        throw new Error("Expected a project avatar event.");
    }
    expect(event.previousProject).toEqual(previousProject);
    expect(event.project).toEqual(project);
    expect(event.previousProject.version).toBe(event.project.version - 1);
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
