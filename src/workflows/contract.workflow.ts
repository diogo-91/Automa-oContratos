import fs from 'fs/promises';
import path from 'path';
import { logger } from '../logger';

import { extrairDadosProposta }                           from '../ai/gemini.service';
import { extrairDadosClienteTxt, validarDadosContrato }   from '../ai/claude.service';
import { consultarCnpj }                                  from '../services/cnpj.service';
import { gerarContrato }                                  from '../services/contract.service';
import { enviarParaAssinatura }                           from '../services/assinafy.service';
import { notificarClienteWhatsapp }                       from '../services/whatsapp.service';
import {
  uploadContratoPastaCliente,
  marcarPastaComoProcessada,
  marcarPastaComoErro,
  converterDocxParaPdf,
} from '../services/googledrive.service';
import * as track from '../services/tracking.service';

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

  // Inicializa rastreamento (nunca lança exceção)
  const tracker = track.criarRastreamento(folderId, clientFolderName);

  // ── Etapa 1: Extrair dados da proposta PDF (Gemini) ───────────────────────
  let propostaData;
  try {
    logger.info('[workflow] 1/9 — Extraindo proposta (Gemini)...');
    track.iniciarEtapa(tracker, 1);
    propostaData = await extrairDadosProposta(pdfPath);
    track.concluirEtapa(tracker, 1);
    track.atualizarDados(tracker, { nomeCliente: propostaData.nomeCliente });
    logger.info(`[workflow]      Cliente: ${propostaData.nomeCliente}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    track.erroEtapa(tracker, 1, msg);
    return erroWorkflow('extrairDadosProposta', err, clientFolderName, folderId);
  }

  // ── Etapa 2: Extrair dados do cliente do txt (Claude) ────────────────────
  let dadosClienteTxt;
  try {
    logger.info('[workflow] 2/9 — Extraindo dados do cliente (Claude)...');
    track.iniciarEtapa(tracker, 2);
    dadosClienteTxt = await extrairDadosClienteTxt(txtPath, txtContent);
    track.concluirEtapa(tracker, 2);
    track.atualizarDados(tracker, {
      emailCliente: dadosClienteTxt.emailCliente,
      telefone:     dadosClienteTxt.telefoneCliente,
      cnpj:         dadosClienteTxt.cnpj,
    });
    logger.info(`[workflow]      CNPJ: ${dadosClienteTxt.cnpj} | email: ${dadosClienteTxt.emailCliente ?? '-'}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    track.erroEtapa(tracker, 2, msg);
    return erroWorkflow('extrairDadosClienteTxt', err, clientFolderName, folderId);
  }

  // ── Etapa 3: Consultar dados do CNPJ (BrasilAPI) ──────────────────────────
  let cnpjData;
  try {
    logger.info(`[workflow] 3/9 — Consultando BrasilAPI: ${dadosClienteTxt.cnpj}`);
    track.iniciarEtapa(tracker, 3);
    cnpjData = await consultarCnpj(dadosClienteTxt.cnpj);
    track.concluirEtapa(tracker, 3);
    track.atualizarDados(tracker, { razaoSocial: cnpjData.razaoSocial });
    logger.info(`[workflow]      Razão Social: ${cnpjData.razaoSocial}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    track.erroEtapa(tracker, 3, msg);
    return erroWorkflow('consultarCnpj', err, clientFolderName, folderId);
  }

  // ── Etapa 4: Validar e corrigir dados (Claude) ────────────────────────────
  let contratoData: ContratoData;
  try {
    logger.info('[workflow] 4/9 — Validando dados do contrato (Claude)...');
    track.iniciarEtapa(tracker, 4);
    const dadosMerge: ContratoData = {
      ...propostaData,
      ...(dadosClienteTxt.nomeCliente     ? { nomeCliente:     dadosClienteTxt.nomeCliente     } : {}),
      ...(dadosClienteTxt.emailCliente    ? { emailCliente:    dadosClienteTxt.emailCliente    } : {}),
      ...(dadosClienteTxt.telefoneCliente ? { telefoneCliente: dadosClienteTxt.telefoneCliente } : {}),
      ...(dadosClienteTxt.cpfCliente      ? { cpfCliente:      dadosClienteTxt.cpfCliente      } : {}),
      ...cnpjData,
      pdfPath,
      status:    'processando',
      createdAt: new Date(),
    };
    contratoData = await validarDadosContrato(dadosMerge);
    track.concluirEtapa(tracker, 4);
    track.atualizarDados(tracker, {
      nomeCliente:  contratoData.nomeCliente,
      razaoSocial:  contratoData.razaoSocial,
      emailCliente: contratoData.emailCliente,
      telefone:     contratoData.telefoneCliente,
      cnpj:         contratoData.cnpj,
    });
    logger.info('[workflow]      Dados validados ✔');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    track.erroEtapa(tracker, 4, msg);
    return erroWorkflow('validarDadosContrato', err, clientFolderName, folderId);
  }

  // ── Etapa 5: Gerar contrato .docx (docxtemplater) ─────────────────────────
  let contratoPath;
  try {
    logger.info('[workflow] 5/9 — Gerando contrato .docx...');
    track.iniciarEtapa(tracker, 5);
    contratoPath = await gerarContrato(contratoData);
    contratoData = { ...contratoData, status: 'gerado' };
    track.concluirEtapa(tracker, 5);
    logger.info(`[workflow]      Arquivo: ${contratoPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    track.erroEtapa(tracker, 5, msg);
    return erroWorkflow('gerarContrato', err, clientFolderName, folderId);
  }

  // ── Etapa 6: Converter .docx → PDF (via Google Drive) ────────────────────
  let contratoPdfPath: string;
  try {
    logger.info('[workflow] 6/9 — Convertendo contrato para PDF...');
    track.iniciarEtapa(tracker, 6);
    contratoPdfPath = await converterDocxParaPdf(contratoPath);
    track.concluirEtapa(tracker, 6);
    logger.info(`[workflow]      PDF: ${contratoPdfPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    track.erroEtapa(tracker, 6, msg);
    return erroWorkflow('converterDocxParaPdf', err, clientFolderName, folderId);
  }

  // ── Etapa 7: Upload do contrato (PDF) na pasta do cliente no Drive ────────
  let driveFileId: string | undefined;
  try {
    logger.info('[workflow] 7/9 — Enviando contrato PDF ao Google Drive...');
    track.iniciarEtapa(tracker, 7);
    driveFileId = await uploadContratoPastaCliente(folderId, contratoPdfPath);
    track.concluirEtapa(tracker, 7);
    track.atualizarDados(tracker, { driveFileId });
    logger.info(`[workflow]      Drive File ID: ${driveFileId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[workflow] Upload ao Drive falhou (não crítico): ${msg}`);
    track.erroEtapa(tracker, 7, msg);
    // Não crítico — continua o workflow
  }

  // ── Etapa 8: Enviar para assinatura digital (Assinafy) ───────────────────
  let assinaturaResult;
  try {
    logger.info('[workflow] 8/9 — Enviando para assinatura digital (Assinafy)...');
    track.iniciarEtapa(tracker, 8);
    assinaturaResult = await enviarParaAssinatura({
      ...contratoData,
      pdfPath: contratoPdfPath,
    });
    contratoData = { ...contratoData, status: 'enviado' };
    track.concluirEtapa(tracker, 8);
    track.atualizarDados(tracker, {
      linkAssinatura: assinaturaResult.linkAssinatura,
      assinafyDocId:  assinaturaResult.documentId,
    });
    logger.info(`[workflow]      Link: ${assinaturaResult.linkAssinatura}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    track.erroEtapa(tracker, 8, msg);
    return erroWorkflow('enviarParaAssinatura', err, clientFolderName, folderId);
  }

  // ── Etapa 9: Notificar cliente via WhatsApp (PDF + link de assinatura) ──────
  let whatsappSent  = false;
  let pdfEnviadoWpp = false;
  try {
    logger.info('[workflow] 9/9 — Notificando cliente via WhatsApp...');
    track.iniciarEtapa(tracker, 9);
    const resultWpp = await notificarClienteWhatsapp({
      telefone:     contratoData.telefoneCliente,
      nomeCliente:  contratoData.nomeCliente,
      nomeEmpresa:  contratoData.razaoSocial ?? contratoData.nomeCliente,
      link:         assinaturaResult.linkAssinatura,
      emailCliente: contratoData.emailCliente,
      pdfPath:      contratoPdfPath,
    });
    whatsappSent  = resultWpp.linkEnviado;
    pdfEnviadoWpp = resultWpp.pdfEnviado;
    track.concluirEtapa(tracker, 9);
    logger.info(
      `[workflow]      WhatsApp ✔ | PDF: ${pdfEnviadoWpp ? 'enviado' : 'não enviado'} | Link: enviado`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[workflow] Falha ao enviar WhatsApp (não crítico): ${msg}`);
    track.erroEtapa(tracker, 9, msg);
    // Não crítico — continua
  }

  // ── Finalizar rastreamento ─────────────────────────────────────────────────
  track.concluirRastreamento(tracker, { whatsappSent, pdfEnviadoWpp });

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
