# ============================================================================
# PulseCord — Multi-Stage Production Dockerfile for Railway Deployment
# ============================================================================

FROM node:22-alpine AS builder
WORKDIR /app

# Install OpenSSL for Prisma Client on Alpine Linux
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci
RUN npx prisma generate

COPY . .
RUN npm run build

# Production Runner Stage
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/index.html ./index.html
COPY --from=builder /app/favicon.ico ./favicon.ico
COPY --from=builder /app/css ./css
COPY --from=builder /app/js ./js
COPY --from=builder /app/public ./public

# Railway injects dynamic $PORT at runtime
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/index.js"]
