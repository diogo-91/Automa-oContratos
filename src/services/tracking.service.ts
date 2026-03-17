import { getDb } from '../db/database';
import { logger } from '../logger';

// ─── Nomes das etapas do pipeline ────────────────────────────────────────────

export const STEP_NAMES: Record<number, string> = {
  1: 'Extrair proposta (Gemini)',
  2: 'Extrair dados cliente (Claude)',
  3: 'Consultar CNPJ (BrasilAPI)',
  4: 'Validar dados do contrato (Claude)',
  5: 'Gerar contrato .docx',
  6: 'Converter .docx para PDF',
  7: 'Upload Google Drive',
  8: 'Assinatura digital (Assinafy)',
  9: 'Notificação WhatsApp',
};

export const TOTAL_STEPS = Object.keys(STEP_NAMES).length;

// ─── Interface ────────────────────────────────────────────────────────────────

export interface Tracker {
  contractId:     number;        // -1 = tracker inativo (DB falhou na inicialização)
  folderId:       string;
  stepStartTimes: Map<number, number>;
}

// ─── Funções públicas ─────────────────────────────────────────────────────────

/**
 * Inicializa o rastreamento de um contrato.
 * Se a pasta já existir no banco, reinicia o ciclo (reprocessamento).
 * Nunca lança exceção — retorna tracker com contractId = -1 em caso de falha.
 */
export function criarRastreamento(folderId: string, folderName: string): Tracker {
  try {
    const db = getDb();

    db.prepare(`
      INSERT INTO contracts (folder_id, folder_name, status, current_step)
      VALUES (?, ?, 'iniciado', 0)
      ON CONFLICT(folder_id) DO UPDATE SET
        status        = 'iniciado',
        current_step  = 0,
        error_message = NULL,
        error_step    = NULL,
        completed_at  = NULL,
        duration_ms   = NULL,
        started_at    = datetime('now','localtime')
    `).run(folderId, folderName);

    const row = db.prepare(
      'SELECT id FROM contracts WHERE folder_id = ?',
    ).get(folderId) as { id: number };

    const contractId = row.id;

    // Recria as etapas sempre zeradas
    db.prepare('DELETE FROM contract_steps WHERE contract_id = ?').run(contractId);

    const insertStep = db.prepare(`
      INSERT INTO contract_steps (contract_id, step_number, step_name, status)
      VALUES (?, ?, ?, 'pending')
    `);
    for (const [num, name] of Object.entries(STEP_NAMES)) {
      insertStep.run(contractId, Number(num), name);
    }

    logger.debug(`[tracking] Rastreamento criado — contractId: ${contractId}`);
    return { contractId, folderId, stepStartTimes: new Map() };

  } catch (err) {
    logger.warn(`[tracking] criarRastreamento falhou (rastreamento desativado): ${err}`);
    return { contractId: -1, folderId, stepStartTimes: new Map() };
  }
}

/** Marca etapa como em execução e atualiza o progresso no contrato. */
export function iniciarEtapa(tracker: Tracker, stepNumber: number): void {
  if (tracker.contractId < 0) return;
  try {
    const db = getDb();
    tracker.stepStartTimes.set(stepNumber, Date.now());

    db.prepare(`
      UPDATE contract_steps
      SET status = 'running', started_at = datetime('now','localtime')
      WHERE contract_id = ? AND step_number = ?
    `).run(tracker.contractId, stepNumber);

    db.prepare(`
      UPDATE contracts SET current_step = ?, status = 'processando' WHERE id = ?
    `).run(stepNumber, tracker.contractId);

  } catch (err) {
    logger.warn(`[tracking] iniciarEtapa(${stepNumber}) error: ${err}`);
  }
}

/** Marca etapa como concluída com sucesso. */
export function concluirEtapa(tracker: Tracker, stepNumber: number): void {
  if (tracker.contractId < 0) return;
  try {
    const db    = getDb();
    const start = tracker.stepStartTimes.get(stepNumber);
    const ms    = start ? Date.now() - start : null;

    db.prepare(`
      UPDATE contract_steps
      SET status = 'success', completed_at = datetime('now','localtime'), duration_ms = ?
      WHERE contract_id = ? AND step_number = ?
    `).run(ms, tracker.contractId, stepNumber);

  } catch (err) {
    logger.warn(`[tracking] concluirEtapa(${stepNumber}) error: ${err}`);
  }
}

