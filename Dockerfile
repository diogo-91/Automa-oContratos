# ── Stage 1: Build ──────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production ─────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Instala apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev

# Copia build e arquivos necessários
COPY --from=builder /app/dist ./dist
COPY ecosystem.config.js ./
COPY templates/ ./templates/
COPY credentials/.gitkeep ./credentials/

# Cria diretórios de runtime
RUN mkdir -p logs temp contracts proposals

# Entrypoint que injeta as credenciais via variável de ambiente
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
