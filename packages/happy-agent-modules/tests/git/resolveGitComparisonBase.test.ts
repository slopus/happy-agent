import { expect, it, vi } from "vitest";
import { resolveGitComparisonBase } from "../../sources/git/resolveGitComparisonBase.js";

it("reports an unborn branch as unavailable instead of inventing a non-origin/main baseline", async () => {
    const run = vi.fn(async () => "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(await resolveGitComparisonBase({ run })).toEqual({
        error: "This repository has no commits yet.",
    });
    expect(run).not.toHaveBeenCalled();
});
