import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Exercise the runtime shipped in the executable. Node tests cannot catch a
// JavaScriptCore optimizer abort. Reduced from WebKit's regression for stale
// scope analysis, with an await so the failing code runs from a microtask:
// https://github.com/oven-sh/WebKit/commit/cb05a6083ae0246da0eeee815a7ba5daf3b20c25
const source = `
async function resume(a1, a2, a3, a4, a5) {
    await Promise.resolve();
    try {
        class Trans extends Array {}
        function inline() {
            try {
                a2(["Āሴ￿", a5]);
            } catch {}
        }
        inline();
    } catch {}
    function compare(a, b) {
        for (var index = 0; index < 10000; index++) {}
        return a == b;
    }
    compare(-1, a5);
    class C {}
}
for (let index = 0; index < 10000; index++) {
    await resume(Function.prototype.apply, Function.prototype.toString, 1.1, "💩", Object.defineProperty);
}
console.log("async-resume-ok");
`;

test("optimized async functions resume after a caught exception without killing the daemon runtime", () => {
    const result = spawnSync(process.execPath, ["--smol", "--eval", source], {
        encoding: "utf8",
        timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("async-resume-ok");
}, 25_000);
