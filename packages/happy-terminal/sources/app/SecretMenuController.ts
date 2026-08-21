import type { Component } from "@earendil-works/pi-tui";

import type { SecretSummary } from "../protocol/index.js";
import type {
    EnvironmentSecretRegistration,
    EnvironmentSecretUpdate,
    SecretAttachmentScope,
} from "../protocol/index.js";
import type { AppTranscriptEntry } from "./AppTranscriptEntry.js";
import { createSecretInputPanel } from "./createSecretInputPanel.js";
import { createSelectionPanel } from "./createSelectionPanel.js";
import type { TerminalTheme } from "./TerminalTheme.js";

interface SecretRegistrationDraft {
    description: string;
    environment: Record<string, string>;
    id: string;
}

type TranscriptEntryInput = Omit<AppTranscriptEntry, "id"> & { id?: string };

export interface SecretMenuControllerOptions {
    appendEntry: (entry: TranscriptEntryInput) => void;
    attachSecret: ((id: string, scope: SecretAttachmentScope) => void | Promise<void>) | undefined;
    closePanel: () => void;
    detachSecret: ((id: string, scope: SecretAttachmentScope) => void | Promise<void>) | undefined;
    initialProjectSecretIds: readonly string[] | undefined;
    initialSessionSecretIds: readonly string[] | undefined;
    listSecrets: (() => readonly SecretSummary[] | Promise<readonly SecretSummary[]>) | undefined;
    registerSecret:
        | ((registration: EnvironmentSecretRegistration) => SecretSummary | Promise<SecretSummary>)
        | undefined;
    requestRender: () => void;
    showPanel: (component: Component) => void;
    theme: TerminalTheme;
    unregisterSecret: ((id: string) => boolean | Promise<boolean>) | undefined;
    updateSecret:
        | ((id: string, update: EnvironmentSecretUpdate) => SecretSummary | Promise<SecretSummary>)
        | undefined;
}

export class SecretMenuController {
    readonly #appendEntry: (entry: TranscriptEntryInput) => void;
    readonly #attachSecret:
        | ((id: string, scope: SecretAttachmentScope) => void | Promise<void>)
        | undefined;
    readonly #closePanelCallback: () => void;
    readonly #detachSecret:
        | ((id: string, scope: SecretAttachmentScope) => void | Promise<void>)
        | undefined;
    readonly #listSecrets:
        | (() => readonly SecretSummary[] | Promise<readonly SecretSummary[]>)
        | undefined;
    readonly #registerSecret:
        | ((registration: EnvironmentSecretRegistration) => SecretSummary | Promise<SecretSummary>)
        | undefined;
    readonly #requestRender: () => void;
    readonly #showPanelCallback: (component: Component) => void;
    readonly #theme: TerminalTheme;
    readonly #unregisterSecret: ((id: string) => boolean | Promise<boolean>) | undefined;
    readonly #updateSecret:
        | ((id: string, update: EnvironmentSecretUpdate) => SecretSummary | Promise<SecretSummary>)
        | undefined;

    #listVisible = false;
    #operationGeneration = 0;
    #projectSecretIds: readonly string[];
    #registrations: readonly SecretSummary[] = [];
    #sessionSecretIds: readonly string[];

    constructor(options: SecretMenuControllerOptions) {
        this.#appendEntry = options.appendEntry;
        this.#attachSecret = options.attachSecret;
        this.#closePanelCallback = options.closePanel;
        this.#detachSecret = options.detachSecret;
        this.#listSecrets = options.listSecrets;
        this.#projectSecretIds = options.initialProjectSecretIds ?? [];
        this.#registerSecret = options.registerSecret;
        this.#requestRender = options.requestRender;
        this.#sessionSecretIds = options.initialSessionSecretIds ?? [];
        this.#showPanelCallback = options.showPanel;
        this.#theme = options.theme;
        this.#unregisterSecret = options.unregisterSecret;
        this.#updateSecret = options.updateSecret;
    }

