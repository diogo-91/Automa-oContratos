/**
 * migrate-from-logs.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Importa contratos históricos do combined.log para o banco SQLite.
 *
 * Uso:
 *   npx tsx scripts/migrate-from-logs.ts
 *   npx tsx scripts/migrate-from-logs.ts --dry-run   (mostra o que seria importado, sem gravar)
 *   npx tsx scripts/migrate-from-logs.ts --log ./logs/combined.log
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ override: true });

import fs   from 'fs';
import path from 'path';
import { getDb } from '../src/db/database';
import { STEP_NAMES, TOTAL_STEPS } from '../src/services/tracking.service';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const logArg  = args.find(a => a.startsWith('--log=')) ?? args[args.indexOf('--log') + 1];
const LOG_PATH = logArg && !logArg.startsWith('--')
  ? logArg
  : path.join(process.cwd(), 'logs', 'combined.log');

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface WorkflowSession {
  folderName:     string;
  startedAt:      string;
  completedAt?:   string;
  nomeCliente?:   string;
  razaoSocial?:   string;
  emailCliente?:  string;
  cnpj?:          string;
  linkAssinatura?: string;
  assinafyDocId?: string;
  driveFileId?:   string;
  whatsappSent:   boolean;
  status:         'concluido' | 'erro';
  errorMessage?:  string;
  errorStep?:     string;
  failedStep?:    number;
}

// ─── Parser de linha de log ───────────────────────────────────────────────────

const RE_DATE    = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const RE_INICIO  = /\[workflow\] ▶ Iniciando: "(.+?)"/;
const RE_CONC    = /\[workflow\] ✔ Concluído: "(.+?)" \| docId: (\S+) \| drive: (\S+) \| whatsapp: (true|false)/;
const RE_ERRO    = /\[workflow\] ✖ Falha na etapa "(.+?)" \| cliente: "(.+?)" \| (.+)/;
const RE_CLIENTE = /\[workflow\]\s+Cliente: (.+)/;
const RE_RAZAO   = /\[workflow\]\s+Razão Social: (.+)/;
const RE_CNPJ    = /\[workflow\]\s+CNPJ: (\d+)/;
const RE_EMAIL   = /\[workflow\]\s+CNPJ: \S+ \| email: (\S+)/;
const RE_LINK    = /\[workflow\]\s+Link: (https:\/\/\S+)/;

// Mapa de nome de etapa → número
const STEP_NAME_TO_NUM: Record<string, number> = {};
for (const [num, name] of Object.entries(STEP_NAMES)) {
  STEP_NAME_TO_NUM[name.toLowerCase()] = Number(num);
}
function stepNumFromName(name: string): number {
  const lower = name.toLowerCase();
  for (const [key, num] of Object.entries(STEP_NAME_TO_NUM)) {
    if (key.includes(lower) || lower.includes(key.split(' ')[0])) return num;
  }
  return 0;
}

// ─── Parse do arquivo de log ──────────────────────────────────────────────────

function parseLogs(logPath: string): WorkflowSession[] {
  if (!fs.existsSync(logPath)) {
    console.error(`❌ Arquivo de log não encontrado: ${logPath}`);
    process.exit(1);
  }

  const lines    = fs.readFileSync(logPath, 'utf-8').split('\n');
  const sessions = new Map<string, WorkflowSession>(); // key = folderName
  const completed: WorkflowSession[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const dateMatch = line.match(RE_DATE);
    const timestamp = dateMatch?.[1] ?? '';

    // ── Início ──────────────────────────────────────────────────────────────
    const mInicio = line.match(RE_INICIO);
    if (mInicio) {
      const folderName = mInicio[1];
      // Se já havia uma sessão aberta com mesmo nome (sem conclusão), descarta
      sessions.set(folderName, {
        folderName,
        startedAt:   timestamp,
        whatsappSent: false,
        status:      'concluido', // será sobrescrito se houver erro
      });
      continue;
    }

    // ── Dados extraídos ao longo do workflow ────────────────────────────────
    const session = [...sessions.values()].find(s =>
      line.includes(`"${s.folderName}"`) || sessions.size === 1,
    );

    const mCliente = line.match(RE_CLIENTE);
    if (mCliente && mCliente[1].trim()) {
      // Atribui ao último workflow ativo
      const last = [...sessions.values()].at(-1);
      if (last && !last.nomeCliente) last.nomeCliente = mCliente[1].trim();
    }

    const mRazao = line.match(RE_RAZAO);
    if (mRazao) {
      const last = [...sessions.values()].at(-1);
      if (last) last.razaoSocial = mRazao[1].trim();
    }

    const mEmail = line.match(RE_EMAIL);
    if (mEmail && mEmail[1] !== '-') {
      const last = [...sessions.values()].at(-1);
      if (last) last.emailCliente = mEmail[1].trim();
    }

    const mLink = line.match(RE_LINK);
    if (mLink) {
      const last = [...sessions.values()].at(-1);
      if (last && !last.linkAssinatura) {
        // Extrai o link sem parâmetros de query (remove ?email=...)
        last.linkAssinatura = mLink[1].split('?')[0];
      }
    }

    // ── Conclusão ────────────────────────────────────────────────────────────
    const mConc = line.match(RE_CONC);
    if (mConc) {
      const [, folderName, docId, driveId, wpp] = mConc;
      const sess = sessions.get(folderName);
      if (sess) {
        sess.completedAt   = timestamp;
        sess.assinafyDocId = docId;
        sess.driveFileId   = driveId !== 'N/A' ? driveId : undefined;
        sess.whatsappSent  = wpp === 'true';
        sess.status        = 'concluido';
        completed.push({ ...sess });
        sessions.delete(folderName);
      }
      continue;
    }

    // ── Erro ─────────────────────────────────────────────────────────────────
    const mErro = line.match(RE_ERRO);
    if (mErro) {
      const [, etapa, folderName, msg] = mErro;
      const sess = sessions.get(folderName);
      if (sess) {
        sess.completedAt  = timestamp;
        sess.status       = 'erro';
        sess.errorStep    = etapa;
        sess.errorMessage = msg.slice(0, 500);
        sess.failedStep   = stepNumFromName(etapa);
        completed.push({ ...sess });
        sessions.delete(folderName);
      }
      continue;
    }
  }

  // Sessões abertas que nunca foram concluídas — descarta (incompletas)
  return completed;
}

// ─── Importação no banco ──────────────────────────────────────────────────────

function importar(sessions: WorkflowSession[]): void {
  const db = getDb();

  // Pega folder_ids já presentes (evita duplicatas)
  const existentes = new Set<string>(
    (db.prepare('SELECT folder_id FROM contracts').all() as { folder_id: string }[])
      .map(r => r.folder_id),
  );

  const insertContract = db.prepare(`
    INSERT INTO contracts
      (folder_id, folder_name, status, current_step,
       nome_cliente, razao_social, email_cliente,
       link_assinatura, drive_file_id, assinafy_doc_id,
       whatsapp_sent, error_message, error_step,
       started_at, completed_at)
    VALUES
      (?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?)
  `);

  const insertStep = db.prepare(`
    INSERT INTO contract_steps
      (contract_id, step_number, step_name, status, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let importados = 0;
  let ignorados  = 0;

  for (const s of sessions) {
    // Usa docId como folder_id sintético (único disponível nos logs antigos)
    const folderId = s.assinafyDocId
      ? `legacy:${s.assinafyDocId}`
      : `legacy:${s.folderName}:${s.startedAt}`;

    if (existentes.has(folderId)) {
      ignorados++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry-run] ${s.status === 'concluido' ? '✅' : '❌'} "${s.folderName}" | ${s.startedAt} | cliente: ${s.nomeCliente ?? '-'} | ${s.assinafyDocId ?? '-'}`);
      importados++;
      continue;
    }

    const currentStep = s.status === 'concluido' ? TOTAL_STEPS : (s.failedStep ?? 0);

    db.prepare('BEGIN').run();
    try {
      insertContract.run(
        folderId, s.folderName, s.status, currentStep,
        s.nomeCliente  ?? null,
        s.razaoSocial  ?? null,
        s.emailCliente ?? null,
        s.linkAssinatura  ?? null,
        s.driveFileId     ?? null,
        s.assinafyDocId   ?? null,
        s.whatsappSent ? 1 : 0,
        s.errorMessage ?? null,
        s.errorStep    ?? null,
        s.startedAt,
        s.completedAt ?? s.startedAt,
      );

      const contractId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

      // Cria as etapas com base no status do contrato
      for (let n = 1; n <= TOTAL_STEPS; n++) {
        let stepStatus: string;

        if (s.status === 'concluido') {
          stepStatus = 'success';
        } else if (s.failedStep && n < s.failedStep) {
          stepStatus = 'success';
        } else if (s.failedStep && n === s.failedStep) {
          stepStatus = 'error';
        } else {
          stepStatus = 'pending';
        }

        insertStep.run(
          contractId, n, STEP_NAMES[n] ?? `Etapa ${n}`,
          stepStatus,
          s.startedAt,
          stepStatus === 'success' || stepStatus === 'error' ? (s.completedAt ?? s.startedAt) : null,
        );
      }

      db.prepare('COMMIT').run();
      importados++;
    } catch (e) {
      db.prepare('ROLLBACK').run();
      console.warn(`  ⚠ Erro ao importar "${s.folderName}": ${e}`);
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY-RUN] ' : ''}Resultado:`);
  console.log(`  ✅ Importados : ${importados}`);
  console.log(`  ⏭ Ignorados  : ${ignorados} (já existiam no banco)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('════════════════════════════════════════════');
console.log(' Migração: logs → SQLite');
console.log(`════════════════════════════════════════════`);
console.log(`Arquivo : ${LOG_PATH}`);
console.log(`Modo    : ${DRY_RUN ? 'DRY-RUN (sem gravação)' : 'GRAVAÇÃO'}`);
console.log('');

const sessions = parseLogs(LOG_PATH);

const total      = sessions.length;
const concluidos = sessions.filter(s => s.status === 'concluido').length;
const erros      = sessions.filter(s => s.status === 'erro').length;

console.log(`Registros encontrados nos logs:`);
console.log(`  Total     : ${total}`);
console.log(`  Concluídos: ${concluidos}`);
console.log(`  Com erro  : ${erros}`);
console.log('');

if (DRY_RUN) {
  console.log('Prévia do que seria importado:');
  sessions.forEach(s => {
    const icon = s.status === 'concluido' ? '✅' : '❌';
    console.log(`  ${icon} "${s.folderName}" | ${s.startedAt} | ${s.nomeCliente ?? s.razaoSocial ?? '–'}`);
  });
  console.log('');
}

importar(sessions);
console.log('\nConcluído.\n');
