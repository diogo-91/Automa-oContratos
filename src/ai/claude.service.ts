import fs from 'fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger';
import type { ContratoData } from '../types';

// ─── Cliente (singleton lazy) ─────────────────────────────────────────────────

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não definida no ambiente');
  return new Anthropic({ apiKey });
}

const MODEL = 'claude-haiku-4-5-20251001';

// ─── Função 1: extrairDadosCliente ───────────────────────────────────────────
// Extrai CNPJ e demais campos disponíveis no arquivo de dados do cliente

export interface DadosClienteTxt {
  cnpj:           string;
  cpfCliente?:    string;
  emailCliente?:  string;
  telefoneCliente?: string;
  nomeCliente?:   string;
}

export async function extrairCnpj(txtPath: string): Promise<string> {
  const dados = await extrairDadosClienteTxt(txtPath);
  return dados.cnpj;
}

export async function extrairDadosClienteTxt(
  txtPathOrContent: string,
  inlineContent?: string,
): Promise<DadosClienteTxt> {
  // Aceita conteúdo inline (evita ENOENT caso o arquivo seja removido antes desta chamada)
  const conteudo = inlineContent ?? await fs.readFile(txtPathOrContent, 'utf-8');
  logger.info(`[claude] Extraindo dados do cliente (${inlineContent ? 'conteúdo inline' : txtPathOrContent})`);
  const client   = getClient();

  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: 256,
    messages: [
      {
        role:    'user',
        content: `Extraia os campos disponíveis do texto abaixo e retorne JSON puro sem markdown:

{
  "cnpj": "XX.XXX.XXX/XXXX-XX ou vazio",
  "cpfCliente": "XXX.XXX.XXX-XX ou vazio",
  "emailCliente": "email ou vazio",
  "telefoneCliente": "telefone com DDD ou vazio",
  "nomeCliente": "nome completo ou vazio"
}

Texto:
${conteudo}`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== 'text') throw new Error('[claude] Resposta inesperada');

  try {
    const raw = block.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const obj = JSON.parse(raw) as Record<string, string>;

    const cnpj = obj.cnpj ?? '';
    if (!/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(cnpj)) {
      logger.warn(`[claude] CNPJ fora do formato: "${cnpj}"`);
    }

    logger.info(`[claude] Dados extraídos — CNPJ: ${cnpj} | email: ${obj.emailCliente ?? '-'}`);

    return {
      cnpj,
      cpfCliente:      obj.cpfCliente      || undefined,
      emailCliente:    obj.emailCliente    || undefined,
      telefoneCliente: obj.telefoneCliente || undefined,
      nomeCliente:     obj.nomeCliente     || undefined,
    };
  } catch {
    logger.warn('[claude] Falha ao parsear dados do cliente, extraindo apenas CNPJ');
    const cnpjMatch = conteudo.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
    return { cnpj: cnpjMatch?.[0] ?? '' };
  }
}

// ─── Função 2: validarDadosContrato ──────────────────────────────────────────

const VALIDACAO_PROMPT = `Você é um validador de dados de contratos comerciais brasileiros.
Corrija e formate os campos do JSON abaixo seguindo estas regras obrigatórias:
- cpfCliente: formato XXX.XXX.XXX-XX
- cnpj: formato XX.XXX.XXX/XXXX-XX
- telefoneCliente e telefone: formato (XX) XXXXX-XXXX ou (XX) XXXX-XXXX
- cep: formato XXXXX-XXX
- valorContrato: número decimal (ex: 1500.00), sem símbolos de moeda
- dataAssinatura e dataAbertura: formato DD/MM/YYYY
- uf: sigla maiúscula com 2 letras
- Campos vazios ("") devem permanecer como string vazia, não nulos

Retorne SOMENTE o JSON corrigido, sem markdown, sem explicações.`;

export async function validarDadosContrato(dados: ContratoData): Promise<ContratoData> {
  logger.info(`[claude] Validando dados do contrato para: ${dados.nomeCliente}`);

  const client = getClient();

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `${VALIDACAO_PROMPT}

JSON a validar:
${JSON.stringify(dados, null, 2)}`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    throw new Error('[claude] Resposta inesperada: bloco não é texto');
  }

  const rawText = block.text;
  logger.debug(`[claude] Resposta de validação:\n${rawText}`);

  try {
    const cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const corrigido = JSON.parse(cleaned) as ContratoData;

    // Preserva campos não serializáveis que o modelo não deve alterar
    corrigido.createdAt = dados.createdAt;
    corrigido.status    = dados.status;
    corrigido.pdfPath   = dados.pdfPath;

    logger.info(`[claude] Validação concluída para: ${corrigido.nomeCliente}`);
    return corrigido;
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    logger.error(`[claude] Falha ao parsear JSON de validação: ${msg}`);
    logger.warn('[claude] Retornando dados originais sem correção');
    return dados;
  }
}
