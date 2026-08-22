import { existsSync } from "node:fs";
import { join } from "node:path";

/** The platforms a menu bar app is built for; everything else simply has no menu bar. */
export const MENU_BAR_TARGETS = ["darwin-arm64", "darwin-x64"] as const;

export type MenuBarTarget = (typeof MENU_BAR_TARGETS)[number];

/**
 * The compiled menu bar app for this machine, or `undefined` when there is none.
 *
 * A source build that never ran the Swift compilation, and every platform without a menu bar,
 * both land here: the feature is absent rather than broken, and the module stays quiet.
 *
 * The standalone Happy Agent binary embeds the app instead and replaces this file, so keep it
 * free of anything the binary build would have to reproduce.
 */
export function resolveMenuBarApp(): string | undefined {
    const target = `${process.platform}-${process.arch}`;
    if (!(MENU_BAR_TARGETS as readonly string[]).includes(target)) return undefined;
    const app = join(import.meta.dirname, "..", "bin", `happy-menu-bar-${target}`);
    return existsSync(app) ? app : undefined;
}
