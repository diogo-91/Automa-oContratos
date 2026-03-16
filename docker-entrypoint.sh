#!/bin/sh
set -e

# Injeta o JSON da Service Account do Google a partir de variável de ambiente
# Configure GOOGLE_SERVICE_ACCOUNT_JSON no EasyPanel com o conteúdo do arquivo JSON
if [ -n "$GOOGLE_SERVICE_ACCOUNT_JSON" ]; then
  node -e "
const fs = require('fs');
const json = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
fs.writeFileSync('./credentials/google-service-account.json', JSON.stringify(json, null, 2));
console.log('[entrypoint] Google Service Account credentials escritas em ./credentials/google-service-account.json');
"
else
  echo "[entrypoint] AVISO: GOOGLE_SERVICE_ACCOUNT_JSON não definida — certifique-se de que o arquivo já existe."
fi

exec node dist/index.js
