import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    MAX_PROJECT_PAGE_SIZE,
    PROJECT_PAGE_SIZE,
    projectPageQuerySchema,
} from "../../sources/projects/index.js";
import { SECRETS_PAGE_SIZE, secretListInputSchema } from "../../sources/secrets/index.js";
import { taskPageQuerySchema } from "../../sources/tasks/TaskPage.js";
import { MAX_TASK_PAGE_SIZE } from "../../sources/tasks/TasksModule.js";
import {
    MAX_USER_INPUT_PAGE_SIZE,
    userInputListQuerySchema,
} from "../../sources/userInput/index.js";
import {
    MAX_WORKSPACE_PAGE_SIZE,
    WORKSPACE_PAGE_SIZE,
    workspacePageQuerySchema,
} from "../../sources/workspaces/index.js";

describe("common tool page limits", () => {
    it("keeps model-facing schemas aligned with executor page limits", () => {
        const contracts = [
            {
                name: "projects",
                schema: projectPageQuerySchema,
                schemaLimit: MAX_PROJECT_PAGE_SIZE,
                runtimeLimit: PROJECT_PAGE_SIZE,
            },
            {
                name: "workspaces",
                schema: workspacePageQuerySchema,
                schemaLimit: MAX_WORKSPACE_PAGE_SIZE,
                runtimeLimit: WORKSPACE_PAGE_SIZE,
            },
            {
                name: "secrets",
                schema: secretListInputSchema,
                schemaLimit: SECRETS_PAGE_SIZE,
                runtimeLimit: SECRETS_PAGE_SIZE,
            },
            {
                name: "tasks",
                schema: taskPageQuerySchema,
                schemaLimit: MAX_TASK_PAGE_SIZE,
                runtimeLimit: MAX_TASK_PAGE_SIZE,
            },
            {
                name: "user input",
                schema: userInputListQuerySchema,
                schemaLimit: MAX_USER_INPUT_PAGE_SIZE,
                runtimeLimit: MAX_USER_INPUT_PAGE_SIZE,
            },
        ] as const;

        for (const contract of contracts) {
            expect(contract.schemaLimit, contract.name).toBe(contract.runtimeLimit);
            expect(
                Value.Check(contract.schema, { limit: contract.runtimeLimit }),
                contract.name,
            ).toBe(true);
            expect(
                Value.Check(contract.schema, { limit: contract.runtimeLimit + 1 }),
                contract.name,
            ).toBe(false);
        }
    });
});
