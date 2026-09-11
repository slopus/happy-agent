/* Fail before importing the runtime or creating daemon state. */
export function assertGymRuntimeSupported(): void {
    // The CLI no longer installs an emulated compute provider. Refuse the old gym
    // contract before starting any runtime work: using native compute here could
    // execute a fixture command on the host with the gym's Full access default.
    if (process.env.HAPPY_TERMINAL_GYM_RUNTIME === "just-bash") {
        throw new Error(
            "The emulated terminal gym compute bridge is unavailable. " +
                "Use an explicitly isolated Docker gym or an explicit native-windows gym; " +
                "host execution cannot substitute for just-bash.",
        );
    }
}
