import type { GymOptions } from "./types.js";

export function resolveGymExecution(options: GymOptions): "docker" | "local" {
    if (options.mode === "native-windows") {
        if (process.platform !== "win32") throw new Error("Native Windows gyms require Windows.");
        if (options.permissionMode === undefined || options.permissionMode === "from_config") {
            throw new Error("Native Windows gyms must explicitly select a permission mode.");
        }
    }
    const execution =
        options.mode === "docker" ||
        (options.mode === undefined && process.env.HAPPY_TERMINAL_GYM_EXECUTION === "docker")
            ? "docker"
            : "local";
    if (execution === "local" && options.dockerSocket === true) {
        throw new Error('Gym option "dockerSocket" requires mode: "docker".');
    }
    if (execution === "local" && options.image !== undefined) {
        throw new Error('Gym option "image" requires mode: "docker".');
    }
    return execution;
}
