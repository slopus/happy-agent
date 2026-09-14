import { createRootContext } from "@steve.kite/stdlib";
import { createHostCompute, allowEverything } from "../../dist/index.js";

const [cwd, privateDirectory, id, cgroupParent] = process.argv.slice(2);
const ctx = createRootContext().named("service-controller-crash-fixture");
const compute = createHostCompute({
    ctx,
    cwd,
    hostPolicy: { privateDirectories: [privateDirectory] },
    serviceCgroupParent: cgroupParent,
});
const service = await compute.services.start(ctx, {
    execution: { id, directory: `${privateDirectory}/${id}` },
    command: "printf workload-ready; exec sleep 60",
    cwd: ".",
    port: 4187,
    tty: false,
    permissions: allowEverything(),
    sandbox: {
        inputs: ["src"],
        scratch: ["out"],
        outbound: [],
        limits: { memoryMiB: 128, processes: 32 },
    },
});
const deadline = Date.now() + 10000;
while (!service.read({ stdout: 0, stderr: 0 }).stdout.includes("workload-ready")) {
    if (Date.now() >= deadline) throw new Error("The crash fixture workload did not start.");
    await new Promise((resolve) => setTimeout(resolve, 20));
}
process.stdout.write("controller-ready");
await service.completion;
await compute.dispose(ctx);
