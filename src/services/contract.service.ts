import fs from 'fs/promises';
import path from 'path';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { logger } from '../logger';
import type { ContratoData } from '../types';

// ─── Constantes ───────────────────────────────────────────────────────────────

const TEMPLATE_PATH  = path.resolve('templates', 'contrato.docx');
const CONTRACTS_DIR  = path.resolve('contracts');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizarNomeArquivo(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // remove acentos
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

function formatarValor(valor: number): string {
  return valor.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ─── Exportação principal ─────────────────────────────────────────────────────

export async function gerarContrato(dados: ContratoData): Promise<string> {
  logger.info(`[contract] Gerando contrato para: ${dados.nomeCliente}`);

  // Lê template
  let templateBuffer: Buffer;
  try {
    templateBuffer = await fs.readFile(TEMPLATE_PATH);
  } catch {
    throw new Error(`Template não encontrado em: ${TEMPLATE_PATH}`);
  }

  // Garante que a pasta de saída existe
  await fs.mkdir(CONTRACTS_DIR, { recursive: true });

  // Primeiro sócio da empresa (QSA via BrasilAPI)
  const socio1 = dados.qsa?.[0];

  // Representante legal: prefere o sócio da BrasilAPI; fallback para o nome extraído da proposta
  const representanteLegal = socio1?.nome || dados.nomeCliente;

  // Endereço completo formatado
  const enderecoCompleto = [
    `${dados.logradouro}, ${dados.numero}`,
    dados.complemento ? dados.complemento : null,
    dados.bairro,
    `${dados.municipio}/${dados.uf}`,
    `CEP ${dados.cep}`,
  ].filter(Boolean).join(', ');

  // Cidade e data para assinatura (ex: "Maringá, 15 de Março de 2026")
  const cidadeSede     = process.env.CIDADE_SEDE ?? 'Maringá';
  const cidadeData     = `${cidadeSede}, ${dados.dataAssinatura}`;

  // Monta os dados para o template — chaves coincidem exatamente com os {{marcadores}}
  const templateData: Record<string, string> = {
    // ── Contratante (cliente) ──────────────────────────────────────────────
    razaoSocial:             dados.razaoSocial,
    nomeFantasia:            dados.nomeFantasia,
    cnpj:                    dados.cnpj,
    enderecoCompleto,
    bairro:                  dados.bairro,
    logradouro:              `${dados.logradouro}, ${dados.numero}`,
    municipio:               dados.municipio,
    uf:                      dados.uf,
    cep:                     dados.cep,
    representanteLegal,
    nomeCliente:             dados.nomeCliente,
    cpfCliente:              dados.cpfCliente,
    emailCliente:            dados.emailCliente,
    telefoneCliente:         dados.telefoneCliente,
    socio1Nome:              socio1?.nome         ?? representanteLegal,
    socio1Cpf:               socio1?.cpfCnpjSocio ?? dados.cpfCliente,

    // ── Financeiro ─────────────────────────────────────────────────────────
    valorContrato:           formatarValor(dados.valorContrato),
    valorImplantacaoTexto:   dados.valorImplantacaoTexto  || `R$ ${formatarValor(dados.valorContrato)}`,
    itensImplantacao:        dados.itensImplantacao        || '',
    valorMensalidade:        dados.valorMensalidade        || '',
    condicoesPagamento:      dados.condicoesPagamento      || '',

    // ── Escopo e prazo ─────────────────────────────────────────────────────
    descricaoServicos:       dados.descricaoServicos       || '',
    cronograma:              dados.cronograma              || '',
    vigencia:                dados.vigencia                || '12 meses',
    dataAssinatura:          dados.dataAssinatura,
    cidadeSede,
    cidadeData,
  };

  // Renderiza template
  const zip  = new PizZip(templateBuffer);
  const doc  = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
  });

  doc.render(templateData);

  const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });

  // Monta nome do arquivo de saída
  const timestamp   = Date.now();
  const nomeSeguro  = sanitizarNomeArquivo(dados.nomeCliente);
  const outputPath  = path.join(CONTRACTS_DIR, `contrato_${nomeSeguro}_${timestamp}.docx`);

  await fs.writeFile(outputPath, outputBuffer);

  logger.info(`[contract] Contrato gerado: ${outputPath}`);
  return outputPath;
}
