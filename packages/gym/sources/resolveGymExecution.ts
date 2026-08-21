import type { GymOptions } from "./types.js";

export function resolveGymExecution(options: GymOptions): "docker" | "local" {
    const execution =
        options.mode === "docker" || process.env.HAPPY_TERMINAL_GYM_EXECUTION === "docker"
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
