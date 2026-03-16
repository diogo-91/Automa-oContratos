#!/bin/sh
set -e

# Suporta credenciais em Base64 (recomendado) ou JSON puro
if [ -n "$GOOGLE_SERVICE_ACCOUNT_JSON_B64" ]; then
  echo "$GOOGLE_SERVICE_ACCOUNT_JSON_B64" | base64 -d > ./credentials/google-service-account.json
  echo "[entrypoint] Google Service Account credentials escritas (base64) em ./credentials/google-service-account.json"
elif [ -n "$GOOGLE_SERVICE_ACCOUNT_JSON" ]; then
  printf '%s' "$GOOGLE_SERVICE_ACCOUNT_JSON" > ./credentials/google-service-account.json
  echo "[entrypoint] Google Service Account credentials escritas em ./credentials/google-service-account.json"
else
  echo "[entrypoint] AVISO: GOOGLE_SERVICE_ACCOUNT_JSON_B64 não definida — certifique-se de que o arquivo já existe."
fi

exec node dist/index.js
