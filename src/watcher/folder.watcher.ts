import path from 'path';
import EventEmitter from 'events';
import chokidar from 'chokidar';
import { logger } from '../logger';
import type { FileWatcherEvent } from '../types';

// ─── Constantes ───────────────────────────────────────────────────────────────

const PROPOSALS_DIR = path.resolve('proposals');
const DEBOUNCE_MS = 2000;

// ─── Tipos internos ───────────────────────────────────────────────────────────

type PendingPair = {
  pdf?: string;
  txt?: string;
  timer?: ReturnType<typeof setTimeout>;
};

// ─── Eventos tipados ──────────────────────────────────────────────────────────

export interface WatcherEvents {
  'pair-ready': (event: FileWatcherEvent) => void;
}

export interface FolderWatcher extends EventEmitter {
  on<K extends keyof WatcherEvents>(event: K, listener: WatcherEvents[K]): this;
  emit<K extends keyof WatcherEvents>(event: K, ...args: Parameters<WatcherEvents[K]>): boolean;
}

// ─── Implementação ────────────────────────────────────────────────────────────

export function startWatcher(): FolderWatcher {
  const emitter = new EventEmitter() as FolderWatcher;

  // Rastreia arquivos pendentes por nome base
  const pending = new Map<string, PendingPair>();

  function getOrCreate(baseName: string): PendingPair {
    if (!pending.has(baseName)) {
      pending.set(baseName, {});
    }
    return pending.get(baseName) as PendingPair;
  }

  function tryEmitPair(baseName: string): void {
    const pair = pending.get(baseName);
    if (!pair?.pdf || !pair?.txt) return;

    // Cancela timer anterior se existir
    if (pair.timer) clearTimeout(pair.timer);

    // Aguarda DEBOUNCE_MS antes de processar (arquivo pode ainda estar sendo copiado)
    pair.timer = setTimeout(() => {
      const event: FileWatcherEvent = {
        pdfPath: pair.pdf as string,
        txtPath: pair.txt as string,
        baseName,
        detectedAt: new Date(),
      };

      logger.info(`[watcher] Par completo detectado: "${baseName}" — emitindo pair-ready`);
      emitter.emit('pair-ready', event);

      // Remove do mapa após emitir para evitar reprocessamento
      pending.delete(baseName);
    }, DEBOUNCE_MS);
  }

  const watcher = chokidar.watch(PROPOSALS_DIR, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 200,
    },
  });

  watcher.on('add', (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath, ext);

    if (ext !== '.pdf' && ext !== '.txt') {
      logger.debug(`[watcher] Arquivo ignorado (extensão não suportada): ${filePath}`);
      return;
    }

    logger.info(`[watcher] Arquivo detectado [${ext}]: ${filePath}`);

    const pair = getOrCreate(baseName);

    if (ext === '.pdf') {
      pair.pdf = filePath;
    } else {
      pair.txt = filePath;
    }

    tryEmitPair(baseName);
  });

  watcher.on('error', (err: unknown) => {
    logger.error('[watcher] Erro no chokidar:', err instanceof Error ? err : new Error(String(err)));
  });

  watcher.on('ready', () => {
    logger.info(`[watcher] Monitorando: ${PROPOSALS_DIR}`);
  });

  return emitter;
}
