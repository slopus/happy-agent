import Dockerode from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPermissionContext } from "../permissions/index.js";
import { createDockerFileSystemContext } from "./createDockerFileSystemContext.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";
import { runDockerExec } from "./runDockerExec.js";

const docker = new Dockerode();
const dockerAvailable = await docker.ping().then(
    () => true,
    () => false,
);

for (const fixture of [
    { image: "node:24-alpine", shell: "BusyBox ash" },
    { image: "node:24-slim", shell: "Debian dash" },
]) {
    const imageAvailable =
        dockerAvailable &&
        (await docker
            .getImage(fixture.image)
            .inspect()
            .then(
                () => true,
                () => false,
            ));
    let container: Dockerode.Container | undefined;

    describe.skipIf(!imageAvailable)(`createDockerFileSystemContext with ${fixture.shell}`, () => {
        beforeAll(async () => {
            container = await docker.createContainer({
                Cmd: ["sleep", "3600"],
                Image: fixture.image,
            });
            await container.start();
            const result = await runDockerExec(container, [
                "/bin/sh",
                "-c",
                'set -e\nmkdir -p "$1/.context" "$1/empty" "$1/large"\nroot=$1\nshift\nfor path do touch "$path"; done\nindex=0\nwhile [ "$index" -lt 400 ]; do name=$(printf "item-%04d" "$index"); touch "$root/large/$name"; index=$((index + 1)); done',
                "rig-file-tree-fixture",
                "/workspace",
                "/workspace/alpha",
                "/workspace/line\nbreak",
                "/workspace/zeta",
                "/workspace/éclair",
            ]);
            if (result.exitCode !== 0) {
                throw new Error(
                    `Could not create Docker file-tree fixture: ${result.stderr.toString()}`,
                );
            }
        });

        afterAll(async () => {
            if (container === undefined) return;
            await container.remove({ force: true });
        }, 30_000);

        it("pages special names and batches their metadata", async () => {
            const environment = {
                config: { workingDirectory: "/workspace" },
                container: async () => container!,
            } as unknown as DockerEnvironment;
            const context = createDockerFileSystemContext(
                environment,
                createPermissionContext("full_access"),
            );

            await expect(context.readdirPage("/workspace", { limit: 2 })).resolves.toEqual({
                entries: [".context", "alpha"],
                hasMore: true,
            });
            const rest = await context.readdirPage("/workspace", {
                after: "alpha",
                limit: 10,
            });
            expect(rest).toEqual({
                entries: ["empty", "large", "line\nbreak", "zeta", "éclair"],
                hasMore: false,
            });
            await expect(
                context.lstatMany(rest.entries.map((name) => `/workspace/${name}`)),
            ).resolves.toEqual([
                expect.objectContaining({ isDirectory: true }),
                expect.objectContaining({ isDirectory: true }),
                expect.objectContaining({ isFile: true }),
                expect.objectContaining({ isFile: true }),
                expect.objectContaining({ isFile: true }),
            ]);
            await expect(context.readdirPage("/workspace/large", { limit: 2 })).resolves.toEqual({
                entries: ["item-0000", "item-0001"],
                hasMore: true,
            });
        });
    });
}
