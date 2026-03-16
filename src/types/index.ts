// ─── Proposta ────────────────────────────────────────────────────────────────

export interface PropostaData {
  // ── Dados do contratante (cliente) ──
  nomeCliente:      string;   // nome do responsável/representante da empresa
  cpfCliente:       string;   // CPF do representante
  emailCliente:     string;
  telefoneCliente:  string;

  // ── Financeiro ──
  valorContrato:    number;   // valor numérico total de implantação
  valorImplantacaoTexto: string;  // ex: "R$ 6.500,00 (Seis mil e quinhentos reais)"
  itensImplantacao: string;   // quebras de linha com os itens do valor, ex: "R$ 6.000,00 (Funil IA)\nR$ 500,00 (Integração)"
  valorMensalidade: string;   // ex: "R$ 300,00 (Trezentos reais)/mês"
  condicoesPagamento: string; // ex: "Parcelamento em até 1+4 parcelas mensais no boleto"

  // ── Escopo e prazo ──
  descricaoServicos: string;  // texto completo dos serviços contratados (pode conter \n)
  cronograma:        string;  // prazos de implantação, ex: "Automação X: 7 a 10 dias úteis\nFunil IA: até 45 dias úteis"
  vigencia:          string;  // duração do contrato de gestão, ex: "12 meses"
  dataAssinatura:    string;  // ex: "01 de Março de 2026"

  observacoes?: string;
}

// ─── CNPJ (BrasilAPI) ────────────────────────────────────────────────────────

export interface QsaSocio {
  nome: string;
  qual: string;
  cpfCnpjSocio: string;
}

export interface CnpjData {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string;
  situacaoCadastral: string;
  dataAbertura: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
  telefone: string;
  email: string;
  qsa: QsaSocio[];
}

// ─── Contrato (merge Proposta + CNPJ) ────────────────────────────────────────

export interface ContratoData extends PropostaData, CnpjData {
  pdfPath: string;
  status: ContratoStatus;
  createdAt: Date;
}

export type ContratoStatus =
  | 'pendente'
  | 'processando'
  | 'gerado'
  | 'enviado'
  | 'assinado'
  | 'erro';

// ─── Assinatura ───────────────────────────────────────────────────────────────

export interface AssinaturaResult {
  documentId: string;
  linkAssinatura: string;
  embedUrl: string;
  createdAt: Date;
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export interface WorkflowResult {
  success: boolean;
  contratoPath: string;
  linkAssinatura: string;
  documentId: string;
  whatsappSent: boolean;
  error?: string;
}

// ─── File Watcher ─────────────────────────────────────────────────────────────

export interface FileWatcherEvent {
  pdfPath:    string;
  txtPath:    string;
  baseName:   string;
  detectedAt: Date;
}

/** Estende FileWatcherEvent com metadados do Google Drive */
export interface DriveFileWatcherEvent extends FileWatcherEvent {
  folderId:         string;  // ID da pasta do cliente no Drive
  clientFolderName: string;  // Nome da pasta (ex: "CLIENTE JOÃO")
  pdfFileId:        string;  // ID do arquivo PDF no Drive
  txtFileId:        string;  // ID do arquivo TXT no Drive
  txtContent?:      string;  // Conteúdo do arquivo de dados do cliente (lido em memória pelo watcher)
}

// ─── Workflow Result Drive (estendido) ────────────────────────────────────────

export interface WorkflowDriveResult extends WorkflowResult {
  driveFileId?: string;  // ID do contrato após upload ao Google Drive
}
