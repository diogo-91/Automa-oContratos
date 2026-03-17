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

# Instala LibreOffice para conversão docx → pdf
RUN apk add --no-cache libreoffice openjdk11-jre font-liberation

# Instala apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev

# Copia build e arquivos necessários
COPY --from=builder /app/dist ./dist
COPY ecosystem.config.js ./
COPY templates/ ./templates/
COPY credentials/ ./credentials/
COPY public/ ./public/

# Cria diretórios de runtime
RUN mkdir -p logs temp contracts proposals data

# Entrypoint que injeta as credenciais via variável de ambiente
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
