import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import { logger } from '../logger';
import type { AssinaturaResult, ContratoData } from '../types';

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.assinafy.com.br/v1';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS  = 90_000;

function getApiKey(): string {
  const key = process.env.ASSINAFY_API_KEY;
  if (!key) throw new Error('ASSINAFY_API_KEY não definida no .env');
  return key;
}

function getAccountId(): string {
  const id = process.env.ASSINAFY_ACCOUNT_ID;
  if (!id) throw new Error('ASSINAFY_ACCOUNT_ID não definido no .env');
  return id;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return { 'X-Api-Key': getApiKey(), ...extra };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normaliza telefone para +55XXXXXXXXXXX */
function normalizarTelefone(tel: string): string {
  const digits = tel.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length >= 12) return `+${digits}`;
  return `+55${digits}`;
}

// ─── 1. Upload do PDF ─────────────────────────────────────────────────────────

async function uploadDocumento(pdfPath: string): Promise<string> {
  logger.info(`[assinafy] Fazendo upload: ${pdfPath}`);

  const accountId = getAccountId();
  const form      = new FormData();
  form.append('file', fs.createReadStream(pdfPath));

  const { data } = await axios.post(
    `${BASE_URL}/accounts/${accountId}/documents`,
    form,
    {
      headers: { ...headers(), ...form.getHeaders() },
      timeout: 60_000,
    },
  );

  const doc = data?.data ?? data;
  logger.info(`[assinafy] Upload concluído — document_id: ${doc.id}`);
  return doc.id as string;
}

// ─── 2. Aguardar status metadata_ready ───────────────────────────────────────

async function aguardarMetadataReady(documentId: string): Promise<void> {
  logger.info(`[assinafy] Aguardando processamento do documento...`);

  const inicio = Date.now();

  while (Date.now() - inicio < POLL_TIMEOUT_MS) {
    const { data } = await axios.get(
      `${BASE_URL}/documents/${documentId}`,
      { headers: headers(), timeout: 15_000 },
    );

    const status = (data?.data ?? data)?.status as string;
    logger.debug(`[assinafy] status: ${status}`);

    if (status === 'metadata_ready') {
      logger.info('[assinafy] Documento pronto para assinatura ✔');
      return;
    }

    if (['failed', 'expired'].includes(status)) {
      throw new Error(`Documento Assinafy em status de erro: "${status}"`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timeout: documento Assinafy não ficou "metadata_ready" em ${POLL_TIMEOUT_MS / 1000}s`,
  );
}

// ─── 3. Criar signatário ──────────────────────────────────────────────────────

async function criarSignatario(dados: ContratoData): Promise<string> {
  // Fallback para campos obrigatórios
  const socio1     = dados.qsa?.[0];
  const fullName   = dados.nomeCliente
    || socio1?.nome
    || dados.razaoSocial
    || 'Representante Legal';

  const email      = dados.emailCliente || null;
  const phone      = dados.telefoneCliente;

  if (!email) {
    throw new Error(
      `E-mail do signatário não encontrado para "${fullName}". ` +
      `Verifique se o campo "emailCliente" está na proposta ou nos dados do cliente.`,
    );
  }

  logger.info(`[assinafy] Criando signatário: ${fullName} <${email}>`);

  const accountId = getAccountId();

  const payload: Record<string, string> = {
    full_name: fullName,
    email,
  };
  if (phone) payload.whatsapp_phone_number = normalizarTelefone(phone);

  try {
    const { data } = await axios.post(
      `${BASE_URL}/accounts/${accountId}/signers`,
      payload,
      {
        headers:  headers({ 'Content-Type': 'application/json' }),
        timeout:  15_000,
      },
    );

    const signer = data?.data ?? data;
    logger.info(`[assinafy] Signatário criado — id: ${signer.id}`);
    return signer.id as string;

  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 400) {
      // Signatário com esse e-mail pode já existir — tenta buscar pelo e-mail
      const errBody = JSON.stringify(err.response.data ?? {});
      logger.warn(`[assinafy] POST signer retornou 400: ${errBody} — buscando signatário existente...`);

      const listRes = await axios.get(
        `${BASE_URL}/accounts/${accountId}/signers`,
        { headers: headers(), timeout: 15_000 },
      );

      const items: Array<{ id: string; email: string }> = listRes.data?.data ?? listRes.data ?? [];
      const existing = items.find((s) => s.email === email);

      if (existing) {
        logger.info(`[assinafy] Signatário existente encontrado — id: ${existing.id}`);
        return existing.id;
      }
    }
    throw err;
  }
}

// ─── 4. Criar assignment e obter link ─────────────────────────────────────────

async function criarAssignment(
  documentId: string,
  signerId:   string,
): Promise<{ assignmentId: string; signingUrl: string }> {
  logger.info(`[assinafy] Criando solicitação de assinatura...`);

  // Expira em 7 dias
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();

  const { data } = await axios.post(
    `${BASE_URL}/documents/${documentId}/assignments`,
    {
      method:     'virtual',
      signers:    [{ id: signerId }],
      expires_at: expiresAt,
    },
    {
      headers:  headers({ 'Content-Type': 'application/json' }),
      timeout:  15_000,
    },
  );

  const assignment  = data?.data ?? data;
  const signingUrl  = (assignment.signing_urls as Array<{ signer_id: string; url: string }>)?.[0]?.url;

  if (!signingUrl) {
    throw new Error('Assinafy não retornou URL de assinatura no assignment');
  }

  logger.info(`[assinafy] Assignment criado — id: ${assignment.id}`);
  logger.info(`[assinafy] Link de assinatura: ${signingUrl}`);

  return { assignmentId: assignment.id as string, signingUrl };
}

// ─── Principal: enviarParaAssinatura ─────────────────────────────────────────

export async function enviarParaAssinatura(
  dados: ContratoData & { pdfPath: string },
): Promise<AssinaturaResult> {
  logger.info(`[assinafy] Iniciando fluxo de assinatura para: ${dados.nomeCliente}`);

  // 1. Upload do PDF
  const documentId = await uploadDocumento(dados.pdfPath);

  // 2. Aguarda processamento
  await aguardarMetadataReady(documentId);

  // 3. Cria signatário
  const signerId = await criarSignatario(dados);

  // 4. Cria solicitação → obtém link
  const { assignmentId, signingUrl } = await criarAssignment(documentId, signerId);

  const result: AssinaturaResult = {
    documentId,
    linkAssinatura: signingUrl,
    embedUrl:       signingUrl,
    createdAt:      new Date(),
  };

  logger.info(
    `[assinafy] Fluxo concluído ✔ | documentId: ${documentId} | assignmentId: ${assignmentId}`,
  );

  return result;
}
