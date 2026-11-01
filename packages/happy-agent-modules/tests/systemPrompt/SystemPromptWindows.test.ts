import { describe, expect, it } from "vitest";

import { runnerEnvironment } from "../../sources/runners/impl/runnerEnvironment.js";
import { assembleEnvironmentPrompt } from "../../sources/systemPrompt/impl/assembleEnvironmentPrompt.js";

describe("native Windows command guidance", () => {
    for (const inheritedShell of ["", "/bin/bash", "C:\\Program Files\\Git\\bin\\bash.exe"]) {
        it(`describes the executing shell when SHELL is ${JSON.stringify(inheritedShell)}`, () => {
            const prompt = assembleEnvironmentPrompt({
                environment: {
                    platform: "win32",
                    osVersion: "10.0.26100",
                    shell: inheritedShell,
                    workingDirectory: "C:\\Projects\\My App",
                },
                availableModels: [],
                currentModel: "anthropic/fable-5",
                currentProvider: "claude",
                designSystemPath: "C:\\Happy\\DESIGN.md",
                documentationPath: "C:\\Happy\\README.md",
            });
            expect(prompt).toContain("- Shell: Windows PowerShell 5.1 (powershell.exe)");
            expect(prompt).toContain("Commands run on native Windows in PowerShell");
            expect(prompt).toContain("do not use Git Bash");
            expect(prompt).not.toContain("including calls named Bash");
            expect(prompt).toContain("-LiteralPath");
            expect(prompt).toContain("&&");
            expect(prompt).toContain("$env:NAME");
            expect(prompt).toContain("Start-Process -WindowStyle Hidden");
            expect(prompt).not.toContain("- Shell: /bin/bash");
            expect(prompt).not.toContain("- Shell: C:\\Program Files\\Git");
        });
    }

    it("guides an agent on a Windows runner the same way under a Linux daemon", () => {
        const prompt = assembleEnvironmentPrompt({
            environment: runnerEnvironment("win32", "C:\\Users\\runner\\Happy\\Projects\\rig"),
            availableModels: [],
            currentModel: undefined,
            currentProvider: "claude",
            designSystemPath: "/home/happy/.happy/docs/DESIGN.md",
            documentationPath: "/home/happy/.happy/docs/README.md",
        });
        expect(prompt).toContain("- Platform: win32");
        expect(prompt).toContain("- Shell: Windows PowerShell 5.1 (powershell.exe)");
        expect(prompt).toContain("- OS version: Windows");
        expect(prompt).toContain("Commands run on native Windows in PowerShell");
        expect(prompt).not.toContain("- Platform: linux");
    });
});
