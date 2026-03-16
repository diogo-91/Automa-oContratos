/**
 * Autorização OAuth2 do Google Drive — roda UMA VEZ para salvar o refresh token.
 *
 * Pré-requisitos no .env:
 *   GOOGLE_OAUTH_CLIENT_ID=...
 *   GOOGLE_OAUTH_CLIENT_SECRET=...
 *
 * Uso:
 *   npx tsx scripts/authorize-google-drive.ts
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ override: true });

import { google } from 'googleapis';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

// ─── Config ───────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000/oauth/callback';
const TOKEN_PATH    = process.env.GOOGLE_OAUTH_TOKEN_PATH ?? './credentials/google-oauth-token.json';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ Variáveis de ambiente não encontradas.');
  console.error('   Adicione ao .env:');
  console.error('     GOOGLE_OAUTH_CLIENT_ID=...');
  console.error('     GOOGLE_OAUTH_CLIENT_SECRET=...\n');
  process.exit(1);
}

// ─── OAuth2 Client ────────────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope:       ['https://www.googleapis.com/auth/drive'],
  prompt:      'consent', // garante retorno do refresh_token sempre
});

// ─── Abre o navegador ─────────────────────────────────────────────────────────

console.log('\n🔐 Autorizando acesso ao Google Drive...');
console.log('📌 Abrindo navegador. Se não abrir automaticamente, acesse:');
console.log(`\n   ${authUrl}\n`);

// Windows: start, Mac: open, Linux: xdg-open
const openCmd = process.platform === 'win32'
  ? `start "" "${authUrl}"`
  : process.platform === 'darwin'
    ? `open "${authUrl}"`
    : `xdg-open "${authUrl}"`;

exec(openCmd, (err) => {
  if (err) console.warn('   (Não foi possível abrir o navegador automaticamente)');
});

// ─── Servidor local para capturar o callback ──────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth/callback')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const url  = new URL(req.url, `http://localhost:3000`);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>❌ Código de autorização não encontrado.</h2>');
    server.close();
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    // Salva tokens (inclui refresh_token)
    fs.mkdirSync(path.dirname(path.resolve(TOKEN_PATH)), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    console.log(`\n✅ Autorização concluída!`);
    console.log(`   Token salvo em: ${TOKEN_PATH}`);
    console.log('   A partir de agora, os contratos serão salvos no Drive com sua conta.\n');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:2rem">
        <h2>✅ Autorização concluída!</h2>
        <p>O sistema está pronto para salvar contratos no Google Drive.</p>
        <p>Pode fechar esta aba e voltar ao terminal.</p>
      </body></html>
    `);

    server.close();
    process.exit(0);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Erro ao trocar código por tokens: ${msg}\n`);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ Erro</h2><p>${msg}</p>`);
    server.close();
    process.exit(1);
  }
});

server.listen(3000, () => {
  console.log('⏳ Aguardando autorização em http://localhost:3000/oauth/callback ...');
});
