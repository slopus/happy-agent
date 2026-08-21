import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("active permission scope is visible without opening a menu", () => {
    it("keeps Full access, Read only, and Auto visible in the live footer", async () => {
        const gym = await createGym({
            mode: "docker",
            cols: 100,
            inference: [],
            rows: 24,
        });
        running.add(gym);
        const startup = await gym.terminal.snapshot();
        const baseline = startup.scroll;

        expect(footerRow(startup)).toContain("full access");
        assertHealthyTerminal(startup, baseline);

        submit(gym, "/permissions");
        const fullAccessMenu = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Choose Permissions") &&
                snapshot.text.includes("→ Full access") &&
                snapshot.scroll.atBottom,
            "permissions menu with Full access selected",
        );
        expect(fullAccessMenu.text).toContain("Allow unrestricted filesystem, shell, and network");
        expect(fullAccessMenu.text).not.toContain("full_access");
        assertHealthyTerminal(fullAccessMenu, baseline);

        gym.terminal.press("up");
        gym.terminal.press("enter");
        const readOnly = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Permissions changed to Read only.") &&
                footerRow(snapshot).includes("read only") &&
                snapshot.scroll.atBottom,
            "Read only scope in the live footer",
        );
        expect(footerRow(readOnly)).not.toContain("full access");
        expect(footerRow(readOnly)).not.toContain("read_only");
        assertHealthyTerminal(readOnly, baseline);

        submit(gym, "/permissions");
        const readOnlyMenu = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Choose Permissions") &&
                snapshot.text.includes("→ Read only") &&
                snapshot.scroll.atBottom,
            "permissions menu with Read only selected",
        );
        expect(readOnlyMenu.text).not.toContain("read_only");
        gym.terminal.press("up");
        gym.terminal.press("up");
        gym.terminal.press("enter");

        const auto = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Permissions changed to Auto.") &&
                footerRow(snapshot).includes("auto") &&
                snapshot.scroll.atBottom,
            "Auto scope in the live footer",
        );
        expect(footerRow(auto)).not.toContain("read only");
        expect(footerRow(auto)).not.toContain("full access");
        assertHealthyTerminal(auto, baseline);
        expect(agentRequests(gym)).toHaveLength(0);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function footerRow(snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>): string {
    return snapshot.rows.find((row) => row.includes("gym off")) ?? "";
}

function agentRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => !request.options.sessionId?.endsWith(":title"),
    );
}

function assertHealthyTerminal(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    baseline: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>["scroll"],
): void {
    expect(snapshot.rows).toHaveLength(24);
    expect(snapshot.scroll.visibleRows).toBe(24);
    expect(snapshot.scroll.atBottom).toBe(true);
    expect(snapshot.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
    expect(snapshot.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
    expect(snapshot.cursor.x).toBeLessThan(100);
    expect(snapshot.cursor.y).toBeLessThan(24);
    expect(snapshot.text).toContain("gym off");
    expect(snapshot.text).toContain("/workspace");
    expect(snapshot.text).not.toContain("�");
}
