import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ override: true });
import fs from 'fs';
import { logger }              from './logger';
import { startDriveWatcher }  from './watcher/googledrive.watcher';
import { downloadTemplate }   from './services/googledrive.service';
import { processarContrato }  from './workflows/contract.workflow';
import type { DriveFileWatcherEvent } from './types';

// ─── Garantir pastas locais ───────────────────────────────────────────────────

for (const dir of ['./contracts', './templates', './temp', './logs']) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(): void {
  logger.info('╔══════════════════════════════════════════════════╗');
  logger.info('║       CONTRACT AUTOMATION  v2.0.0                ║');
  logger.info('║  Gemini · Claude · BrasilAPI · Reg. Imóveis      ║');
  logger.info('║  Fonte: Google Drive  →  WhatsApp                ║');
  logger.info('╚══════════════════════════════════════════════════╝');
  logger.info(`Node ${process.version} | PID ${process.pid} | ENV: ${process.env.NODE_ENV ?? 'development'}`);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  printBanner();

  // 1. Baixa o template Contrato_ECL.docx do Drive na inicialização
  logger.info('[main] Baixando template do Google Drive...');
  try {
    const templatePath = await downloadTemplate();
    logger.info(`[main] Template pronto: ${templatePath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[main] ✖ Falha ao baixar template: ${msg}`);
    logger.error('[main] Configure GOOGLE_DRIVE_TEMPLATE_FOLDER_ID no .env e reinicie.');
    process.exit(1);
  }

  // 2. Inicia o watcher do Google Drive
  logger.info('[main] Iniciando monitoramento do Google Drive...');
  const watcher = startDriveWatcher();

  // 3. Escuta eventos de par detectado
  watcher.on('pair-ready', async (event: DriveFileWatcherEvent) => {
    logger.info(`[main] ▶ Par detectado: "${event.clientFolderName}" — iniciando workflow`);

    const result = await processarContrato(event);

    if (result.success) {
      logger.info(`[main] ✔ "${event.clientFolderName}" concluído com sucesso`);
      logger.info(`[main]   → Contrato : ${result.contratoPath}`);
      logger.info(`[main]   → Drive    : ${result.driveFileId ?? 'N/A'}`);
      logger.info(`[main]   → Link     : ${result.linkAssinatura}`);
      logger.info(`[main]   → DocID    : ${result.documentId}`);
      logger.info(`[main]   → WhatsApp : ${result.whatsappSent ? 'enviado ✔' : 'falhou ✘'}`);
    } else {
      logger.error(`[main] ✖ "${event.clientFolderName}" falhou: ${result.error ?? 'erro desconhecido'}`);
    }
  });

  logger.info('[main] Sistema pronto. Aguardando clientes no Google Drive...');
  logger.info('[main] Estrutura esperada:');
  logger.info('[main]   CONTRATOS/');
  logger.info('[main]     CLIENTE JOÃO/');
  logger.info('[main]       proposta.pdf');
  logger.info('[main]       cnpj.txt');
  logger.info('[main] Produção: npm run build && pm2 start ecosystem.config.js');
}

// ─── Inicialização ────────────────────────────────────────────────────────────

bootstrap().catch((err: unknown) => {
  logger.error(
    '[main] Erro fatal no bootstrap',
    err instanceof Error ? err : new Error(String(err)),
  );
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT',  () => { logger.info('[main] SIGINT  — encerrando.'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('[main] SIGTERM — encerrando.'); process.exit(0); });

process.on('uncaughtException', (err: Error) => {
  logger.error('[main] uncaughtException:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error(`[main] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