    hide(): void {
        this.#listVisible = false;
        this.#operationGeneration += 1;
    }

    open(): void {
        if (
            this.#attachSecret === undefined ||
            this.#detachSecret === undefined ||
            this.#listSecrets === undefined ||
            this.#registerSecret === undefined ||
            this.#unregisterSecret === undefined
        ) {
            this.#appendEntry({
                role: "event",
                title: "Secrets",
                text: "Secret management is unavailable in this session.",
            });
            return;
        }

        const generation = this.#beginOperation();
        this.#showPanel(
            createSelectionPanel({
                theme: this.#theme,
                title: "Secrets",
                subtitle: "Loading registered secret bundles",
                items: [{ value: "loading", label: "Loading..." }],
                onSelect: () => {},
                onCancel: () => this.#closePanel(),
            }),
        );
        void Promise.resolve()
            .then(() => this.#listSecrets?.())
            .then((secrets) => {
                if (secrets === undefined || !this.#isCurrentOperation(generation)) return;
                this.#registrations = [...secrets];
                this.#showSecretsMenu();
                this.#requestRender();
            })
            .catch(() => {
                if (!this.#isCurrentOperation(generation)) return;
                this.#closePanel();
                this.#appendEntry({
                    role: "error",
                    text: "Could not load secret registrations.",
                });
                this.#requestRender();
            });
    }

    updateAttachments(
        projectSecretIds: readonly string[],
        sessionSecretIds: readonly string[],
    ): void {
        const refreshList = this.#listVisible;
        this.#projectSecretIds = projectSecretIds;
        this.#sessionSecretIds = sessionSecretIds;
        if (refreshList) this.#showSecretsMenu();
    }

    #attachmentStatus(secret: SecretSummary): string {
        if (secret.kind !== undefined) return "Not available to model";
        const session = this.#sessionSecretIds.includes(secret.id);
        const project = this.#projectSecretIds.includes(secret.id);
        if (session && project) return "Attached: Session and Project";
        if (session) return "Attached: Session";
        if (project) return "Attached: Project";
        return "Not attached";
    }

    #changeAttachment(
        secret: SecretSummary,
        operation: "attach" | "detach",
        scope: SecretAttachmentScope,
    ): void {
        const callback = operation === "attach" ? this.#attachSecret : this.#detachSecret;
        if (callback === undefined) return;
        const generation = this.#beginOperation();
        void Promise.resolve()
            .then(() => callback(secret.id, scope))
            .then(() => {
                if (scope === "session") {
                    this.#sessionSecretIds = this.#updateSecretIds(
                        this.#sessionSecretIds,
                        secret.id,
                        operation === "attach",
                    );
                } else {
                    this.#projectSecretIds = this.#updateSecretIds(
                        this.#projectSecretIds,
                        secret.id,
                        operation === "attach",
                    );
                }
                this.#appendEntry({
                    role: "event",
                    title: "Secrets",
                    text: `${operation === "attach" ? "Attached" : "Detached"} '${secret.id}' ${scope === "session" ? "for this session" : "for this project"}.`,
                });
                if (this.#isCurrentOperation(generation)) this.#showSecretsMenu();
                this.#requestRender();
            })
            .catch(() => {
                const message = `Could not ${operation} the secret for this ${scope}.`;
                this.#appendEntry({
                    role: "error",
                    text: message,
                });
                if (this.#isCurrentOperation(generation)) {
                    this.#openSecretActions(secret, message);
                }
                this.#requestRender();
            });
    }

    #closePanel(): void {
        this.hide();
        this.#closePanelCallback();
    }

    #beginOperation(): number {
        this.#operationGeneration += 1;
        return this.#operationGeneration;
    }

    #isCurrentOperation(generation: number): boolean {
        return generation === this.#operationGeneration;
    }

    #confirmRemoval(secret: SecretSummary): void {
        this.#showPanel(
            createSelectionPanel({
                theme: this.#theme,
                title: `Remove ${secret.id}?`,
                subtitle: "This also detaches the bundle from every session and project",
                selectedValue: "cancel",
                items: [
                    { value: "cancel", label: "Cancel", description: "Keep this registration." },
                    {
                        value: "remove",
                        label: "Remove registration",
                        description: "Delete this secret bundle.",
                    },
                ],
                onSelect: (item) => {
                    if (item.value !== "remove") {
                        this.#openSecretActions(secret);
                        return;
                    }
                    this.#closePanel();
                    this.#removeRegistration(secret);
                },
                onCancel: () => this.#openSecretActions(secret),
            }),
        );
    }

    #openDescriptionInput(id: string, error?: string): void {
        this.#showPanel(
            createSecretInputPanel({
                theme: this.#theme,
                title: "Add Secret",
                subtitle: error ?? `Describe ${id}`,
                label: "Description",
                onSubmit: (value) => {
                    const description = value.trim();
                    if (description.length === 0) {
                        this.#openDescriptionInput(id, "Enter a description.");
                        return;
                    }
                    this.#openEnvironmentNameInput({ description, environment: {}, id });
                },
                onCancel: () => this.#showSecretsMenu(),
            }),
        );
    }

    #openEnvironmentNameInput(draft: SecretRegistrationDraft, error?: string): void {
        this.#showPanel(
            createSecretInputPanel({
                theme: this.#theme,
                title: "Add Environment Variable",
                subtitle: error ?? `${draft.id} · Enter a variable name`,
                label: "Name",
                onSubmit: (value) => {
                    const name = value.trim();
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
                        this.#openEnvironmentNameInput(
                            draft,
                            "Enter a valid environment variable name.",
                        );
                        return;
                    }
                    if (
                        Object.keys(draft.environment).some(
                            (existingName) => existingName.toLowerCase() === name.toLowerCase(),
                        )
                    ) {
                        this.#openEnvironmentNameInput(
                            draft,
                            "That environment variable is already in this bundle.",
                        );
                        return;
                    }
                    this.#openValueInput(draft, name);
                },
                onCancel: () => this.#showSecretsMenu(),
            }),
        );
    }

    #openIdInput(error?: string): void {
        this.#showPanel(
            createSecretInputPanel({
                theme: this.#theme,
                title: "Add Secret",
                subtitle:
                    error ?? "Use 1-128 letters, numbers, periods, underscores, colons, or hyphens",
                label: "ID",
                onSubmit: (value) => {
                    const id = value.trim();
                    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) {
                        this.#openIdInput("Enter a valid secret ID.");
                        return;
                    }
                    this.#openDescriptionInput(id);
                },
                onCancel: () => this.#showSecretsMenu(),
            }),
        );
    }

    #openSecretActions(secret: SecretSummary, notice?: string): void {
        const systemManaged = secret.kind !== undefined;
        this.#showPanel(
            createSelectionPanel({
                theme: this.#theme,
                title: secret.id,
                subtitle: notice ?? `${secret.description} · ${this.#attachmentStatus(secret)}`,
                items: [
                    ...(systemManaged
                        ? []
                        : [
                              {
                                  value: "attach",
                                  label: "Attach",
                                  description: "Make this bundle available to selected commands.",
                              },
                              {
                                  value: "detach",
                                  label: "Detach",
                                  description: "Stop making this bundle available at one scope.",
                              },
                              {
                                  value: "remove",
                                  label: "Remove registration",
                                  description: "Delete this bundle from Happy Terminal.",
                              },
                              ...(this.#updateSecret === undefined
                                  ? []
                                  : [
                                        {
                                            value: "edit",
                                            label: "Edit fields",
                                            description:
                                                "Change the description or selected environment variables.",
                                        },
                                    ]),
                          ]),
                    { value: "back", label: "Back" },
                ],
                onSelect: (item) => {
                    if (item.value === "attach" || item.value === "detach") {
                        this.#openScopeMenu(secret, item.value);
                        return;
                    }
                    if (item.value === "remove") {
                        this.#confirmRemoval(secret);
                        return;
                    }
                    if (item.value === "edit") {
                        this.#openEditMenu(secret);
                        return;
                    }
                    this.#showSecretsMenu();
                },
                onCancel: () => this.#showSecretsMenu(),
            }),
        );
    }

    #openEditMenu(secret: SecretSummary, notice?: string): void {
        this.#showPanel(
            createSelectionPanel({
                theme: this.#theme,
                title: `Edit ${secret.id}`,
                subtitle: notice ?? "Choose one field to change",
                items: [
                    {
                        value: "description",
                        label: "Description",
                        description: secret.description,
                    },
                    {
                        value: "set-variable",
                        label: "Set variable",
                        description: "Add a variable or replace one value.",
                    },
                    ...(secret.environmentVariables.length <= 1
                        ? []
                        : [
                              {
                                  value: "remove-variable",
                                  label: "Remove variable",
                                  description: "Remove one environment variable.",
                              },
                          ]),
                    { value: "back", label: "Back" },
                ],
                onSelect: (item) => {
                    if (item.value === "description") {
                        this.#openUpdatedDescriptionInput(secret);
                        return;
                    }
                    if (item.value === "set-variable") {
                        this.#openUpdatedVariableNameInput(secret);
                        return;
                    }
                    if (item.value === "remove-variable") {
                        this.#openRemoveVariableMenu(secret);
                        return;
                    }
                    this.#openSecretActions(secret);
                },
                onCancel: () => this.#openSecretActions(secret),
            }),
        );
    }

    #openUpdatedDescriptionInput(secret: SecretSummary, error?: string): void {
        this.#showPanel(
            createSecretInputPanel({
                theme: this.#theme,
                title: `Describe ${secret.id}`,
                subtitle: error ?? `Current: ${secret.description}`,
                label: "Description",
                onSubmit: (value) => {
                    const description = value.trim();
                    if (description.length === 0) {
                        this.#openUpdatedDescriptionInput(secret, "Enter a description.");
                        return;
                    }
                    this.#updateRegistration(secret, { description });
                },
                onCancel: () => this.#openEditMenu(secret),
            }),
        );
    }

    #openUpdatedVariableNameInput(secret: SecretSummary, error?: string): void {
        this.#showPanel(
            createSecretInputPanel({
                theme: this.#theme,
                title: `Set variable in ${secret.id}`,
                subtitle: error ?? "Enter a new or existing environment variable name",
                label: "Name",
                onSubmit: (value) => {
                    const name = value.trim();
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
                        this.#openUpdatedVariableNameInput(
                            secret,
                            "Enter a valid environment variable name.",
                        );
                        return;
                    }
                    this.#openUpdatedVariableValueInput(secret, name);
                },
                onCancel: () => this.#openEditMenu(secret),
            }),
        );
    }

    #openUpdatedVariableValueInput(secret: SecretSummary, name: string, error?: string): void {
        this.#showPanel(
            createSecretInputPanel({
                theme: this.#theme,
                title: `Set ${name}`,
                subtitle: error ?? "The new value is masked and never added to the transcript",
                label: "Value",
                masked: true,
                onSubmit: (value) => {
                    if (value.includes("\0")) {
                        this.#openUpdatedVariableValueInput(
                            secret,
                            name,
                            "Secret values cannot contain null bytes.",
                        );
                        return;
                    }
                    this.#updateRegistration(secret, { environment: { [name]: value } });
                },
                onCancel: () => this.#openEditMenu(secret),
            }),
        );
    }

    #openRemoveVariableMenu(secret: SecretSummary): void {
        this.#showPanel(
            createSelectionPanel({
                theme: this.#theme,
                title: `Remove variable from ${secret.id}`,
                subtitle: "The rest of the secret remains unchanged",
                items: [
                    ...secret.environmentVariables.map((name) => ({
                        value: name,
                        label: name,
                    })),
                    { value: ":back", label: "Back" },
                ],
                onSelect: (item) => {
                    if (item.value === ":back") {
                        this.#openEditMenu(secret);
                        return;
                    }
                    this.#updateRegistration(secret, {
                        environment: { [item.value]: null },
                    });
                },
                onCancel: () => this.#openEditMenu(secret),
            }),
        );
    }

    #updateRegistration(secret: SecretSummary, update: EnvironmentSecretUpdate): void {
        if (this.#updateSecret === undefined) return;
        this.#closePanel();
        const generation = this.#beginOperation();
        void Promise.resolve()
            .then(() => this.#updateSecret?.(secret.id, update))
            .then((updated) => {
                if (updated === undefined) return;
                this.#registrations = [
                    ...this.#registrations.filter((candidate) => candidate.id !== updated.id),
                    updated,
                ].sort((left, right) => left.id.localeCompare(right.id));
                this.#appendEntry({
                    role: "event",
                    title: "Secrets",
                    text: `Updated secret '${secret.id}'.`,
                });
                if (this.#isCurrentOperation(generation)) this.#showSecretsMenu();
                this.#requestRender();
            })
            .catch(() => {
                const message = "Could not update the selected secret field.";
                this.#appendEntry({ role: "error", text: message });
                if (this.#isCurrentOperation(generation)) this.#openEditMenu(secret, message);
                this.#requestRender();
            });
    }

    #openScopeMenu(secret: SecretSummary, operation: "attach" | "detach"): void {
        this.#showPanel(
            createSelectionPanel({
                theme: this.#theme,
                title: `${operation === "attach" ? "Attach" : "Detach"} ${secret.id}`,
                subtitle: "Choose where this attachment applies",
                selectedValue: "session",
                items: [
                    {
                        value: "session",
                        label: "Session",
                        description: this.#sessionSecretIds.includes(secret.id)
                            ? "This session only · Attached"
                            : "This session only",
                    },
                    {
                        value: "project",
                        label: "Project",
                        description: this.#projectSecretIds.includes(secret.id)
                            ? "All sessions in this project · Attached"
                            : "All sessions in this project",
                    },
                ],
                onSelect: (item) => {
                    const scope = item.value as SecretAttachmentScope;
                    this.#closePanel();
                    this.#changeAttachment(secret, operation, scope);
                },
                onCancel: () => this.#openSecretActions(secret),
            }),
        );
    }

    #openValueInput(draft: SecretRegistrationDraft, name: string, error?: string): void {
        this.#showPanel(
            createSecretInputPanel({
                theme: this.#theme,
                title: `Set ${name}`,
                subtitle: error ?? "The value is masked and will not be added to the transcript",
                label: "Value",
                masked: true,
                onSubmit: (value) => {
                    if (value.includes("\0")) {
                        this.#openValueInput(
                            draft,
                            name,
                            "Secret values cannot contain null bytes.",
                        );
                        return;
                    }
                    this.#openVariableChoice({
                        ...draft,
                        environment: { ...draft.environment, [name]: value },
                    });
                },
                onCancel: () => this.#showSecretsMenu(),
            }),
        );
    }

    #openVariableChoice(draft: SecretRegistrationDraft, notice?: string): void {
        const variableCount = Object.keys(draft.environment).length;
        this.#showPanel(
            createSelectionPanel({
                theme: this.#theme,
                title: "Add Secret",
                subtitle:
                    notice ??
                    `${draft.id} · ${variableCount} environment variable${variableCount === 1 ? "" : "s"}`,
                items: [
                    {
                        value: "register",
                        label: "Register secret",
                        description: "Store this bundle with every value masked.",
                    },
                    {
                        value: "another",
                        label: "Add another variable",
                        description: "Add another name and value to this bundle.",
                    },
                ],
                onSelect: (item) => {
                    if (item.value === "another") {
                        this.#openEnvironmentNameInput(draft);
                        return;
                    }
                    this.#closePanel();
                    this.#registerBundle(draft);
                },
                onCancel: () => this.#showSecretsMenu(),
            }),
        );
    }

    #registerBundle(draft: SecretRegistrationDraft): void {
        if (this.#registerSecret === undefined) return;
        const generation = this.#beginOperation();
        void Promise.resolve()
            .then(() => this.#registerSecret?.(draft))
            .then((secret) => {
                if (secret === undefined) return;
                this.#registrations = [
                    ...this.#registrations.filter((candidate) => candidate.id !== secret.id),
                    secret,
                ].sort((left, right) => left.id.localeCompare(right.id));
                this.#appendEntry({
                    role: "event",
                    title: "Secrets",
                    text: `Registered secret '${secret.id}'.`,
                });
                if (this.#isCurrentOperation(generation)) this.#showSecretsMenu();
                this.#requestRender();
            })
            .catch(() => {
                const message =
                    "Could not register the secret. Check the ID and environment names.";
                this.#appendEntry({
                    role: "error",
                    text: message,
                });
                if (this.#isCurrentOperation(generation)) {
                    this.#openVariableChoice(draft, message);
                }
                this.#requestRender();
            });
    }

    #removeRegistration(secret: SecretSummary): void {
        if (this.#unregisterSecret === undefined) return;
        const generation = this.#beginOperation();
        void Promise.resolve()
            .then(() => this.#unregisterSecret?.(secret.id))
            .then(() => {
                this.#registrations = this.#registrations.filter(
                    (candidate) => candidate.id !== secret.id,
                );
                this.#sessionSecretIds = this.#updateSecretIds(
                    this.#sessionSecretIds,
                    secret.id,
                    false,
                );
                this.#projectSecretIds = this.#updateSecretIds(
                    this.#projectSecretIds,
                    secret.id,
                    false,
                );
                this.#appendEntry({
                    role: "event",
                    title: "Secrets",
                    text: `Removed secret registration '${secret.id}'.`,
                });
                if (this.#isCurrentOperation(generation)) this.#showSecretsMenu();
                this.#requestRender();
            })
            .catch(() => {
                const message = "Could not remove the secret registration.";
                this.#appendEntry({
                    role: "error",
                    text: message,
                });
                if (this.#isCurrentOperation(generation)) {
                    this.#openSecretActions(secret, message);
                }
                this.#requestRender();
            });
    }

    #showPanel(component: Component, listVisible = false): void {
        this.#listVisible = listVisible;
        this.#showPanelCallback(component);
    }

    #showSecretsMenu(): void {
        this.#showPanel(
            createSelectionPanel({
                theme: this.#theme,
                title: "Secrets",
                subtitle: "Values stay masked and are injected only into selected commands",
                items: [
                    {
                        value: "add",
                        label: "Add secret",
                        description: "Register a bundle of environment variables.",
                    },
                    ...this.#registrations.map((secret) => ({
                        value: `secret:${secret.id}`,
                        label: secret.id,
                        description: `${secret.description} · ${secret.environmentVariables.join(", ")} · ${this.#attachmentStatus(secret)}`,
                    })),
                ],
                onSelect: (item) => {
                    if (item.value === "add") {
                        this.#openIdInput();
                        return;
                    }
                    const secret = this.#registrations.find(
                        (candidate) => `secret:${candidate.id}` === item.value,
                    );
                    if (secret !== undefined) this.#openSecretActions(secret);
                },
                onCancel: () => this.#closePanel(),
            }),
            true,
        );
    }

    #updateSecretIds(
        ids: readonly string[],
        secretId: string,
        attached: boolean,
    ): readonly string[] {
        if (!attached) return ids.filter((id) => id !== secretId);
        return ids.includes(secretId) ? [...ids] : [...ids, secretId];
    }
}
