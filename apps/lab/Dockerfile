# Build context is the repo root — the lab is a workspace package and installs
# from the root lockfile so the image matches what CI resolved.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
# Never prompt: a Docker build has nobody to answer, and pnpm will otherwise
# block forever asking to purge node_modules.
ENV CI=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/lab/package.json apps/lab/
COPY packages/agents/package.json packages/agents/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/injectors/package.json packages/injectors/
COPY packages/observers/package.json packages/observers/
COPY packages/report/package.json packages/report/

RUN pnpm install --frozen-lockfile --filter @alarmdrill/lab...

COPY tsconfig.base.json ./
COPY apps/lab apps/lab
RUN pnpm --filter @alarmdrill/lab build

# Runtime installs production dependencies into an empty tree rather than
# pruning the build stage's — no purge, so nothing can prompt.
FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /repo
ENV NODE_ENV=production CI=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/lab/package.json apps/lab/
COPY packages/agents/package.json packages/agents/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/injectors/package.json packages/injectors/
COPY packages/observers/package.json packages/observers/
COPY packages/report/package.json packages/report/

RUN pnpm install --frozen-lockfile --filter @alarmdrill/lab... --prod

COPY --from=build /repo/apps/lab/dist apps/lab/dist

WORKDIR /repo/apps/lab
CMD ["node", "dist/main.js"]
