import express, { Request, Response } from 'express';
import path from 'path';
import axios from 'axios';
import { getDb } from '../db/database';
import { logger } from '../logger';

const PORT = Number(process.env.DASHBOARD_PORT ?? 3001);

// ─── Types auxiliares ─────────────────────────────────────────────────────────

interface HealthCheck {
  name:      string;
  status:    'ok' | 'warn' | 'error';
  latencyMs: number | null;
  error?:    string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeQuery<T>(
  res: Response,
  fn: () => T,
): void {
  try {
    res.json(fn());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[api] Query error: ${msg}`);
    res.status(500).json({ error: msg });
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

export function startApiServer(): void {
  const app = express();
  app.use(express.json());

  // Serve dashboard HTML
  app.use(express.static(path.join(process.cwd(), 'public')));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });

  // ── GET /api/stats ──────────────────────────────────────────────────────────
  app.get('/api/stats', (_req: Request, res: Response) => {
    safeQuery(res, () => {
      const db = getDb();
      const q  = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

      return {
        total:        q("SELECT COUNT(*) as n FROM contracts"),
        today:        q("SELECT COUNT(*) as n FROM contracts WHERE date(started_at) = date('now','localtime')"),
        processing:   q("SELECT COUNT(*) as n FROM contracts WHERE status IN ('iniciado','processando')"),
        success:      q("SELECT COUNT(*) as n FROM contracts WHERE status = 'concluido'"),
        error:        q("SELECT COUNT(*) as n FROM contracts WHERE status = 'erro'"),
        wppOk:        q("SELECT COUNT(*) as n FROM contracts WHERE whatsapp_sent = 1"),
        wppFailed:    q("SELECT COUNT(*) as n FROM contracts WHERE status = 'concluido' AND whatsapp_sent = 0"),
        avgDurationMs: (db.prepare(
          "SELECT AVG(duration_ms) as avg FROM contracts WHERE status = 'concluido' AND duration_ms IS NOT NULL"
        ).get() as { avg: number | null }).avg ?? 0,
      };
    });
  });

  // ── GET /api/contracts ──────────────────────────────────────────────────────
  app.get('/api/contracts', (req: Request, res: Response) => {
    safeQuery(res, () => {
      const db     = getDb();
      const limit  = Math.min(Number(req.query.limit ?? 50), 200);
      const page   = Math.max(Number(req.query.page   ?? 1),  1);
      const offset = (page - 1) * limit;
      const status = req.query.status as string | undefined;
      const search = req.query.search as string | undefined;

      const conds: string[]  = ['1=1'];
      const params: unknown[] = [];

      if (status) { conds.push('status = ?');                                                  params.push(status); }
      if (search) {
        conds.push('(nome_cliente LIKE ? OR razao_social LIKE ? OR folder_name LIKE ? OR cnpj LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like);
      }

      const where = `WHERE ${conds.join(' AND ')}`;

      const contracts = db.prepare(`
        SELECT id, folder_id, folder_name, status, current_step,
               nome_cliente, razao_social, email_cliente, telefone, cnpj,
               link_assinatura, drive_file_id, assinafy_doc_id,
               whatsapp_sent, pdf_enviado_wpp,
               error_message, error_step,
               started_at, completed_at, duration_ms
        FROM contracts ${where}
        ORDER BY started_at DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);

      const total = (db.prepare(
        `SELECT COUNT(*) as n FROM contracts ${where}`
      ).get(...params) as { n: number }).n;

      return { contracts, total, page, limit, pages: Math.ceil(total / limit) };
    });
  });

  // ── GET /api/contracts/active ───────────────────────────────────────────────
  app.get('/api/contracts/active', (_req: Request, res: Response) => {
    safeQuery(res, () => {
      const db = getDb();
      const contracts = db.prepare(`
        SELECT c.*,
          (SELECT json_group_array(json_object(
            'step_number', step_number, 'step_name', step_name, 'status', status,
            'duration_ms', duration_ms
          )) FROM contract_steps WHERE contract_id = c.id ORDER BY step_number) as steps_json
        FROM contracts c
        WHERE c.status IN ('iniciado','processando')
        ORDER BY c.started_at DESC
        LIMIT 10
      `).all() as Array<Record<string, unknown>>;

      return contracts.map(c => ({
        ...c,
        steps: c.steps_json ? JSON.parse(c.steps_json as string) : [],
        steps_json: undefined,
      }));
    });
  });

  // ── GET /api/contracts/:id ──────────────────────────────────────────────────
  app.get('/api/contracts/:id', (req: Request, res: Response) => {
    safeQuery(res, () => {
      const db       = getDb();
      const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
      if (!contract) { res.status(404).json({ error: 'Contrato não encontrado' }); return; }

      const steps = db.prepare(
        'SELECT * FROM contract_steps WHERE contract_id = ? ORDER BY step_number',
      ).all(req.params.id);

      return { contract, steps };
    });
  });

  // ── GET /api/metrics/daily ──────────────────────────────────────────────────
  app.get('/api/metrics/daily', (_req: Request, res: Response) => {
    safeQuery(res, () => {
      const db = getDb();
      return db.prepare(`
        SELECT
          date(started_at) as date,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'concluido' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN status = 'erro'      THEN 1 ELSE 0 END) as error
        FROM contracts
        WHERE started_at >= datetime('now', '-14 days', 'localtime')
        GROUP BY date(started_at)
        ORDER BY date ASC
      `).all();
    });
  });

  // ── GET /api/metrics/steps ──────────────────────────────────────────────────
  app.get('/api/metrics/steps', (_req: Request, res: Response) => {
    safeQuery(res, () => {
      const db = getDb();
      return db.prepare(`
        SELECT
          step_number,
          step_name,
          COUNT(*)                                                                    as total,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)                       as success,
          SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END)                       as errors,
          AVG(CASE WHEN status = 'success' AND duration_ms IS NOT NULL
              THEN duration_ms END)                                                   as avg_ms,
          MAX(duration_ms)                                                            as max_ms
        FROM contract_steps
        GROUP BY step_number, step_name
        ORDER BY step_number
      `).all();
    });
  });

  // ── GET /api/health ─────────────────────────────────────────────────────────
  app.get('/api/health', async (_req: Request, res: Response) => {
    const checks: HealthCheck[] = [];

    // Assinafy
    try {
      const t0 = Date.now();
      await axios.get('https://api.assinafy.com.br/v1/accounts', {
        headers: { 'X-Api-Key': process.env.ASSINAFY_API_KEY ?? '' },
        timeout: 5_000,
      });
      checks.push({ name: 'Assinafy', status: 'ok', latencyMs: Date.now() - t0 });
    } catch (err: unknown) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      // 401/403 = API respondeu, apenas chave inválida → serviço está UP
      const up = status === 401 || status === 403 || status === 404;
      checks.push({
        name:      'Assinafy',
        status:    up ? 'ok' : 'error',
        latencyMs: null,
        error:     up ? undefined : (err instanceof Error ? err.message : String(err)),
      });
    }

    // Google Drive — verifica se credenciais estão configuradas
    const driveOk = !!(
      process.env.GOOGLE_DRIVE_CONTRATOS_FOLDER_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_ID
    );
    checks.push({
      name:      'Google Drive',
      status:    driveOk ? 'ok' : 'warn',
      latencyMs: null,
      error:     driveOk ? undefined : 'Credenciais não configuradas no .env',
    });

    // Evolution API (WhatsApp)
    const evoUrl  = process.env.EVOLUTION_API_URL;
    const evoKey  = process.env.EVOLUTION_API_KEY;
    const evoInst = process.env.EVOLUTION_INSTANCE;

    if (!evoUrl || !evoKey || !evoInst) {
      checks.push({
        name:      'WhatsApp (Evolution)',
        status:    'warn',
        latencyMs: null,
        error:     'Credenciais não configuradas no .env',
      });
    } else {
      try {
        const t0 = Date.now();
        await axios.get(`${evoUrl}/instance/fetchInstances`, {
          headers: { apikey: evoKey },
          timeout: 5_000,
        });
        checks.push({ name: 'WhatsApp (Evolution)', status: 'ok', latencyMs: Date.now() - t0 });
      } catch (err: unknown) {
        checks.push({
          name:      'WhatsApp (Evolution)',
          status:    'error',
          latencyMs: null,
          error:     err instanceof Error ? err.message : String(err),
        });
      }
    }

    // BrasilAPI — CNPJ inválido deve retornar 404 (API up)
    try {
      const t0 = Date.now();
      await axios.get('https://brasilapi.com.br/api/cnpj/v1/00000000000000', { timeout: 5_000 });
      checks.push({ name: 'BrasilAPI (CNPJ)', status: 'ok', latencyMs: Date.now() - t0 });
    } catch (err: unknown) {
      const s = axios.isAxiosError(err) ? err.response?.status : undefined;
      checks.push({
        name:      'BrasilAPI (CNPJ)',
        status:    s === 404 || s === 400 ? 'ok' : 'error',
        latencyMs: null,
        error:     (s === 404 || s === 400) ? undefined : (err instanceof Error ? err.message : String(err)),
      });
    }

    res.json(checks);
  });

  // ── Start ───────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    logger.info(`[dashboard] ✔ Painel disponível → http://localhost:${PORT}`);
  });
}
