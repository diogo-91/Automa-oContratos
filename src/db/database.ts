import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH  = path.join(DATA_DIR, 'contracts.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id       TEXT    NOT NULL UNIQUE,
      folder_name     TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'iniciado',
      current_step    INTEGER DEFAULT 0,
      nome_cliente    TEXT,
      razao_social    TEXT,
      email_cliente   TEXT,
      telefone        TEXT,
      cnpj            TEXT,
      link_assinatura TEXT,
      drive_file_id   TEXT,
      assinafy_doc_id TEXT,
      whatsapp_sent   INTEGER DEFAULT 0,
      pdf_enviado_wpp INTEGER DEFAULT 0,
      error_message   TEXT,
      error_step      TEXT,
      started_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      completed_at    TEXT,
      duration_ms     INTEGER
    );

    CREATE TABLE IF NOT EXISTS contract_steps (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id  INTEGER NOT NULL,
      step_number  INTEGER NOT NULL,
      step_name    TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      error_msg    TEXT,
      started_at   TEXT,
      completed_at TEXT,
      duration_ms  INTEGER,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_contracts_status     ON contracts(status);
    CREATE INDEX IF NOT EXISTS idx_contracts_started_at ON contracts(started_at);
    CREATE INDEX IF NOT EXISTS idx_steps_contract       ON contract_steps(contract_id);
  `);

  logger.info('[db] Schema SQLite inicializado ✔');
}
