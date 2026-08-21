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
COPY packages/happy-agent-gym/package.json packages/happy-agent-gym/package.json
COPY packages/happy-providers/package.json packages/happy-providers/package.json
COPY packages/happy-agent-modules/package.json packages/happy-agent-modules/package.json
COPY packages/happy-agent/package.json packages/happy-agent/package.json
COPY packages/happy-terminal/package.json packages/happy-terminal/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile

COPY packages/ghostty-web packages/ghostty-web
COPY packages/happy-agent-gym packages/happy-agent-gym
COPY packages/happy-providers packages/happy-providers
COPY packages/happy-agent-modules packages/happy-agent-modules
COPY packages/happy-agent packages/happy-agent
COPY packages/happy-terminal packages/happy-terminal
RUN pnpm --filter @slopus/ghostty-web build
RUN pnpm --filter @slopus/happy-providers build
RUN pnpm --filter @slopus/happy-agent-modules build
RUN pnpm --filter @slopus/happy-agent build
RUN pnpm --filter @slopus/happy-terminal build
RUN pnpm --filter @slopus/happy-terminal deploy --legacy /prod/happy-terminal
# The Gym is a development build. Give Happy Terminal the daemon built from this checkout so an isolated
# fixture never downloads a production release from GitHub.
RUN pnpm --filter @slopus/happy-agent deploy --prod --legacy /prod/happy-agent
# Every deployed @slopus/ghostty-web copy ships only its build output, so point its exports at the
# build instead of the TypeScript sources it normally resolves to inside the workspace. pnpm may
# install both a published copy and a workspace-file copy at different physical paths.
RUN find /prod/happy-terminal/node_modules /prod/happy-agent/node_modules \
    -path '*/@slopus/ghostty-web/package.json' \
    -exec node --input-type=module --eval "import { readFileSync, writeFileSync } from 'node:fs'; const path = process.argv[1]; const manifest = JSON.parse(readFileSync(path, 'utf8')); manifest.exports['.'] = { types: './dist/index.d.ts', default: './dist/index.js' }; writeFileSync(path, JSON.stringify(manifest, null, 2) + '\\n')" {} \;
RUN pnpm --filter @slopus/happy-terminal-gym-tests deploy --prod --legacy /prod/gym

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
COPY --from=build /prod/happy-terminal packages/happy-terminal
COPY --from=build /prod/happy-agent happy-agent
COPY --from=build /prod/gym gym

ENV HOME=/home/happy-terminal
ENV HAPPY_TERMINAL_GYM_HAPPY_AGENT_COMMAND="[\"node\",\"/app/happy-agent/dist/cli.js\"]"
ENV TERM=xterm-256color
RUN mkdir -p /home/happy-terminal /workspace && chown -R node:node /home/happy-terminal /workspace

USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/packages/happy-terminal/dist/main.js"]
