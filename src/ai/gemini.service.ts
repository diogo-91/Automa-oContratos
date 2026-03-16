import fs from 'fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger';
import type { PropostaData } from '../types';

// ─── Cliente ──────────────────────────────────────────────────────────────────

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não definida no ambiente');
  return new Anthropic({ apiKey });
}

const MODEL = 'claude-haiku-4-5-20251001';

// ─── Prompt ───────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Você é um extrator de dados de propostas comerciais brasileiras.
Analise o documento PDF e extraia os seguintes campos em formato JSON puro sem markdown.

REGRAS:
- Use "\\n" para separar múltiplas linhas dentro de campos de texto
- Valores monetários em texto: "R$ X.XXX,00 (Por Extenso)"
- Se um campo não existir, retorne string vazia ""
- valorContrato deve ser apenas o número (ex: 6500.00)

{
  "nomeCliente": "nome completo do representante/responsável da empresa contratante",
  "cpfCliente": "CPF do representante, se houver",
  "emailCliente": "e-mail do contato principal",
  "telefoneCliente": "telefone com DDD",
  "valorContrato": 0,
  "valorImplantacaoTexto": "valor total de implantação por extenso, ex: R$ 6.500,00 (Seis mil e quinhentos reais)",
  "itensImplantacao": "um item por linha separado por \\n, ex: R$ 6.000,00 (Funil de Qualificação IA)\\nR$ 500,00 (Automação de Integração)",
  "valorMensalidade": "valor da mensalidade de gestão, ex: R$ 300,00 (Trezentos reais)/mês",
  "condicoesPagamento": "condições de pagamento da implantação, ex: Parcelamento em até 1+4 parcelas mensais no boleto bancário",
  "descricaoServicos": "descrição completa dos serviços contratados preservando estrutura com \\n entre itens",
  "cronograma": "prazos de entrega separados por \\n, ex: Automação X: 7 a 10 dias úteis\\nFunil IA: até 45 dias úteis",
  "vigencia": "duração do contrato de gestão, ex: 12 meses",
  "dataAssinatura": "data de assinatura no formato: DD de Mês de AAAA",
  "observacoes": "outras informações relevantes"
}

Retorne SOMENTE o JSON, sem explicações, sem markdown, sem blocos de código.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return v != null && v !== '' ? String(v) : '';
}

function parseJsonResponse(raw: string): PropostaData {
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const p = JSON.parse(cleaned) as Record<string, unknown>;

  return {
    nomeCliente:           str(p.nomeCliente),
    cpfCliente:            str(p.cpfCliente),
    emailCliente:          str(p.emailCliente),
    telefoneCliente:       str(p.telefoneCliente),
    valorContrato:         Number(p.valorContrato ?? 0),
    valorImplantacaoTexto: str(p.valorImplantacaoTexto),
    itensImplantacao:      str(p.itensImplantacao),
    valorMensalidade:      str(p.valorMensalidade),
    condicoesPagamento:    str(p.condicoesPagamento),
    descricaoServicos:     str(p.descricaoServicos),
    cronograma:            str(p.cronograma),
    vigencia:              str(p.vigencia),
    dataAssinatura:        str(p.dataAssinatura),
    observacoes:           p.observacoes != null ? str(p.observacoes) : undefined,
  };
}

// ─── Exportação principal ─────────────────────────────────────────────────────

export async function extrairDadosProposta(pdfPath: string): Promise<PropostaData> {
  logger.info(`[claude-pdf] Iniciando extração de proposta: ${pdfPath}`);

  const buffer = await fs.readFile(pdfPath);
  const base64 = buffer.toString('base64');

  const client = getClient();

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type:       'base64',
              media_type: 'application/pdf',
              data:       base64,
            },
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    throw new Error('[claude-pdf] Resposta inesperada: bloco não é texto');
  }

  const rawText = block.text;
  logger.debug(`[claude-pdf] Resposta bruta:\n${rawText}`);

  try {
    const dados = parseJsonResponse(rawText);
    logger.info(`[claude-pdf] Extração concluída: ${dados.nomeCliente}`);
    return dados;
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    logger.error(`[claude-pdf] Falha ao parsear JSON: ${msg}`);
    logger.error(`[claude-pdf] Resposta recebida:\n${rawText}`);
    throw new Error(`Claude retornou JSON inválido: ${msg}`);
  }
}
