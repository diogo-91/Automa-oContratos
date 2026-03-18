import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface GoogleDriveClientFolder {
  folderId:       string;
  clientName:     string;
  pdfFileId:      string | null;
  pdfFileName:    string | null;
  pdfMimeType:    string;    // mimeType real do arquivo de proposta
  txtFileId:      string | null;
  txtFileName:    string | null;
  txtMimeType:    string;    // mimeType real do arquivo de dados do cliente
  isReady:        boolean;
}

// Formatos aceitos
const MIME_GOOGLE_DOC    = 'application/vnd.google-apps.document';
const MIME_GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';
const MIME_DOCX          = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_PPTX          = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MIME_PPT           = 'application/vnd.ms-powerpoint';
const MIME_DOC           = 'application/msword';
const MIME_PDF           = 'application/pdf';

function isProposalFile(mimeType: string, name: string): boolean {
  const lower = name.toLowerCase();
  return (
    mimeType === MIME_PDF            ||
    mimeType === MIME_GOOGLE_SLIDES  ||
    mimeType === MIME_PPTX           ||
    mimeType === MIME_PPT            ||
    lower.endsWith('.pdf')           ||
    lower.endsWith('.pptx')          ||
    lower.endsWith('.ppt')
  );
}

function isClientDataFile(mimeType: string, name: string): boolean {
  const lower = name.toLowerCase();
  return (
    mimeType === MIME_GOOGLE_DOC     ||
    mimeType === MIME_DOCX           ||
    mimeType === MIME_DOC            ||
    lower.endsWith('.txt')           ||
    lower.endsWith('.docx')          ||
    lower.endsWith('.doc')
  );
}

// ─── Auth: Service Account (leitura/listagem) ─────────────────────────────────

function getDriveClient(): drive_v3.Drive {
  const credentialsPath =
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH ?? './credentials/google-service-account.json';

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `Credencial Google não encontrada em: ${credentialsPath}\n` +
      `Defina GOOGLE_SERVICE_ACCOUNT_PATH no .env`,
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return google.drive({ version: 'v3', auth });
}

// ─── Auth: OAuth2 com conta do usuário (upload — usa cota do usuário) ─────────

function getOAuthDriveClient(): drive_v3.Drive | null {
  const tokenPath    = process.env.GOOGLE_OAUTH_TOKEN_PATH ?? './credentials/google-oauth-token.json';
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret || !fs.existsSync(tokenPath)) {
    return null;
  }

  const tokens      = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
  const oauthClient = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/oauth/callback');
  oauthClient.setCredentials(tokens);

  // Persiste novos tokens automaticamente quando o access_token for renovado
  oauthClient.on('tokens', (newTokens) => {
    if (newTokens.refresh_token) tokens.refresh_token = newTokens.refresh_token;
    tokens.access_token = newTokens.access_token;
    tokens.expiry_date  = newTokens.expiry_date;
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    logger.debug('[drive] OAuth2 token renovado e salvo.');
  });

  return google.drive({ version: 'v3', auth: oauthClient });
}

// ─── Listagem de pastas dos clientes ─────────────────────────────────────────

export async function listarPastasClientes(): Promise<GoogleDriveClientFolder[]> {
  const drive = getDriveClient();
  const contratosFolderId = process.env.GOOGLE_DRIVE_CONTRATOS_FOLDER_ID;

  if (!contratosFolderId) {
    throw new Error('GOOGLE_DRIVE_CONTRATOS_FOLDER_ID não configurado no .env');
  }

  const foldersResponse = await drive.files.list({
    q: [
      `'${contratosFolderId}' in parents`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `trashed = false`,
    ].join(' and '),
    fields: 'files(id, name)',
    pageSize: 100,
  });

  const folders = foldersResponse.data.files ?? [];
  const clientFolders: GoogleDriveClientFolder[] = [];

  for (const folder of folders) {
    if (!folder.id || !folder.name) continue;

    // Ignora pastas já processadas ou em processamento
    if (
      folder.name.startsWith('✅') ||
      folder.name.startsWith('🔄') ||
      folder.name.startsWith('❌') ||
      folder.name.includes('[PROCESSADO]') ||
      folder.name.includes('[PROCESSANDO]') ||
      folder.name.includes('[ERRO]') ||
      folder.name.toUpperCase() === 'PROCESSED'
    ) {
      logger.debug(`[drive] Pasta ignorada (já processada): ${folder.name}`);
      continue;
    }

    const clientFolder = await verificarPastaCliente(folder.id, folder.name);
    clientFolders.push(clientFolder);
  }

  logger.info(`[drive] ${clientFolders.length} pasta(s) de clientes encontradas`);
  return clientFolders;
}

