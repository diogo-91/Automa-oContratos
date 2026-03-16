import axios, { AxiosError } from 'axios';
import { logger } from '../logger';
import type { CnpjData, QsaSocio } from '../types';

// ─── Constantes ───────────────────────────────────────────────────────────────

const BRASIL_API_URL =
  process.env.BRASIL_API_URL ?? 'https://brasilapi.com.br/api/cnpj/v1';
const RETRY_DELAY_MS = 2000;

// ─── Tipos da resposta bruta da BrasilAPI ─────────────────────────────────────

interface BrasilApiQsa {
  nome_socio:              string;
  qualificacao_socio:      string;
  cnpj_cpf_do_socio:       string;
}

interface BrasilApiResponse {
  cnpj:                    string;
  razao_social:            string;
  nome_fantasia:           string;
  descricao_situacao_cadastral: string;
  data_inicio_atividade:   string;
  logradouro:              string;
  numero:                  string;
  complemento:             string;
  bairro:                  string;
  municipio:               string;
  uf:                      string;
  cep:                     string;
  ddd_telefone_1:          string;
  email:                   string;
  qsa:                     BrasilApiQsa[] | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function apenasNumeros(cnpj: string): string {
  return cnpj.replace(/\D/g, '');
}

function mapearResposta(data: BrasilApiResponse): CnpjData {
  const qsa: QsaSocio[] = (data.qsa ?? []).map((socio) => ({
    nome:          socio.nome_socio,
    qual:          socio.qualificacao_socio,
    cpfCnpjSocio:  socio.cnpj_cpf_do_socio,
  }));

  return {
    cnpj:               data.cnpj,
    razaoSocial:        data.razao_social,
    nomeFantasia:       data.nome_fantasia ?? '',
    situacaoCadastral:  data.descricao_situacao_cadastral ?? '',
    dataAbertura:       data.data_inicio_atividade ?? '',
    logradouro:         data.logradouro ?? '',
    numero:             data.numero ?? '',
    complemento:        data.complemento ?? '',
    bairro:             data.bairro ?? '',
    municipio:          data.municipio ?? '',
    uf:                 data.uf ?? '',
    cep:                data.cep ?? '',
    telefone:           data.ddd_telefone_1 ?? '',
    email:              data.email ?? '',
    qsa,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Exportação principal ─────────────────────────────────────────────────────

export async function consultarCnpj(cnpjRaw: string): Promise<CnpjData> {
  const cnpj = apenasNumeros(cnpjRaw);
  const url   = `${BRASIL_API_URL}/${cnpj}`;

  logger.info(`[cnpj] Consultando CNPJ: ${cnpj}`);

  try {
    const { data } = await axios.get<BrasilApiResponse>(url, {
      timeout: 10_000,
    });

    const resultado = mapearResposta(data);
    logger.info(`[cnpj] Dados obtidos para: ${resultado.razaoSocial}`);
    return resultado;

  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      const status = err.response.status;

      if (status === 404) {
        logger.error(`[cnpj] CNPJ não encontrado na BrasilAPI: ${cnpj}`);
        throw new Error(`CNPJ ${cnpj} não encontrado`);
      }

      if (status === 429) {
        logger.warn(`[cnpj] Rate limit atingido. Aguardando ${RETRY_DELAY_MS}ms e tentando novamente…`);
        await delay(RETRY_DELAY_MS);

        // Uma única re-tentativa após o delay
        const retry = await axios.get<BrasilApiResponse>(url, { timeout: 10_000 });
        const resultado = mapearResposta(retry.data);
        logger.info(`[cnpj] Retry bem-sucedido para: ${resultado.razaoSocial}`);
        return resultado;
      }

      logger.error(`[cnpj] Erro HTTP ${status} ao consultar CNPJ ${cnpj}`);
      throw new Error(`Erro HTTP ${status} ao consultar CNPJ`);
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[cnpj] Erro inesperado: ${msg}`);
    throw err;
  }
}
