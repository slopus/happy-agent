import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it.runIf(process.platform === "darwin")(
    "missing workspaces cannot crash the runtime or break watching an existing workspace",
    () => {
        const result = spawnSync(
            process.execPath,
            [
                "--expose-gc",
                fileURLToPath(new URL("./fixtures/missingWorkingTree.ts", import.meta.url)),
            ],
            { encoding: "utf8", timeout: 20_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal, result.stderr).toBeNull();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("missing-workspaces-survived");
    },
    25_000,
);
