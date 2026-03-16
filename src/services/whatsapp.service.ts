import axios, { AxiosError } from 'axios';
import { logger } from '../logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConfig(): { baseUrl: string; apiKey: string; instance: string } {
  const baseUrl  = process.env.EVOLUTION_API_URL;
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;

  if (!baseUrl)  throw new Error('EVOLUTION_API_URL não definida no ambiente');
  if (!apiKey)   throw new Error('EVOLUTION_API_KEY não definida no ambiente');
  if (!instance) throw new Error('EVOLUTION_INSTANCE não definida no ambiente');

  return { baseUrl, apiKey, instance };
}

function formatarTelefone(telefone: string): string {
  // Remove tudo que não for dígito
  const numeros = telefone.replace(/\D/g, '');

  // Garante código do país 55 (Brasil)
  if (numeros.startsWith('55')) return numeros;
  return `55${numeros}`;
}

function montarMensagem(nomeCliente: string, link: string): string {
  return (
    `Olá, *${nomeCliente}*! 👋\n\n` +
    `Seu contrato está pronto para assinatura digital.\n\n` +
    `📝 *Assine aqui:*\n${link}\n\n` +
    `Em caso de dúvidas, entre em contato conosco.`
  );
}

// ─── Exportação principal ─────────────────────────────────────────────────────

export async function enviarLinkAssinatura(
  telefone:    string,
  nomeCliente: string,
  link:        string,
): Promise<void> {
  const { baseUrl, apiKey, instance } = getConfig();
  const numero = formatarTelefone(telefone);
  const texto  = montarMensagem(nomeCliente, link);

  logger.info(`[whatsapp] Enviando link de assinatura para: ${numero}`);

  try {
    await axios.post(
      `${baseUrl}/${instance}/message/sendText`,
      {
        number: numero,
        text:   texto,
      },
      {
        headers: {
          'apikey':       apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    );

    logger.info(`[whatsapp] Mensagem enviada com sucesso para: ${numero}`);

  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      const status = err.response.status;
      const detail = JSON.stringify(err.response.data);
      logger.error(`[whatsapp] Erro HTTP ${status} ao enviar mensagem: ${detail}`);
      throw new Error(`Evolution API retornou HTTP ${status}: ${detail}`);
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[whatsapp] Erro inesperado ao enviar mensagem: ${msg}`);
    throw err;
  }
}
