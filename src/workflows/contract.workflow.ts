import fs from 'fs/promises';
import path from 'path';
import { logger } from '../logger';

import { extrairDadosProposta }                           from '../ai/gemini.service';
import { extrairDadosClienteTxt, validarDadosContrato }   from '../ai/claude.service';
import { consultarCnpj }                                  from '../services/cnpj.service';
import { gerarContrato }                                  from '../services/contract.service';
import { enviarParaAssinatura }                           from '../services/assinafy.service';
import { enviarLinkAssinatura }                           from '../services/whatsapp.service';
import {
  uploadContratoPastaCliente,
  marcarPastaComoProcessada,
  marcarPastaComoErro,
  converterDocxParaPdf,
} from '../services/googledrive.service';

import type {
  DriveFileWatcherEvent,
  ContratoData,
  WorkflowDriveResult,
} from '../types';

// ─── Helper de erro padronizado ───────────────────────────────────────────────

async function erroWorkflow(
  etapa:      string,
  err:        unknown,
  clientName: string,
  folderId:   string,
): Promise<WorkflowDriveResult> {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[workflow] ✖ Falha na etapa "${etapa}" | cliente: "${clientName}" | ${msg}`);

  try {
    await marcarPastaComoErro(folderId, clientName);
  } catch {
    logger.warn('[workflow] Não foi possível marcar pasta como erro no Drive');
  }

  return {
    success:        false,
    contratoPath:   '',
    linkAssinatura: '',
    documentId:     '',
    whatsappSent:   false,
    error:          `[${etapa}] ${msg}`,
  };
}

// ─── Limpeza de arquivos temporários ─────────────────────────────────────────

async function limparTemp(event: DriveFileWatcherEvent): Promise<void> {
  try {
    const tempDir = path.dirname(event.pdfPath);
    if (tempDir.includes('temp')) {
      await fs.rm(tempDir, { recursive: true, force: true });
      logger.debug(`[workflow] Temp removido: ${tempDir}`);
    }
  } catch (err) {
    logger.warn('[workflow] Não foi possível remover temp:', err);
  }
}

// ─── Workflow principal ───────────────────────────────────────────────────────

export async function processarContrato(
  event: DriveFileWatcherEvent,
): Promise<WorkflowDriveResult> {
  const { pdfPath, txtPath, txtContent, clientFolderName, folderId } = event;

  logger.info(`[workflow] ▶ Iniciando: "${clientFolderName}"`);

  // ── Etapa 1: Extrair dados da proposta PDF (Gemini) ───────────────────────
  let propostaData;
  try {
    logger.info('[workflow] 1/8 — Extraindo proposta (Gemini)...');
    propostaData = await extrairDadosProposta(pdfPath);
    logger.info(`[workflow]      Cliente: ${propostaData.nomeCliente}`);
  } catch (err) {
    return erroWorkflow('extrairDadosProposta', err, clientFolderName, folderId);
  }

  // ── Etapa 2: Extrair dados do cliente do txt (Claude) ────────────────────
  let dadosClienteTxt;
  try {
    logger.info('[workflow] 2/8 — Extraindo dados do cliente (Claude)...');
    dadosClienteTxt = await extrairDadosClienteTxt(txtPath, txtContent);
    logger.info(`[workflow]      CNPJ: ${dadosClienteTxt.cnpj} | email: ${dadosClienteTxt.emailCliente ?? '-'}`);
  } catch (err) {
    return erroWorkflow('extrairDadosClienteTxt', err, clientFolderName, folderId);
  }

  // ── Etapa 3: Consultar dados do CNPJ (BrasilAPI) ──────────────────────────
  let cnpjData;
  try {
    logger.info(`[workflow] 3/8 — Consultando BrasilAPI: ${dadosClienteTxt.cnpj}`);
    cnpjData = await consultarCnpj(dadosClienteTxt.cnpj);
    logger.info(`[workflow]      Razão Social: ${cnpjData.razaoSocial}`);
  } catch (err) {
    return erroWorkflow('consultarCnpj', err, clientFolderName, folderId);
  }

  // ── Etapa 4: Validar e corrigir dados (Claude) ────────────────────────────
  let contratoData: ContratoData;
  try {
    logger.info('[workflow] 4/8 — Validando dados do contrato (Claude)...');
    const dadosMerge: ContratoData = {
      ...propostaData,
      // Dados do txt têm prioridade sobre a proposta para campos de identificação
      ...(dadosClienteTxt.nomeCliente    ? { nomeCliente:     dadosClienteTxt.nomeCliente    } : {}),
      ...(dadosClienteTxt.emailCliente   ? { emailCliente:    dadosClienteTxt.emailCliente   } : {}),
      ...(dadosClienteTxt.telefoneCliente? { telefoneCliente: dadosClienteTxt.telefoneCliente} : {}),
      ...(dadosClienteTxt.cpfCliente     ? { cpfCliente:      dadosClienteTxt.cpfCliente     } : {}),
      ...cnpjData,
      pdfPath,
      status:    'processando',
      createdAt: new Date(),
    };
    contratoData = await validarDadosContrato(dadosMerge);
    logger.info('[workflow]      Dados validados ✔');
  } catch (err) {
    return erroWorkflow('validarDadosContrato', err, clientFolderName, folderId);
  }

  // ── Etapa 5: Gerar contrato .docx (docxtemplater) ─────────────────────────
  let contratoPath;
  try {
    logger.info('[workflow] 5/9 — Gerando contrato .docx...');
    contratoPath = await gerarContrato(contratoData);
    contratoData = { ...contratoData, status: 'gerado' };
    logger.info(`[workflow]      Arquivo: ${contratoPath}`);
  } catch (err) {
    return erroWorkflow('gerarContrato', err, clientFolderName, folderId);
  }

  // ── Etapa 6: Converter .docx → PDF (via Google Drive) ────────────────────
  let contratoPdfPath: string;
  try {
    logger.info('[workflow] 6/9 — Convertendo contrato para PDF...');
    contratoPdfPath = await converterDocxParaPdf(contratoPath);
    logger.info(`[workflow]      PDF: ${contratoPdfPath}`);
  } catch (err) {
    return erroWorkflow('converterDocxParaPdf', err, clientFolderName, folderId);
  }

  // ── Etapa 7: Upload do contrato (PDF) na pasta do cliente no Drive ────────
  let driveFileId: string | undefined;
  try {
    logger.info('[workflow] 7/9 — Enviando contrato PDF ao Google Drive...');
    driveFileId = await uploadContratoPastaCliente(folderId, contratoPdfPath);
    logger.info(`[workflow]      Drive File ID: ${driveFileId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[workflow] Upload ao Drive falhou (não crítico): ${msg}`);
  }

  // ── Etapa 8: Enviar para assinatura digital (Assinafy) ───────────────────
  let assinaturaResult;
  try {
    logger.info('[workflow] 8/9 — Enviando para assinatura digital (Assinafy)...');
    assinaturaResult = await enviarParaAssinatura({
      ...contratoData,
      pdfPath: contratoPdfPath,
    });
    contratoData = { ...contratoData, status: 'enviado' };
    logger.info(`[workflow]      Link: ${assinaturaResult.linkAssinatura}`);
  } catch (err) {
    return erroWorkflow('enviarParaAssinatura', err, clientFolderName, folderId);
  }

  // ── Etapa 8: Notificar cliente via WhatsApp ───────────────────────────────
  let whatsappSent = false;
  try {
    logger.info('[workflow] 9/9 — Enviando link via WhatsApp...');
    await enviarLinkAssinatura(
      contratoData.telefoneCliente,
      contratoData.nomeCliente,
      assinaturaResult.linkAssinatura,
    );
    whatsappSent = true;
    logger.info('[workflow]      WhatsApp enviado ✔');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[workflow] Falha ao enviar WhatsApp (não crítico): ${msg}`);
  }

  // ── Marcar pasta como processada no Drive ─────────────────────────────────
  try {
    await marcarPastaComoProcessada(folderId, clientFolderName);
  } catch (err) {
    logger.warn('[workflow] Não foi possível marcar pasta como processada:', err);
  }

  // ── Limpar arquivos temporários ───────────────────────────────────────────
  await limparTemp(event);

  logger.info(
    `[workflow] ✔ Concluído: "${clientFolderName}" | ` +
    `docId: ${assinaturaResult.documentId} | ` +
    `drive: ${driveFileId ?? 'N/A'} | ` +
    `whatsapp: ${whatsappSent}`,
  );

  return {
    success:        true,
    contratoPath,
    linkAssinatura: assinaturaResult.linkAssinatura,
    documentId:     assinaturaResult.documentId,
    whatsappSent,
    driveFileId,
  };
}
