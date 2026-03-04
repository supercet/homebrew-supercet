import fs from 'fs';
import os from 'os';
import path from 'path';

interface SQLiteStatement<TRow = unknown> {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): TRow;
}

interface SQLiteDatabase {
	exec(sql: string): void;
	pragma(sql: string): unknown;
	prepare<TRow = unknown>(sql: string): SQLiteStatement<TRow>;
	close(): void;
}

interface SQLiteDatabaseOptions {
	nativeBinding?: string | object;
}

type SQLiteConstructor = new (filename: string, options?: SQLiteDatabaseOptions) => SQLiteDatabase;

interface SQLiteCountRow {
	count: number;
}

interface SQLiteConnectionRow {
	value: number;
}

interface SQLiteTableRow {
	name: string;
}

interface SQLiteCheckRow {
	id: number;
	created_at: string;
	note: string | null;
}

export interface SQLiteStatus {
	dbPath: string;
	totalChecks: number;
	lastCheck: SQLiteCheckRow | null;
}

interface SQLiteHealthChecks {
	connection: boolean;
	tablePresent: boolean;
	readable: boolean;
}

export interface SQLiteHealth {
	healthy: boolean;
	dbPath: string;
	checks: SQLiteHealthChecks;
	error?: string;
}

let sqliteDb: SQLiteDatabase | null = null;
let sqliteDbPath: string | null = null;

function resolveDatabasePath(): string {
	const configuredPath = process.env.SUPERCET_DB_PATH?.trim();
	if (configuredPath) {
		return path.resolve(configuredPath);
	}

	return path.join(os.homedir(), '.supercet', 'supercet.sqlite');
}

function loadSQLiteConstructor(): SQLiteConstructor {
	try {
		const loaded = require('better-sqlite3') as SQLiteConstructor | { default: SQLiteConstructor };
		if (typeof loaded === 'function') {
			return loaded;
		}
		if (loaded && typeof loaded.default === 'function') {
			return loaded.default;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		throw new Error(
			`Failed to load better-sqlite3 (${message}). Install dependencies with "npm install" before running the server.`,
		);
	}

	throw new Error('Loaded better-sqlite3 module but did not find a valid constructor export.');
}

function loadSQLiteNativeBinding(): object {
	try {
		return require('better-sqlite3/build/Release/better_sqlite3.node') as object;
	} catch (releaseError) {
		try {
			return require('better-sqlite3/build/Debug/better_sqlite3.node') as object;
		} catch {
			const message = releaseError instanceof Error ? releaseError.message : 'Unknown error';
			throw new Error(
				`Failed to load better-sqlite3 native binding (${message}). Ensure better_sqlite3.node is bundled as a pkg asset.`,
			);
		}
	}
}

function ensureTables(db: SQLiteDatabase) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS db_health_checks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			note TEXT
		);
	`);
}

function getDatabase(): SQLiteDatabase {
	if (sqliteDb) {
		return sqliteDb;
	}

	const dbPath = resolveDatabasePath();
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	const Database = loadSQLiteConstructor();
	const nativeBinding = loadSQLiteNativeBinding();
	const db = new Database(dbPath, { nativeBinding });
	db.pragma('journal_mode = WAL');
	ensureTables(db);

	sqliteDb = db;
	sqliteDbPath = dbPath;
	return db;
}

function readStatus(db: SQLiteDatabase): SQLiteStatus {
	const countRow = db.prepare<SQLiteCountRow>('SELECT COUNT(*) AS count FROM db_health_checks').get();
	const latestRow = db
		.prepare<SQLiteCheckRow>('SELECT id, created_at, note FROM db_health_checks ORDER BY id DESC LIMIT 1')
		.get();

	return {
		dbPath: sqliteDbPath || resolveDatabasePath(),
		totalChecks: Number(countRow?.count || 0),
		lastCheck: latestRow || null,
	};
}

export function initializeSQLite(): SQLiteStatus {
	const db = getDatabase();
	return readStatus(db);
}

export function getSQLiteStatus(): SQLiteStatus {
	const db = getDatabase();
	return readStatus(db);
}

export function verifySQLite(note?: string | null): SQLiteStatus {
	const db = getDatabase();
	db.prepare('INSERT INTO db_health_checks (note) VALUES (?)').run(note || null);
	return readStatus(db);
}

export function getSQLiteHealth(): SQLiteHealth {
	try {
		const db = getDatabase();
		const connectionRow = db.prepare<SQLiteConnectionRow>('SELECT 1 AS value').get();
		const tableRow = db
			.prepare<SQLiteTableRow>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'db_health_checks'",
			)
			.get();
		const countRow = db.prepare<SQLiteCountRow>('SELECT COUNT(*) AS count FROM db_health_checks').get();

		const checks = {
			connection: Number(connectionRow?.value) === 1,
			tablePresent: tableRow?.name === 'db_health_checks',
			readable: typeof countRow?.count === 'number',
		};

		return {
			healthy: checks.connection && checks.tablePresent && checks.readable,
			dbPath: sqliteDbPath || resolveDatabasePath(),
			checks,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown SQLite health error';
		return {
			healthy: false,
			dbPath: sqliteDbPath || resolveDatabasePath(),
			checks: {
				connection: false,
				tablePresent: false,
				readable: false,
			},
			error: message,
		};
	}
}

export function closeSQLite() {
	if (!sqliteDb) {
		return;
	}

	try {
		sqliteDb.close();
	} finally {
		sqliteDb = null;
		sqliteDbPath = null;
	}
}
