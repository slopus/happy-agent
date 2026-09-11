import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sandboxSource from "../../happy-agent-supervisor/native/windows/source.json" with { type: "json" };
import { nativeWindowsGymSandboxHome } from "./nativeWindowsGymSandboxHome.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const home = String.raw`C:\native-gym-sandbox`;
const marker = {
    version: sandboxSource.setupVersion,
    offline_username: "HappySandboxOffline",
    online_username: "HappySandboxOnline",
};
const state = { HAPPY_WINDOWS_SANDBOX_HOME: home };
const incompleteMessage =
    "The native Windows gym sandbox is incomplete or outdated. Complete Happy sandbox setup explicitly before running this gym; tests never provision it.";

beforeEach(() => {
    vi.mocked(readFile).mockReset();
});

describe("native Windows gym preflight", () => {
    it.each([undefined, "", "relative/sandbox"])(
        "rejects an implicit or relative sandbox before reading state (%s)",
        async (value) => {
            await expect(
                nativeWindowsGymSandboxHome({ HAPPY_WINDOWS_SANDBOX_HOME: value }),
            ).rejects.toThrow("absolute HAPPY_WINDOWS_SANDBOX_HOME");
            expect(readFile).not.toHaveBeenCalled();
        },
    );

    it("rejects incomplete setup without exposing account state", async () => {
        vi.mocked(readFile)
            .mockResolvedValueOnce(JSON.stringify(marker))
            .mockRejectedValueOnce(new Error("secret diagnostic must not escape"));
        await expect(nativeWindowsGymSandboxHome(state)).rejects.toMatchObject({
            message: incompleteMessage,
        });
    });

    it.each(["marker", "users"])("rejects an outdated %s version", async (outdated) => {
        vi.mocked(readFile)
            .mockResolvedValueOnce(
                JSON.stringify({
                    ...marker,
                    version: sandboxSource.setupVersion - (outdated === "marker" ? 1 : 0),
                }),
            )
            .mockResolvedValueOnce(
                JSON.stringify({
                    version: sandboxSource.setupVersion - (outdated === "users" ? 1 : 0),
                }),
            );
        await expect(nativeWindowsGymSandboxHome(state)).rejects.toThrow("incomplete or outdated");
    });

    it("rejects another product's accounts", async () => {
        vi.mocked(readFile)
            .mockResolvedValueOnce(JSON.stringify({ ...marker, offline_username: "OtherSandbox" }))
            .mockResolvedValueOnce(JSON.stringify({ version: sandboxSource.setupVersion }));
        await expect(nativeWindowsGymSandboxHome(state)).rejects.toThrow("incomplete or outdated");
    });

    it("rejects malformed credentials without exposing their contents", async () => {
        vi.mocked(readFile)
            .mockResolvedValueOnce(JSON.stringify(marker))
            .mockResolvedValueOnce("not-json secret diagnostic must not escape");
        await expect(nativeWindowsGymSandboxHome(state)).rejects.toMatchObject({
            message: incompleteMessage,
        });
    });

    it("accepts complete matching state without requiring a lazy capability SID", async () => {
        vi.mocked(readFile)
            .mockResolvedValueOnce(JSON.stringify(marker))
            .mockResolvedValueOnce(JSON.stringify({ version: sandboxSource.setupVersion }));
        await expect(nativeWindowsGymSandboxHome(state)).resolves.toBe(home);
        expect(vi.mocked(readFile).mock.calls).toEqual([
            [join(home, ".sandbox", "setup_marker.json"), "utf8"],
            [join(home, ".sandbox-secrets", "sandbox_users.json"), "utf8"],
        ]);
    });
});
