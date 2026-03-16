import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { logger } from '../logger';
import type { AssinaturaResult, ContratoData } from '../types';

// ─── Constantes ───────────────────────────────────────────────────────────────

const BASE_URL = 'https://assinador.registrodeimoveis.org.br';

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface UploadResponse {
  id:          string;
  name:        string;
  contentType: string;
}

interface FlowActionUser {
  name:       string;
  identifier: string;   // CPF
  email:      string;
  phone:      string;
}

interface FlowAction {
  type:                    'Signer';
  step:                    number;
  allowElectronicSignature: boolean;
  user:                    FlowActionUser;
}

interface CreateDocumentBody {
  files: Array<{
    displayName:  string;
    id:           string;
    name:         string;
    contentType:  'application/pdf';
  }>;
  flowActions: FlowAction[];
}

interface CreateDocumentResponse {
  id: string;
}

interface ActionUrlResponse {
  url: string;
}

// ─── Cliente axios com auth ───────────────────────────────────────────────────

function getHeaders(): Record<string, string> {
  const apiKey = process.env.REGISTRO_IMOVEIS_API_KEY;
  if (!apiKey) throw new Error('REGISTRO_IMOVEIS_API_KEY não definida no ambiente');
  return { 'X-Api-Key': apiKey };
}

// ─── Função 1: uploadContrato ─────────────────────────────────────────────────

export async function uploadContrato(pdfPath: string): Promise<UploadResponse> {
  logger.info(`[registro] Fazendo upload: ${pdfPath}`);

  const fileBuffer  = await fs.readFile(pdfPath);
  const fileName    = path.basename(pdfPath);

  const form = new FormData();
  form.append('file', fileBuffer, {
    filename:    fileName,
    contentType: 'application/pdf',
  });

  const { data } = await axios.post<UploadResponse>(
    `${BASE_URL}/api/uploads`,
    form,
    {
      headers: {
        ...getHeaders(),
        ...form.getHeaders(),
      },
      timeout: 30_000,
    },
  );

  logger.info(`[registro] Upload concluído — id: ${data.id}`);
  return data;
}

// ─── Função 2: criarDocumento ─────────────────────────────────────────────────

export async function criarDocumento(params: {
  uploadId:    string;
  uploadName:  string;
  nomeCliente: string;
  cpfCliente:  string;
  email:       string;
  telefone:    string;
}): Promise<string> {
  logger.info(`[registro] Criando documento para: ${params.nomeCliente}`);

  const body: CreateDocumentBody = {
    files: [
      {
        displayName: params.nomeCliente,
        id:          params.uploadId,
        name:        params.uploadName,
        contentType: 'application/pdf',
      },
    ],
    flowActions: [
      {
        type:                    'Signer',
        step:                    1,
        allowElectronicSignature: true,
        user: {
          name:       params.nomeCliente,
          identifier: params.cpfCliente,
          email:      params.email,
          phone:      params.telefone,
        },
      },
    ],
  };

  const { data } = await axios.post<CreateDocumentResponse>(
    `${BASE_URL}/api/documents`,
    body,
    {
      headers: {
        ...getHeaders(),
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    },
  );

  logger.info(`[registro] Documento criado — id: ${data.id}`);
  return data.id;
}

// ─── Função 3: gerarLinkAssinatura ────────────────────────────────────────────

export async function gerarLinkAssinatura(
  documentId: string,
  cpf:        string,
  email:      string,
): Promise<string> {
  logger.info(`[registro] Gerando link de assinatura para documento: ${documentId}`);

  const { data } = await axios.post<ActionUrlResponse>(
    `${BASE_URL}/api/documents/${documentId}/action-url`,
    { identifier: cpf, emailAddress: email },
    {
      headers: {
        ...getHeaders(),
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    },
  );

  logger.info(`[registro] Link gerado: ${data.url}`);
  return data.url;
}

// ─── Função 4 (principal): enviarParaAssinatura ───────────────────────────────

export async function enviarParaAssinatura(
  dados: ContratoData & { pdfPath: string },
): Promise<AssinaturaResult> {
  logger.info(`[registro] Iniciando fluxo de assinatura para: ${dados.nomeCliente}`);

  // 1. Upload do PDF
  const upload = await uploadContrato(dados.pdfPath);

  // 2. Criação do documento com signatário
  const documentId = await criarDocumento({
    uploadId:    upload.id,
    uploadName:  upload.name,
    nomeCliente: dados.nomeCliente,
    cpfCliente:  dados.cpfCliente,
    email:       dados.emailCliente,
    telefone:    dados.telefoneCliente,
  });

  // 3. Geração do link de assinatura
  const linkAssinatura = await gerarLinkAssinatura(
    documentId,
    dados.cpfCliente,
    dados.emailCliente,
  );

  const resultado: AssinaturaResult = {
    documentId,
    linkAssinatura,
    embedUrl:  linkAssinatura,   // API retorna mesma URL; adaptar se houver endpoint embed separado
    createdAt: new Date(),
  };

  logger.info(`[registro] Fluxo concluído — documentId: ${documentId}`);
  return resultado;
}
