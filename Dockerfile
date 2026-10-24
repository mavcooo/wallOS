# syntax=docker/dockerfile:1.7
#
# Micro-servizio auth + topologia (Fastify).
# Il frontend è una SPA statica: va servita da nginx/qualsiasi statico e
# proxata su questo container per `/api` (vedi README, "Docker").

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.server.json tsconfig.build-server.json ./
COPY server ./server
COPY src/types ./src/types
RUN npm run build:server

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Solo dipendenze di runtime: niente TypeScript, tsx o tooling di test.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist-server ./dist-server

# Utente non privilegiato: `node` esiste già nell'immagine ufficiale.
USER node
EXPOSE 8787

# 503 (database irraggiungibile) = container unhealthy, non solo processo vivo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
