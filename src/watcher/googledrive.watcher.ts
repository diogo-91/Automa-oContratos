import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger';
import {
  listarPastasClientes,
  exportPropostaComoPdf,
  exportArquivoComoTexto,
  marcarPastaComoProcessando,
} from '../services/googledrive.service';
import type { DriveFileWatcherEvent } from '../types';

// ─── Config ───────────────────────────────────────────────────────────────────

// Lido dentro de startDriveWatcher() para garantir que dotenv já carregou
function getPollIntervalMs(): number {
  return parseInt(process.env.DRIVE_POLL_INTERVAL_MS ?? '120000', 10);
}

const TEMP_DIR = path.resolve('./temp');

// ─── Estado interno ───────────────────────────────────────────────────────────

/** Pastas já despachadas nesta sessão — evita reprocessamento */
const despachadas = new Set<string>();

// ─── Watcher ──────────────────────────────────────────────────────────────────

/**
 * Inicia o polling do Google Drive.
 * Emite o evento 'pair-ready' com DriveFileWatcherEvent
 * sempre que uma pasta de cliente tiver PDF + TXT prontos.
 */
export function startDriveWatcher(): EventEmitter {
  const emitter = new EventEmitter();

  const POLL_INTERVAL_MS = getPollIntervalMs();
  logger.info(`[drive-watcher] Iniciando polling do Google Drive`);
  logger.info(`[drive-watcher] Intervalo: ${POLL_INTERVAL_MS / 1000}s`);

  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const poll = async (): Promise<void> => {
    logger.debug('[drive-watcher] Verificando Google Drive...');

    try {
      const pastas = await listarPastasClientes();

      for (const pasta of pastas) {
        // Só processa se tiver PDF + TXT e ainda não foi despachada
        if (!pasta.isReady || despachadas.has(pasta.folderId)) continue;

        logger.info(`[drive-watcher] ✅ Par encontrado: "${pasta.clientName}"`);

        // Reserva a pasta imediatamente para evitar duplo disparo
        despachadas.add(pasta.folderId);

        try {
          // Marca IMEDIATAMENTE no Drive para evitar reprocessamento duplo
          // (mesmo que o processo reinicie, a pasta estará marcada)
          await marcarPastaComoProcessando(pasta.folderId, pasta.clientName);

          // Diretório temporário exclusivo para este cliente
          const clientTempDir = path.join(TEMP_DIR, pasta.folderId);
          fs.mkdirSync(clientTempDir, { recursive: true });

          // Download da proposta (converte para PDF se necessário)
          logger.info(`[drive-watcher] Baixando proposta: ${pasta.pdfFileName}`);
          const pdfPath = await exportPropostaComoPdf(
            pasta.pdfFileId!,
            pasta.pdfMimeType,
            pasta.pdfFileName!,
            clientTempDir,
          );

          // Dados do cliente: qualquer formato → salvo como .txt
          const txtPath = path.join(clientTempDir, 'dados_cliente.txt');
          logger.info(`[drive-watcher] Exportando dados do cliente: ${pasta.txtFileName} (${pasta.txtMimeType})`);
          await exportArquivoComoTexto(pasta.txtFileId!, pasta.txtMimeType, txtPath);

          // Lê o conteúdo em memória imediatamente para evitar ENOENT posterior
          const txtContent = fs.readFileSync(txtPath, 'utf-8');
          logger.debug(`[drive-watcher] Conteúdo dados_cliente.txt lido (${txtContent.length} chars)`);

          const event: DriveFileWatcherEvent = {
            // FileWatcherEvent base
            pdfPath,
            txtPath,
            baseName:   pasta.clientName,
            detectedAt: new Date(),
            // Drive-específico
            folderId:         pasta.folderId,
            clientFolderName: pasta.clientName,
            pdfFileId:        pasta.pdfFileId!,
            txtFileId:        pasta.txtFileId!,
            txtContent,
          };

          emitter.emit('pair-ready', event);

        } catch (downloadErr) {
          // Remove da lista de despachadas para tentar novamente na próxima rodada
          despachadas.delete(pasta.folderId);

          const msg = downloadErr instanceof Error
            ? downloadErr.message
            : String(downloadErr);

          logger.error(
            `[drive-watcher] Erro ao baixar arquivos de "${pasta.clientName}": ${msg}`,
          );
        }
      }

    } catch (pollErr) {
      const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
      logger.error(`[drive-watcher] Erro no polling: ${msg}`);
    }
  };

  // Disparo imediato na inicialização
  poll().catch((err: unknown) => {
    logger.error('[drive-watcher] Erro no primeiro polling:', err);
  });

  // Polling recorrente
  const timer = setInterval(() => {
    poll().catch((err: unknown) => {
      logger.error('[drive-watcher] Erro no polling recorrente:', err);
    });
  }, POLL_INTERVAL_MS);

  // Libera o timer quando o processo encerrar
  timer.unref();

  return emitter;
}
