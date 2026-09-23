FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY agent/package.json agent/package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source
COPY agent/ .

# Build
RUN npm run build

# Runtime
FROM node:20-alpine

WORKDIR /app

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json .

EXPOSE 50054

CMD ["node", "dist/index.js"]