// ─── Verificação dos arquivos da pasta ───────────────────────────────────────

export async function verificarPastaCliente(
  folderId:   string,
  clientName: string,
): Promise<GoogleDriveClientFolder> {
  const drive = getDriveClient();

  const filesResponse = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
  });

  const files = filesResponse.data.files ?? [];

  let pdfFileId:   string | null = null;
  let pdfFileName: string | null = null;
  let pdfMimeType: string        = '';
  let txtFileId:   string | null = null;
  let txtFileName: string | null = null;
  let txtMimeType: string        = '';

  for (const file of files) {
    if (!file.id || !file.name || !file.mimeType) continue;

    if (isProposalFile(file.mimeType, file.name)) {
      // Proposta: PDF tem prioridade; outros formatos aceitos como fallback
      if (!pdfFileId || file.mimeType === MIME_PDF) {
        pdfFileId   = file.id;
        pdfFileName = file.name;
        pdfMimeType = file.mimeType;
      }
    } else if (isClientDataFile(file.mimeType, file.name)) {
      // Arquivo de dados do cliente (Google Docs, .docx, .doc, .txt)
      if (!txtFileId) {
        txtFileId   = file.id;
        txtFileName = file.name;
        txtMimeType = file.mimeType;
      }
    }
  }

  const isReady = pdfFileId !== null && txtFileId !== null;

  if (!isReady) {
    logger.debug(
      `[drive] Pasta incompleta: "${clientName}" ` +
      `(Proposta: ${pdfFileId ? '✔' : '✘'} | Dados: ${txtFileId ? '✔' : '✘'})`,
    );
  }

  return { folderId, clientName, pdfFileId, pdfFileName, pdfMimeType, txtFileId, txtFileName, txtMimeType, isReady };
}

// ─── Download de arquivo ──────────────────────────────────────────────────────

export async function downloadArquivo(fileId: string, destPath: string): Promise<void> {
  const drive = getDriveClient();

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );

  await new Promise<void>((resolve, reject) => {
    const dest   = fs.createWriteStream(destPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = response.data as any;
    stream.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    stream.on('error', reject);
  });

  logger.info(`[drive] Download concluído: ${path.basename(destPath)}`);
}

// ─── Exportar qualquer arquivo como texto plano ──────────────────────────────
// Suporta: Google Docs, .docx, .txt e outros formatos de texto

export async function exportArquivoComoTexto(
  fileId:   string,
  mimeType: string,
  destPath: string,
): Promise<void> {
  const drive = getDriveClient();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  if (mimeType === MIME_GOOGLE_DOC) {
    // Google Docs: exportar diretamente como texto simples
    logger.info(`[drive] Exportando Google Doc como texto: ${path.basename(destPath)}`);
    const res = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'stream' },
    );
    await streamParaArquivo(res.data as NodeJS.ReadableStream, destPath);

  } else if (mimeType === MIME_DOCX || mimeType.includes('wordprocessingml')) {
    // .docx: extrair texto localmente com mammoth (sem consumir cota do Drive)
    logger.info(`[drive] Convertendo .docx → texto via mammoth: ${path.basename(destPath)}`);
    const downloadPath = destPath + '.docx.tmp';
    await downloadArquivo(fileId, downloadPath);

    try {
      const mammoth = await import('mammoth');
      const result  = await mammoth.extractRawText({ path: downloadPath });
      fs.writeFileSync(destPath, result.value, 'utf-8');
    } finally {
      fs.rmSync(downloadPath, { force: true });
    }

  } else if (mimeType === MIME_PPTX || mimeType === MIME_PPT || mimeType.includes('presentationml')) {
    // .pptx/.ppt: extrair texto via LibreOffice
    logger.info(`[drive] Convertendo apresentação → texto via LibreOffice: ${path.basename(destPath)}`);
    const downloadPath = destPath + '.pptx.tmp';
    const ext = mimeType === MIME_PPT ? '.ppt' : '.pptx';
    const tmpWithExt = downloadPath + ext;
    await downloadArquivo(fileId, downloadPath);
    fs.renameSync(downloadPath, tmpWithExt);
    try {
      await converterParaTextoLibreOffice(tmpWithExt, path.dirname(destPath));
      const baseName = path.basename(tmpWithExt).replace(/\.[^.]+$/, '.txt');
      const txtGerado = path.join(path.dirname(destPath), baseName);
      if (fs.existsSync(txtGerado)) {
        fs.renameSync(txtGerado, destPath);
      } else {
        fs.writeFileSync(destPath, '', 'utf-8');
      }
    } finally {
      fs.rmSync(tmpWithExt, { force: true });
    }

  } else {
    // .txt e outros: download direto
    await downloadArquivo(fileId, destPath);
  }

  logger.info(`[drive] Dados do cliente exportados: ${path.basename(destPath)}`);
}

