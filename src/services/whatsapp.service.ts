import axios, { AxiosError } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../logger';

// ─── Config ───────────────────────────────────────────────────────────────────

function getConfig(): { baseUrl: string; apiKey: string; instance: string } {
  const baseUrl  = process.env.EVOLUTION_API_URL;
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;

  if (!baseUrl)  throw new Error('EVOLUTION_API_URL não definida no .env');
  if (!apiKey)   throw new Error('EVOLUTION_API_KEY não definida no .env');
  if (!instance) throw new Error('EVOLUTION_INSTANCE não definida no .env');

  return { baseUrl, apiKey, instance };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normaliza telefone para o formato esperado pela Evolution API: 55XXXXXXXXXXX
 * Trata corretamente celulares com 9 dígitos e fixos com 8.
 */
function formatarTelefone(telefone: string): string {
  const numeros = telefone.replace(/\D/g, '');

  // Já tem código de país
  if (numeros.startsWith('55')) {
    // 55 + DDD(2) + número(8 ou 9) = 12 ou 13 dígitos
    if (numeros.length === 12 || numeros.length === 13) return numeros;
  }

  // Sem código do país: DDD(2) + número(8 ou 9) = 10 ou 11 dígitos
  if (numeros.length === 10 || numeros.length === 11) return `55${numeros}`;

  // Fallback — prefixo garantido
  return `55${numeros}`;
}

/**
 * Monta a mensagem de WhatsApp.
 * Inclui instrução sobre o e-mail, exigido pela Assinafy para liberar o acesso ao link.
 */
function montarMensagem(
  nomeCliente:  string,
  link:         string,
  emailCliente?: string,
): string {
  const instrucaoEmail = emailCliente
    ? `📧 Ao abrir o link, informe o e-mail *${emailCliente}* para receber seu código de acesso.`
    : `📧 Ao abrir o link, informe o e-mail cadastrado no contrato para receber seu código de acesso.`;

  return (
    `Olá, *${nomeCliente}*! 👋\n\n` +
    `Seu contrato está pronto para *assinatura digital*.\n\n` +
    `✍️ *Assine aqui:*\n${link}\n\n` +
    `${instrucaoEmail}\n\n` +
    `_Em caso de dúvidas, entre em contato conosco._`
  );
}

/**
 * Executa uma função com retentativas e backoff exponencial.
 */
async function comRetentativa<T>(
  fn:         () => Promise<T>,
  tentativas: number = 3,
  delayBase:  number = 2_000,
): Promise<T> {
  let ultimoErro: unknown;

  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;

      if (i < tentativas - 1) {
        const delay = delayBase * Math.pow(2, i); // 2s → 4s → 8s
        logger.warn(`[whatsapp] Tentativa ${i + 1}/${tentativas} falhou. Aguardando ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw ultimoErro;
}

/**
 * Formata erro Axios para log legível.
 */
function descricaoErro(err: unknown): string {
  if (err instanceof AxiosError && err.response) {
    return `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ─── Exportações ──────────────────────────────────────────────────────────────

/**
 * Envia o PDF do contrato como documento no WhatsApp antes do link de assinatura.
 * Não crítico — falha é registrada mas não interrompe o fluxo.
 */
export async function enviarDocumentoPdf(
  telefone:    string,
  nomeEmpresa: string,
  pdfPath:     string,
): Promise<void> {
  const { baseUrl, apiKey, instance } = getConfig();
  const numero   = formatarTelefone(telefone);
  const fileName = path.basename(pdfPath);

  logger.info(`[whatsapp] Enviando PDF do contrato para: ${numero}`);

  const pdfBuffer = await fs.readFile(pdfPath);
  const base64    = pdfBuffer.toString('base64');

  await comRetentativa(() =>
    axios.post(
      `${baseUrl}/${instance}/message/sendMedia`,
      {
        number:    numero,
        mediatype: 'document',
        mimetype:  'application/pdf',
        caption:   `📄 Contrato — ${nomeEmpresa}`,
        media:     base64,
        fileName,
      },
      {
        headers: { apikey: apiKey, 'Content-Type': 'application/json' },
        timeout: 30_000,
      },
    ),
  );

  logger.info(`[whatsapp] PDF enviado com sucesso para: ${numero}`);
}

/**
 * Envia o link de assinatura digital via WhatsApp.
 * Inclui instrução do e-mail exigido pela Assinafy para liberar o acesso ao link.
 */
export async function enviarLinkAssinatura(
  telefone:     string,
  nomeCliente:  string,
  link:         string,
  emailCliente?: string,
): Promise<void> {
  const { baseUrl, apiKey, instance } = getConfig();
  const numero = formatarTelefone(telefone);
  const texto  = montarMensagem(nomeCliente, link, emailCliente);

  logger.info(`[whatsapp] Enviando link de assinatura para: ${numero}`);

  await comRetentativa(() =>
    axios.post(
      `${baseUrl}/${instance}/message/sendText`,
      { number: numero, text: texto },
      {
        headers: { apikey: apiKey, 'Content-Type': 'application/json' },
        timeout: 15_000,
      },
    ),
  );

  logger.info(`[whatsapp] Mensagem enviada com sucesso para: ${numero}`);
}

/**
 * Fluxo completo de notificação WhatsApp:
 * 1. Envia o PDF do contrato como documento
 * 2. Envia o link de assinatura com instrução de e-mail
 *
 * Se o envio do PDF falhar, prossegue com o envio do link mesmo assim.
 */
export async function notificarClienteWhatsapp(params: {
  telefone:     string;
  nomeCliente:  string;
  nomeEmpresa:  string;
  link:         string;
  emailCliente?: string;
  pdfPath?:     string;
}): Promise<{ pdfEnviado: boolean; linkEnviado: boolean }> {
  const { telefone, nomeCliente, nomeEmpresa, link, emailCliente, pdfPath } = params;

  // 1. Envio do PDF (não crítico)
  let pdfEnviado = false;
  if (pdfPath) {
    try {
      await enviarDocumentoPdf(telefone, nomeEmpresa, pdfPath);
      pdfEnviado = true;

      // Pequena pausa para o WhatsApp processar o documento antes da próxima mensagem
      await new Promise(r => setTimeout(r, 1_500));
    } catch (err) {
      logger.warn(`[whatsapp] Falha ao enviar PDF (continua): ${descricaoErro(err)}`);
    }
  }

  // 2. Envio do link de assinatura
  await enviarLinkAssinatura(telefone, nomeCliente, link, emailCliente);

  return { pdfEnviado, linkEnviado: true };
}
