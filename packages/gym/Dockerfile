# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY docs docs
COPY packages/gym/package.json packages/gym/package.json
COPY packages/gym-tests/package.json packages/gym-tests/package.json
COPY packages/ghostty-web/package.json packages/ghostty-web/package.json
COPY packages/rig-codemode-codex/package.json packages/rig-codemode-codex/package.json
COPY packages/happy-plugins/package.json packages/happy-plugins/package.json
COPY packages/happy-worklets/package.json packages/happy-worklets/package.json
COPY packages/happy-providers/package.json packages/happy-providers/package.json
COPY packages/happy-agent-features/package.json packages/happy-agent-features/package.json
COPY packages/rig/package.json packages/rig/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile

COPY packages/ghostty-web packages/ghostty-web
COPY packages/rig-codemode-codex packages/rig-codemode-codex
COPY packages/happy-plugins packages/happy-plugins
COPY packages/happy-worklets packages/happy-worklets
COPY packages/happy-providers packages/happy-providers
COPY packages/happy-agent-features packages/happy-agent-features
COPY packages/rig packages/rig
RUN pnpm --filter @slopus/ghostty-web build
RUN pnpm --filter @slopus/rig-codemode-codex build
RUN pnpm --filter happy-plugins build
RUN pnpm --filter happy-worklets build
RUN pnpm --filter @slopus/happy-providers build
RUN pnpm --filter @slopus/happy-agent-features build
RUN pnpm --filter @slopus/rig build
# The gym runs Rig from the TypeScript sources it mounts over this image, so the deployment keeps
# development dependencies: the published bundle compiles them in, but the sources still import
# them directly.
RUN pnpm --filter @slopus/rig deploy --legacy /prod/rig
# The deployed @slopus/ghostty-web ships only its build output, so point its exports at the build
# instead of the TypeScript sources it normally resolves to inside the workspace.
RUN node --input-type=module --eval "import { readFileSync, writeFileSync } from 'node:fs'; const path = '/prod/rig/node_modules/@slopus/ghostty-web/package.json'; const manifest = JSON.parse(readFileSync(path, 'utf8')); manifest.exports['.'] = { types: './dist/index.d.ts', default: './dist/index.js' }; writeFileSync(path, JSON.stringify(manifest, null, 2) + '\\n')"
RUN pnpm --filter @slopus/rig-gym-tests deploy --prod --legacy /prod/gym

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        bubblewrap \
        ca-certificates \
        git \
        procps \
        ripgrep \
        socat \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory /workspace

WORKDIR /app
COPY --from=build /prod/rig packages/rig
COPY --from=build /prod/gym gym

ENV HOME=/home/rig
ENV TERM=xterm-256color
RUN mkdir -p /home/rig /workspace && chown -R node:node /home/rig /workspace

USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/packages/rig/dist/main.js"]