function streamParaArquivo(stream: NodeJS.ReadableStream, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    stream.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    stream.on('error', reject);
  });
}

// ─── Download do template (Google Docs → .docx) ──────────────────────────────

export async function downloadTemplate(): Promise<string> {
  const drive = getDriveClient();
  fs.mkdirSync('./templates', { recursive: true });

  const localPath = path.resolve('./templates', 'contrato.docx');

  // Prioridade 1: ID direto do arquivo Google Docs
  const templateFileId = process.env.GOOGLE_DRIVE_TEMPLATE_FILE_ID;
  if (templateFileId) {
    logger.info(`[drive] Exportando Google Docs como .docx (ID: ${templateFileId})`);
    await exportGoogleDocAsDocx(templateFileId, localPath);
    logger.info(`[drive] Template exportado: ${localPath}`);
    return localPath;
  }

  // Prioridade 2: Busca arquivo na pasta de templates
  const templateFolderId = process.env.GOOGLE_DRIVE_TEMPLATE_FOLDER_ID;
  if (!templateFolderId) {
    throw new Error(
      'Configure GOOGLE_DRIVE_TEMPLATE_FILE_ID ou GOOGLE_DRIVE_TEMPLATE_FOLDER_ID no .env',
    );
  }

  const filesResponse = await drive.files.list({
    q: [`'${templateFolderId}' in parents`, `trashed = false`].join(' and '),
    fields: 'files(id, name, mimeType)',
    pageSize: 10,
  });

  const files = filesResponse.data.files ?? [];

  // Prefere .docx; aceita Google Docs como fallback
  const docxFile  = files.find(f => f.name?.toLowerCase().endsWith('.docx'));
  const googleDoc = files.find(f => f.mimeType === 'application/vnd.google-apps.document');
  const chosen    = docxFile ?? googleDoc;

  if (!chosen?.id) {
    throw new Error('Nenhum template encontrado na pasta MODELO DE CONTRATO do Google Drive');
  }

  if (chosen.mimeType === 'application/vnd.google-apps.document') {
    logger.info(`[drive] Exportando Google Docs "${chosen.name}" como .docx`);
    await exportGoogleDocAsDocx(chosen.id, localPath);
  } else {
    await downloadArquivo(chosen.id, localPath);
  }

  logger.info(`[drive] Template pronto: ${localPath}`);
  return localPath;
}

// ─── Exporta Google Doc como .docx ───────────────────────────────────────────

async function exportGoogleDocAsDocx(fileId: string, destPath: string): Promise<void> {
  const drive = getDriveClient();

  const response = await drive.files.export(
    {
      fileId,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    { responseType: 'stream' },
  );

  await new Promise<void>((resolve, reject) => {
    const dest   = fs.createWriteStream(destPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = response.data as any;
    stream.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    stream.on('error', reject);
  });
}

// ─── Helper: executa LibreOffice headless ─────────────────────────────────────

async function getSofficePath(): Promise<string> {
  const { accessSync, constants } = await import('fs');
  const candidates = [
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    'soffice',
  ];
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return c; } catch { /* tenta próximo */ }
  }
  return 'soffice';
}

async function converterParaTextoLibreOffice(filePath: string, outDir: string): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const sofficePath = await getSofficePath();
  await execFileAsync(sofficePath, [
    '--headless', '--convert-to', 'txt:Text', '--outdir', outDir, filePath,
  ], { timeout: 60_000 });
}

// ─── Exportar proposta (qualquer formato) como PDF ────────────────────────────

