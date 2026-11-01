import { posix } from "node:path";

import type { Compute } from "@slopus/happy-agent-compute";
import { describe, expect, it } from "vitest";

import { MachineFileIndex } from "../../sources/files/impl/MachineFileIndex.js";
import type { GitModule, GitWorkingTreeFiles } from "../../sources/git/index.js";

const FOLDER = { root: "/runner/large-package", runnerId: "build-box", paths: posix };

describe("MachineFileIndex", () => {
    it("finds a file past Git's listing cap on a runner", async () => {
        const all = ["a00000.ts", "a00001.ts", "zz-unique-search-target.ts"];
        // A listing cut off at its cap, as a runner folder of more than 20,000 files is.
        const git = {
            listWorkingTreeFiles: async (options: { readonly match?: string }) =>
                options.match === undefined
                    ? ({ paths: all.slice(0, 2), truncated: true } satisfies GitWorkingTreeFiles)
                    : ({
                          paths: all.filter((path) => path.includes(options.match ?? "")),
                          truncated: false,
                      } satisfies GitWorkingTreeFiles),
        } as unknown as GitModule;
        const index = new MachineFileIndex(git);

        const early = await index.search({} as Compute, FOLDER, "a00001", 10, true);
        const late = await index.search({} as Compute, FOLDER, "zz-unique-search-target", 10, true);

        expect(early).toContainEqual({ fileName: "a00001.ts", path: "a00001.ts" });
        expect(late).toEqual([
            { fileName: "zz-unique-search-target.ts", path: "zz-unique-search-target.ts" },
        ]);
    });

    it("ranks a complete listing without asking Git again", async () => {
        const queries: (string | undefined)[] = [];
        const git = {
            listWorkingTreeFiles: async (options: { readonly match?: string }) => {
                queries.push(options.match);
                return { paths: ["README.md", "src/main.ts"], truncated: false };
            },
        } as unknown as GitModule;
        const index = new MachineFileIndex(git);

        await index.search({} as Compute, FOLDER, "main", 10, true);
        const result = await index.search({} as Compute, FOLDER, "readme", 10, true);

        expect(result).toEqual([{ fileName: "README.md", path: "README.md" }]);
        expect(queries).toEqual([undefined]);
    });
});
