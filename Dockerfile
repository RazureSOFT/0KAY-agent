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
EXPOSE 50054
CMD ["node", "dist/index.js"]
