import { Type } from "@sinclair/typebox";
import { runnerMethods } from "../../../../happy-agent-compute/sources/runner/runnerProtocol.ts";

const parameters = Type.Omit(runnerMethods["process.start"].params, ["computeId", "stream"]);
export const runnerProgramSchemas = {
    ownerRunnerProgramOptions: Type.Object(
        { ...parameters.properties, args: Type.Optional(parameters.properties.args) },
        { additionalProperties: false },
    ),
};