/** Marca etapa como erro e atualiza status do contrato. */
export function erroEtapa(tracker: Tracker, stepNumber: number, errorMessage: string): void {
  if (tracker.contractId < 0) return;
  try {
    const db    = getDb();
    const start = tracker.stepStartTimes.get(stepNumber);
    const ms    = start ? Date.now() - start : null;

    db.prepare(`
      UPDATE contract_steps
      SET status = 'error', error_msg = ?,
          completed_at = datetime('now','localtime'), duration_ms = ?
      WHERE contract_id = ? AND step_number = ?
    `).run(errorMessage, ms, tracker.contractId, stepNumber);

    db.prepare(`
      UPDATE contracts
      SET status = 'erro', error_message = ?, error_step = ?,
          completed_at = datetime('now','localtime')
      WHERE id = ?
    `).run(errorMessage, STEP_NAMES[stepNumber] ?? `Etapa ${stepNumber}`, tracker.contractId);

  } catch (err) {
    logger.warn(`[tracking] erroEtapa(${stepNumber}) error: ${err}`);
  }
}

/** Atualiza campos de negócio do contrato. Aceita campos parciais. */
export function atualizarDados(
  tracker: Tracker,
  dados: {
    nomeCliente?:    string;
    razaoSocial?:    string;
    emailCliente?:   string;
    telefone?:       string;
    cnpj?:           string;
    linkAssinatura?: string;
    driveFileId?:    string;
    assinafyDocId?:  string;
  },
): void {
  if (tracker.contractId < 0) return;
  try {
    const db     = getDb();
    const fields: string[] = [];
    const values: unknown[] = [];

    const push = (col: string, val: unknown) => { fields.push(`${col} = ?`); values.push(val); };
    if (dados.nomeCliente    !== undefined) push('nome_cliente',    dados.nomeCliente);
    if (dados.razaoSocial    !== undefined) push('razao_social',    dados.razaoSocial);
    if (dados.emailCliente   !== undefined) push('email_cliente',   dados.emailCliente);
    if (dados.telefone       !== undefined) push('telefone',        dados.telefone);
    if (dados.cnpj           !== undefined) push('cnpj',            dados.cnpj);
    if (dados.linkAssinatura !== undefined) push('link_assinatura', dados.linkAssinatura);
    if (dados.driveFileId    !== undefined) push('drive_file_id',   dados.driveFileId);
    if (dados.assinafyDocId  !== undefined) push('assinafy_doc_id', dados.assinafyDocId);

    if (fields.length === 0) return;
    values.push(tracker.contractId);
    db.prepare(`UPDATE contracts SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  } catch (err) {
    logger.warn(`[tracking] atualizarDados error: ${err}`);
  }
}

/** Finaliza o rastreamento marcando o contrato como concluído. */
export function concluirRastreamento(
  tracker: Tracker,
  resultado: { whatsappSent?: boolean; pdfEnviadoWpp?: boolean },
): void {
  if (tracker.contractId < 0) return;
  try {
    const db       = getDb();
    const contract = db.prepare(
      'SELECT started_at FROM contracts WHERE id = ?',
    ).get(tracker.contractId) as { started_at: string } | undefined;

    const startMs    = contract ? new Date(contract.started_at).getTime() : Date.now();
    const durationMs = Date.now() - startMs;

    db.prepare(`
      UPDATE contracts
      SET status = 'concluido',
          whatsapp_sent   = ?,
          pdf_enviado_wpp = ?,
          completed_at    = datetime('now','localtime'),
          duration_ms     = ?
      WHERE id = ?
    `).run(
      resultado.whatsappSent  ? 1 : 0,
      resultado.pdfEnviadoWpp ? 1 : 0,
      durationMs,
      tracker.contractId,
    );

    logger.debug(`[tracking] Rastreamento concluído — contractId: ${tracker.contractId} | ${durationMs}ms`);

  } catch (err) {
    logger.warn(`[tracking] concluirRastreamento error: ${err}`);
  }
}
