FROM node:22-alpine AS builder
WORKDIR /app/mcp
COPY mcp/package*.json ./
RUN npm ci
COPY mcp/tsconfig.json ./
COPY mcp/src ./src
RUN npm run build
WORKDIR /app/agent
COPY agent/package*.json ./
RUN npm ci
COPY agent/tsconfig.json ./
COPY agent/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app/agent
COPY --from=builder /app/mcp /app/mcp
COPY --from=builder /app/agent/dist ./dist
COPY --from=builder /app/agent/node_modules ./node_modules
COPY agent/package.json ./
COPY agent/skills ./skills
COPY proto /app/proto
ENV PROTO_DIR=/app/proto

# Run as an unprivileged user. The agent persists task-outbox.json,
# workspaces.json and its executor identity under AGENT_DATA_DIR, so that
# directory must be writable. Named volumes seed ownership from the image on
# first mount; a pre-existing root-owned agent-data volume needs a one-time
# `docker compose --profile agent exec agent chown -R 10001:10001 /app/data`.
RUN addgroup -S -g 10001 agent \
    && adduser -S -u 10001 -G agent -H -h /app/agent agent \
    && mkdir -p /app/data/agent \
    && chown -R agent:agent /app/data

ENV AGENT_DATA_DIR=/app/data/agent

EXPOSE 50054

USER agent

CMD ["node", "dist/index.js"]
