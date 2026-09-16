import { createRootContext } from "@steve.kite/stdlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigModule } from "../../sources/config/index.js";

const mocks = vi.hoisted(() => ({
    resolveMenuBarApp: vi.fn(() => "/tmp/happy-menu-bar"),
    stop: vi.fn(),
    supervise: vi.fn(async () => "stopped"),
    arguments: vi.fn(),
}));

vi.mock("../../sources/menuBar/impl/resolveMenuBarApp.js", () => ({
    resolveMenuBarApp: mocks.resolveMenuBarApp,
}));

vi.mock("../../sources/menuBar/impl/MenuBarApp.js", () => ({
    MenuBarApp: class {
        constructor(executable: string, args: string[]) {
            mocks.arguments(executable, args);
        }
        stop = mocks.stop;
        supervise = mocks.supervise;
    },
}));

import { MenuBarModule } from "../../sources/menuBar/MenuBarModule.js";

beforeEach(() => {
    vi.clearAllMocks();
});

describe("MenuBarModule", () => {
    it.skipIf(process.platform !== "win32")(
        "keeps Stop available during graceful drain and closes the tray at finalization",
        async () => {
            const config = {
                configuration: {
                    paths: { socketPath: "pipe", tokenPath: "token" },
                    values: { feature: { team: { enabled: false } }, settings: { menuBar: true } },
                },
            } as ConfigModule;
            const module = new MenuBarModule(config);
            module.beforeStart(createRootContext());
            expect(mocks.arguments).toHaveBeenCalledWith("/tmp/happy-menu-bar", [
                "--socket",
                "pipe",
                "--token-file",
                "token",
                "--parent-pid",
                String(process.pid),
            ]);
            await module.beginShutdown();
            expect(mocks.stop).not.toHaveBeenCalled();
            await module.close();
            expect(mocks.stop).toHaveBeenCalledOnce();
        },
    );

    it("does not start the local-socket app in team mode", () => {
        const config = {
            configuration: {
                paths: { socketPath: "/tmp/server.sock", tokenPath: "/tmp/token" },
                values: {
                    feature: { team: { enabled: true } },
                    settings: { menuBar: true },
                },
            },
        } as ConfigModule;

        new MenuBarModule(config).beforeStart(createRootContext());

        expect(mocks.resolveMenuBarApp).not.toHaveBeenCalled();
    });
});