export async function exportPropostaComoPdf(
  fileId:   string,
  mimeType: string,
  fileName: string,
  destDir:  string,
): Promise<string> {
  const drive    = getDriveClient();
  const pdfPath  = path.join(destDir, path.basename(fileName).replace(/\.[^.]+$/, '') + '.pdf');
  fs.mkdirSync(destDir, { recursive: true });

  if (mimeType === MIME_PDF || fileName.toLowerCase().endsWith('.pdf')) {
    // Já é PDF: download direto
    await downloadArquivo(fileId, pdfPath);

  } else if (mimeType === MIME_GOOGLE_SLIDES) {
    // Google Slides: exportar direto como PDF
    logger.info(`[drive] Exportando Google Slides como PDF: ${fileName}`);
    const res = await drive.files.export(
      { fileId, mimeType: MIME_PDF },
      { responseType: 'stream' },
    );
    await streamParaArquivo(res.data as NodeJS.ReadableStream, pdfPath);

  } else {
    // PPTX, DOCX, etc.: download + LibreOffice → PDF
    logger.info(`[drive] Convertendo ${path.extname(fileName)} → PDF via LibreOffice: ${fileName}`);
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const sofficePath   = await getSofficePath();

    const tmpPath = path.join(destDir, fileName);
    await downloadArquivo(fileId, tmpPath);

    try {
      await execFileAsync(sofficePath, [
        '--headless', '--convert-to', 'pdf', '--outdir', destDir, tmpPath,
      ], { timeout: 60_000 });
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }

    if (!fs.existsSync(pdfPath)) {
      throw new Error(`LibreOffice não gerou o PDF esperado: ${pdfPath}`);
    }
  }

  logger.info(`[drive] Proposta pronta como PDF: ${path.basename(pdfPath)}`);
  return pdfPath;
}

// ─── Converter .docx → .pdf via LibreOffice (local) ──────────────────────────

export async function converterDocxParaPdf(docxPath: string): Promise<string> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const pdfPath  = docxPath.replace(/\.docx$/i, '.pdf');
  const outDir   = path.dirname(docxPath);

  logger.info(`[drive] Convertendo .docx → .pdf (LibreOffice): ${path.basename(docxPath)}`);

  const sofficePath = await getSofficePath();

  await execFileAsync(sofficePath, [
    '--headless',
    '--convert-to', 'pdf',
    '--outdir', outDir,
    docxPath,
  ], { timeout: 60_000 });

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`LibreOffice não gerou o PDF esperado: ${pdfPath}`);
  }

  logger.info(`[drive] PDF gerado: ${path.basename(pdfPath)}`);
  return pdfPath;
}

// ─── Upload do contrato gerado para a pasta do cliente ───────────────────────

export async function uploadContratoPastaCliente(
  folderId: string,
  filePath: string,
): Promise<string> {
  // Prefere OAuth2 (usa cota da conta do usuário); cai no service account como fallback
  const drive    = getOAuthDriveClient() ?? getDriveClient();
  const fileName = path.basename(filePath);

  const lower    = fileName.toLowerCase();
  const mimeType = lower.endsWith('.pdf')
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const response = await drive.files.create({
    requestBody: {
      name:    fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id, name',
  });

  const uploadedId = response.data.id ?? '';
  logger.info(`[drive] Contrato enviado para Drive: "${fileName}" (ID: ${uploadedId})`);

  return uploadedId;
}

// ─── Marcar pasta como "em processamento" (evita reprocessamento duplo) ───────

export async function marcarPastaComoProcessando(
  folderId:   string,
  clientName: string,
): Promise<void> {
  const drive   = getDriveClient();
  const newName = `🔄 ${clientName} [PROCESSANDO]`;

  await drive.files.update({
    fileId:      folderId,
    requestBody: { name: newName },
  });

  logger.info(`[drive] Pasta marcada como processando: "${newName}"`);
}

// ─── Marcar pasta do cliente como processada ─────────────────────────────────

export async function marcarPastaComoProcessada(
  folderId:    string,
  clientName:  string,
): Promise<void> {
  const drive   = getDriveClient();
  const newName = `✅ ${clientName} [PROCESSADO]`;

  await drive.files.update({
    fileId:      folderId,
    requestBody: { name: newName },
  });

  logger.info(`[drive] Pasta renomeada para: "${newName}"`);
}

// ─── Marcar pasta com erro ────────────────────────────────────────────────────

export async function marcarPastaComoErro(
  folderId:   string,
  clientName: string,
): Promise<void> {
  const drive   = getDriveClient();
  const newName = `❌ ${clientName} [ERRO]`;

  await drive.files.update({
    fileId:      folderId,
    requestBody: { name: newName },
  });

  logger.info(`[drive] Pasta marcada como erro: "${newName}"`);
}
