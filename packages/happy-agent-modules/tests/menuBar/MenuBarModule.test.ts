import { createRootContext } from "@steve.kite/stdlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigModule } from "../../sources/config/index.js";

const mocks = vi.hoisted(() => ({
    resolveMenuBarApp: vi.fn(() => "/tmp/happy-menu-bar"),
}));

vi.mock("../../sources/menuBar/impl/resolveMenuBarApp.js", () => ({
    resolveMenuBarApp: mocks.resolveMenuBarApp,
}));

import { MenuBarModule } from "../../sources/menuBar/MenuBarModule.js";

beforeEach(() => {
    vi.clearAllMocks();
});

describe("MenuBarModule", () => {
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
