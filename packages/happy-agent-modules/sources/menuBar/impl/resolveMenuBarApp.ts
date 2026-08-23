/** The platforms a menu bar app is built for; everything else simply has no menu bar. */
export const MENU_BAR_TARGETS = ["darwin-arm64", "darwin-x64"] as const;

export type MenuBarTarget = (typeof MENU_BAR_TARGETS)[number];

/**
 * The compiled menu bar app for this machine, or `undefined` when there is none.
 *
 * Only the released Happy Agent binary has one. It embeds the app and replaces this file with a
 * resolver that materializes it, so this is the answer everywhere else: a source build, a daemon
 * run from a checkout, a test. Working on Happy Agent should never put a status item in someone's
 * menu bar, and a test run should never leave one behind.
 *
 * Keep this file free of anything the binary build would have to reproduce.
 */
export function resolveMenuBarApp(): string | undefined {
    return undefined;
}
