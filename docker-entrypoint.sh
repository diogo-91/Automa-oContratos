#!/bin/sh
set -e

# Injeta o JSON da Service Account do Google a partir de variável de ambiente
# Configure GOOGLE_SERVICE_ACCOUNT_JSON no EasyPanel com o conteúdo do arquivo JSON
if [ -n "$GOOGLE_SERVICE_ACCOUNT_JSON" ]; then
  echo "$GOOGLE_SERVICE_ACCOUNT_JSON" > ./credentials/google-service-account.json
  echo "[entrypoint] Google Service Account credentials escritas em ./credentials/google-service-account.json"
else
  echo "[entrypoint] AVISO: GOOGLE_SERVICE_ACCOUNT_JSON não definida — certifique-se de que o arquivo já existe."
fi

exec node dist/index.js
