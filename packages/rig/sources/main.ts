#!/usr/bin/env node

import { main } from "./app/main.js";
import { installCliFailureReporting } from "./installCliFailureReporting.js";
import { reportCliFailureAndExit } from "./reportCliFailure.js";

installCliFailureReporting();

main().then((exitCode) => {
    if (exitCode !== undefined) {
        process.exitCode = exitCode;
        if (exitCode !== 0) {
            process.stdout.write("", () => process.exit(exitCode));
            return;
        }
    }
    if (process.env.RIG_GYM_IN_PROCESS_DAEMON === "1") process.exit(0);
}, reportCliFailureAndExit);
