import fs from 'fs';
import os from 'os';
import path from 'path';

interface SQLiteStatement<TRow = unknown> {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): TRow;
	all(...params: unknown[]): TRow[];
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

interface SQLiteRunResult {
	changes?: number | bigint;
}

interface SQLiteCountRow {
	count: number;
}

interface SQLiteConnectionRow {
	value: number;
}

interface SQLiteTableRow {
	name: string;
}

interface SQLiteTableInfoRow {
	name: string;
}

interface SQLiteIdRow {
	id: string;
}

interface SQLiteUserVersionRow {
	user_version: number;
}

interface SQLiteCheckRow {
	id: number;
	created_at: string;
	note: string | null;
}

interface ConduitWorkspaceRow {
	id: string;
	path: string;
	repo_root_path: string;
	branch_name: string | null;
	parent_workspace_id: string | null;
	lifecycle_state: ConduitWorkspaceLifecycleState;
	completed_at: string | null;
	is_active: number;
	created_at: string;
	updated_at: string;
}

interface ConduitSessionIdRow {
	session_id: string;
}

interface ConduitSessionRow {
	session_id: string;
	provider_session_id: string | null;
	provider: ConduitProvider;
	agent_id: string;
	pipeline_id: string | null;
	workspace_id: string;
	model: string | null;
	status: ConduitSessionStatus;
	created_at: string;
	started_at: string | null;
	ended_at: string | null;
	updated_at: string;
}

interface ConduitSessionWithWorkspaceRow extends ConduitSessionRow {
	workspace_path: string | null;
}

interface ConduitSessionEventRow {
	session_id: string;
	seq: number;
	event_type: ConduitSessionEventType;
	role: ConduitSessionEventRole;
	content: string;
	created_at: string;
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

export interface ConduitWorkspaceRecord {
	id: string;
	path: string;
	repoRootPath: string;
	branchName: string | null;
	parentWorkspaceId: string | null;
	lifecycleState: ConduitWorkspaceLifecycleState;
	completedAt: string | null;
	isActive: boolean;
	isWorktree: boolean;
	createdAt: string;
	updatedAt: string;
}

export type ConduitProvider = 'claude' | 'codex';
export type ConduitWorkspaceLifecycleState = 'ready' | 'completed' | 'cleanup_failed';
export type ConduitWorkspaceEventType =
	| 'created'
	| 'activated'
	| 'branch_updated'
	| 'worktree_created'
	| 'worktree_cleanup_started'
	| 'worktree_cleanup_completed'
	| 'worktree_cleanup_failed'
	| 'completed'
	| 'hydrated';
export type ConduitSessionStatus = 'created' | 'running' | 'completed' | 'error' | 'timed_out' | 'cancelled';
export type ConduitSessionEventType =
	| 'prompt'
	| 'context'
	| 'stdout'
	| 'stderr'
	| 'sessionId'
	| 'complete'
	| 'error'
	| 'status';
export type ConduitSessionEventRole = 'client' | 'assistant' | 'system' | 'event';

export interface CreateConduitSessionInput {
	sessionId: string;
	providerSessionId?: string | null;
	provider: ConduitProvider;
	agentId: string;
	pipelineId?: string | null;
	workspaceId: string;
	model?: string | null;
	status: ConduitSessionStatus;
}

export interface ConduitSessionRecord {
	sessionId: string;
	providerSessionId: string | null;
	provider: ConduitProvider;
	agentId: string;
	pipelineId: string | null;
	workspaceId: string;
	workspacePath: string | null;
	model: string | null;
	status: ConduitSessionStatus;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
	updatedAt: string;
}

export interface ConduitSessionEventRecord {
	sessionId: string;
	seq: number;
	eventType: ConduitSessionEventType;
	role: ConduitSessionEventRole;
	content: string;
	createdAt: string;
}

export interface ListConduitSessionsFilters {
	agentId?: string;
	pipelineId?: string;
	workspaceId?: string;
	provider?: ConduitProvider;
	providerSessionId?: string;
	status?: ConduitSessionStatus;
	limit?: number;
	offset?: number;
}

export interface ListConduitSessionsResult {
	total: number;
	limit: number;
	offset: number;
	sessions: ConduitSessionRecord[];
}

export interface ReconcileRunningConduitSessionsResult {
	cancelledCount: number;
	cancelledSessionIds: string[];
}

export interface UpsertConduitWorkspaceInput {
	id: string;
	path: string;
	repoRootPath: string;
	branchName?: string | null;
	parentWorkspaceId?: string | null;
	lifecycleState?: ConduitWorkspaceLifecycleState;
}

let sqliteDb: SQLiteDatabase | null = null;
let sqliteDbPath: string | null = null;
const LATEST_SCHEMA_VERSION = 3;
const REQUIRED_TABLES = [
	'db_health_checks',
	'conduit_workspaces',
	'conduit_workspace_events',
	'conduit_sessions',
	'conduit_session_events',
];

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

function applySchemaV1(db: SQLiteDatabase) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS db_health_checks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			note TEXT
		);

		CREATE TABLE IF NOT EXISTS conduit_workspaces (
			id TEXT PRIMARY KEY,
			path TEXT NOT NULL UNIQUE,
			is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_conduit_workspaces_single_active
			ON conduit_workspaces(is_active)
			WHERE is_active = 1;

		CREATE TABLE IF NOT EXISTS conduit_sessions (
			session_id TEXT PRIMARY KEY,
			provider_session_id TEXT,
			provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
			agent_id TEXT NOT NULL,
			pipeline_id TEXT,
			workspace_id TEXT NOT NULL,
			model TEXT,
			status TEXT NOT NULL CHECK (status IN ('created', 'running', 'completed', 'error', 'timed_out', 'cancelled')),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			started_at TEXT,
			ended_at TEXT,
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (workspace_id) REFERENCES conduit_workspaces(id)
				ON UPDATE CASCADE
				ON DELETE RESTRICT
		);

		CREATE INDEX IF NOT EXISTS idx_conduit_sessions_agent_created_at
			ON conduit_sessions(agent_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_conduit_sessions_pipeline_created_at
			ON conduit_sessions(pipeline_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_conduit_sessions_workspace_created_at
			ON conduit_sessions(workspace_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_conduit_sessions_provider_session_id
			ON conduit_sessions(provider_session_id);

		CREATE TABLE IF NOT EXISTS conduit_session_events (
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL CHECK (seq >= 1),
			event_type TEXT NOT NULL CHECK (event_type IN ('prompt', 'context', 'stdout', 'stderr', 'sessionId', 'complete', 'error', 'status')),
			role TEXT NOT NULL CHECK (role IN ('client', 'assistant', 'system', 'event')),
			content TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (session_id, seq),
			FOREIGN KEY (session_id) REFERENCES conduit_sessions(session_id)
				ON UPDATE CASCADE
				ON DELETE CASCADE
		) WITHOUT ROWID;

		CREATE INDEX IF NOT EXISTS idx_conduit_session_events_created_at
			ON conduit_session_events(created_at);
		`);
}

function columnExists(db: SQLiteDatabase, tableName: string, columnName: string): boolean {
	const rows = db.prepare<SQLiteTableInfoRow>(`PRAGMA table_info(${tableName})`).all();
	return rows.some((row) => row.name === columnName);
}

function applySchemaV2(db: SQLiteDatabase) {
	if (!columnExists(db, 'conduit_workspaces', 'repo_root_path')) {
		db.exec('ALTER TABLE conduit_workspaces ADD COLUMN repo_root_path TEXT');
	}
	if (!columnExists(db, 'conduit_workspaces', 'branch_name')) {
		db.exec('ALTER TABLE conduit_workspaces ADD COLUMN branch_name TEXT');
	}
	if (!columnExists(db, 'conduit_workspaces', 'parent_workspace_id')) {
		db.exec(
			'ALTER TABLE conduit_workspaces ADD COLUMN parent_workspace_id TEXT REFERENCES conduit_workspaces(id) ON UPDATE CASCADE ON DELETE RESTRICT',
		);
	}
	if (!columnExists(db, 'conduit_workspaces', 'lifecycle_state')) {
		db.exec("ALTER TABLE conduit_workspaces ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'ready'");
	}
	if (!columnExists(db, 'conduit_workspaces', 'completed_at')) {
		db.exec('ALTER TABLE conduit_workspaces ADD COLUMN completed_at TEXT');
	}

	db.exec(`
		UPDATE conduit_workspaces
		SET
			repo_root_path = COALESCE(NULLIF(repo_root_path, ''), path),
			lifecycle_state = CASE
				WHEN lifecycle_state IN ('ready', 'completed', 'cleanup_failed') THEN lifecycle_state
				ELSE 'ready'
			END,
			updated_at = datetime('now')
		WHERE
			repo_root_path IS NULL
			OR repo_root_path = ''
			OR lifecycle_state IS NULL
			OR lifecycle_state NOT IN ('ready', 'completed', 'cleanup_failed');
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_conduit_workspaces_repo_root_path
			ON conduit_workspaces(repo_root_path);

		CREATE INDEX IF NOT EXISTS idx_conduit_workspaces_parent_workspace_id
			ON conduit_workspaces(parent_workspace_id);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_conduit_workspaces_ready_branch_unique
			ON conduit_workspaces(repo_root_path, branch_name)
			WHERE parent_workspace_id IS NOT NULL
				AND lifecycle_state = 'ready'
				AND branch_name IS NOT NULL;

		CREATE TABLE IF NOT EXISTS conduit_workspace_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			workspace_id TEXT NOT NULL,
			event_type TEXT NOT NULL CHECK (
				event_type IN (
					'created',
					'activated',
					'branch_updated',
					'worktree_created',
					'worktree_cleanup_started',
					'worktree_cleanup_completed',
					'worktree_cleanup_failed',
					'completed',
					'hydrated'
				)
			),
			details TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (workspace_id) REFERENCES conduit_workspaces(id)
				ON UPDATE CASCADE
				ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_conduit_workspace_events_workspace_created_at
			ON conduit_workspace_events(workspace_id, created_at DESC);
	`);
}

function applySchemaV3(db: SQLiteDatabase) {
	if (
		columnExists(db, 'conduit_sessions', 'conduit_session_id') &&
		!columnExists(db, 'conduit_sessions', 'session_id')
	) {
		db.exec('ALTER TABLE conduit_sessions RENAME COLUMN conduit_session_id TO session_id');
	}

	if (
		columnExists(db, 'conduit_session_events', 'conduit_session_id') &&
		!columnExists(db, 'conduit_session_events', 'session_id')
	) {
		db.exec('ALTER TABLE conduit_session_events RENAME COLUMN conduit_session_id TO session_id');
	}
}

function needsSessionIdSchemaRepair(db: SQLiteDatabase): boolean {
	return (
		(columnExists(db, 'conduit_sessions', 'conduit_session_id') &&
			!columnExists(db, 'conduit_sessions', 'session_id')) ||
		(columnExists(db, 'conduit_session_events', 'conduit_session_id') &&
			!columnExists(db, 'conduit_session_events', 'session_id'))
	);
}

function tableExists(db: SQLiteDatabase, tableName: string): boolean {
	const row = db
		.prepare<SQLiteTableRow>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(tableName);
	return row?.name === tableName;
}

function getSchemaVersion(db: SQLiteDatabase): number {
	const row = db.prepare<SQLiteUserVersionRow>('PRAGMA user_version').get();
	return typeof row?.user_version === 'number' ? row.user_version : 0;
}

function setSchemaVersion(db: SQLiteDatabase, version: number): void {
	const normalizedVersion = Number.isInteger(version) && version >= 0 ? version : 0;
	db.exec(`PRAGMA user_version = ${normalizedVersion}`);
}

function listMissingRequiredTables(db: SQLiteDatabase): string[] {
	return REQUIRED_TABLES.filter((tableName) => !tableExists(db, tableName));
}

function runSchemaMigrations(db: SQLiteDatabase): void {
	db.exec('BEGIN IMMEDIATE');
	try {
		const currentVersion = getSchemaVersion(db);
		if (currentVersion < 1) {
			applySchemaV1(db);
			setSchemaVersion(db, 1);
		}
		if (currentVersion < 2) {
			applySchemaV2(db);
			setSchemaVersion(db, 2);
		}
		if (currentVersion < 3) {
			applySchemaV3(db);
			setSchemaVersion(db, 3);
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}

	// Self-heal legacy/partial databases where required tables are missing.
	const missingTables = listMissingRequiredTables(db);
	if (missingTables.length > 0) {
		db.exec('BEGIN IMMEDIATE');
		try {
			applySchemaV1(db);
			applySchemaV2(db);
			applySchemaV3(db);
			const currentVersion = getSchemaVersion(db);
			if (currentVersion < LATEST_SCHEMA_VERSION) {
				setSchemaVersion(db, LATEST_SCHEMA_VERSION);
			}
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	}

	if (needsSessionIdSchemaRepair(db)) {
		db.exec('BEGIN IMMEDIATE');
		try {
			applySchemaV3(db);
			const currentVersion = getSchemaVersion(db);
			if (currentVersion < 3) {
				setSchemaVersion(db, 3);
			}
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	}

	const remainingMissingTables = listMissingRequiredTables(db);
	if (remainingMissingTables.length > 0) {
		throw new Error(`SQLite migration failed. Missing required tables: ${remainingMissingTables.join(', ')}`);
	}
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
	db.pragma('foreign_keys = ON');
	runSchemaMigrations(db);

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

function normalizeChanges(result: unknown): number {
	if (!result || typeof result !== 'object') {
		return 0;
	}

	const changesValue = (result as SQLiteRunResult).changes;
	if (typeof changesValue === 'number') {
		return changesValue;
	}

	if (typeof changesValue === 'bigint') {
		return Number(changesValue);
	}

	return 0;
}

function mapConduitWorkspaceRow(row: ConduitWorkspaceRow): ConduitWorkspaceRecord {
	return {
		id: row.id,
		path: row.path,
		repoRootPath: row.repo_root_path,
		branchName: row.branch_name,
		parentWorkspaceId: row.parent_workspace_id,
		lifecycleState: row.lifecycle_state,
		completedAt: row.completed_at,
		isActive: row.is_active === 1,
		isWorktree: row.parent_workspace_id !== null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapConduitSessionRow(row: ConduitSessionWithWorkspaceRow): ConduitSessionRecord {
	return {
		sessionId: row.session_id,
		providerSessionId: row.provider_session_id,
		provider: row.provider,
		agentId: row.agent_id,
		pipelineId: row.pipeline_id,
		workspaceId: row.workspace_id,
		workspacePath: row.workspace_path,
		model: row.model,
		status: row.status,
		createdAt: row.created_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		updatedAt: row.updated_at,
	};
}

function mapConduitSessionEventRow(row: ConduitSessionEventRow): ConduitSessionEventRecord {
	return {
		sessionId: row.session_id,
		seq: row.seq,
		eventType: row.event_type,
		role: row.role,
		content: row.content,
		createdAt: row.created_at,
	};
}

export function listConduitWorkspaces(): ConduitWorkspaceRecord[] {
	const db = getDatabase();
	const rows = db
		.prepare<ConduitWorkspaceRow>(
			`
				SELECT
					id,
					path,
					repo_root_path,
					branch_name,
					parent_workspace_id,
					lifecycle_state,
					completed_at,
					is_active,
					created_at,
					updated_at
				FROM conduit_workspaces
				ORDER BY created_at ASC
			`,
		)
		.all();

	return rows.map(mapConduitWorkspaceRow);
}

export function listReadyConduitWorkspaces(): ConduitWorkspaceRecord[] {
	const db = getDatabase();
	const rows = db
		.prepare<ConduitWorkspaceRow>(
			`
				SELECT
					id,
					path,
					repo_root_path,
					branch_name,
					parent_workspace_id,
					lifecycle_state,
					completed_at,
					is_active,
					created_at,
					updated_at
				FROM conduit_workspaces
				WHERE lifecycle_state = 'ready'
				ORDER BY created_at ASC
			`,
		)
		.all();

	return rows.map(mapConduitWorkspaceRow);
}

export function listConduitWorkspacesByMostRecentUpdate(): ConduitWorkspaceRecord[] {
	const db = getDatabase();
	const rows = db
		.prepare<ConduitWorkspaceRow>(
			`
					SELECT
						id,
						path,
						repo_root_path,
						branch_name,
						parent_workspace_id,
						lifecycle_state,
						completed_at,
						is_active,
						created_at,
						updated_at
					FROM conduit_workspaces
					WHERE lifecycle_state = 'ready'
					ORDER BY updated_at DESC, created_at DESC
				`,
		)
		.all();

	return rows.map(mapConduitWorkspaceRow);
}

export function upsertConduitWorkspace(input: UpsertConduitWorkspaceInput): void {
	const db = getDatabase();
	const lifecycleState = input.lifecycleState || 'ready';
	const branchName = input.branchName ?? null;
	const parentWorkspaceId = input.parentWorkspaceId ?? null;
	db.prepare(
		`
				INSERT INTO conduit_workspaces (
					id,
					path,
					repo_root_path,
					branch_name,
					parent_workspace_id,
					lifecycle_state,
					completed_at,
					is_active
				)
				VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END, 0)
				ON CONFLICT(id) DO UPDATE SET
					path = excluded.path,
					repo_root_path = excluded.repo_root_path,
					branch_name = excluded.branch_name,
					parent_workspace_id = excluded.parent_workspace_id,
					lifecycle_state = excluded.lifecycle_state,
					completed_at = CASE
						WHEN excluded.lifecycle_state = 'completed' AND conduit_workspaces.completed_at IS NULL
							THEN datetime('now')
						WHEN excluded.lifecycle_state = 'completed'
							THEN conduit_workspaces.completed_at
						ELSE NULL
					END,
					updated_at = datetime('now')
			`,
	).run(input.id, input.path, input.repoRootPath, branchName, parentWorkspaceId, lifecycleState, lifecycleState);
}

export function conduitWorkspaceIdExists(workspaceId: string): boolean {
	const db = getDatabase();
	const row = db.prepare<SQLiteIdRow>('SELECT id FROM conduit_workspaces WHERE id = ? LIMIT 1').get(workspaceId);
	return row?.id === workspaceId;
}

export function setConduitWorkspaceLifecycleState(
	workspaceId: string,
	lifecycleState: ConduitWorkspaceLifecycleState,
): void {
	const db = getDatabase();
	const result = db
		.prepare(
			`
				UPDATE conduit_workspaces
				SET
					lifecycle_state = ?,
					is_active = CASE WHEN ? = 'ready' THEN is_active ELSE 0 END,
					completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END,
					updated_at = datetime('now')
				WHERE id = ?
			`,
		)
		.run(lifecycleState, lifecycleState, lifecycleState, workspaceId);

	if (normalizeChanges(result) === 0) {
		throw new Error(`Workspace '${workspaceId}' was not found in conduit_workspaces`);
	}
}

export function appendConduitWorkspaceEvent(
	workspaceId: string,
	eventType: ConduitWorkspaceEventType,
	details?: string | null,
): void {
	const db = getDatabase();
	const result = db
		.prepare(
			`
				INSERT INTO conduit_workspace_events (workspace_id, event_type, details)
				VALUES (?, ?, ?)
			`,
		)
		.run(workspaceId, eventType, details || null);

	if (normalizeChanges(result) === 0) {
		throw new Error(`Failed to append workspace event for workspace '${workspaceId}'`);
	}
}

export function setConduitWorkspaceActiveState(workspaceId: string, isActive: boolean): void {
	const db = getDatabase();
	const result = db
		.prepare(
			`
					UPDATE conduit_workspaces
					SET is_active = ?, updated_at = datetime('now')
					WHERE id = ? AND lifecycle_state = 'ready'
				`,
		)
		.run(isActive ? 1 : 0, workspaceId);

	if (normalizeChanges(result) === 0) {
		throw new Error(`Workspace '${workspaceId}' was not found in conduit_workspaces`);
	}
}

export function activateConduitWorkspace(workspaceId: string): void {
	const db = getDatabase();
	db.exec('BEGIN IMMEDIATE');

	try {
		db.prepare(
			`
				UPDATE conduit_workspaces
				SET is_active = 0, updated_at = datetime('now')
				WHERE is_active = 1
			`,
		).run();
		setConduitWorkspaceActiveState(workspaceId, true);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function deactivateConduitWorkspaces(): void {
	const db = getDatabase();
	db.prepare(
		`
			UPDATE conduit_workspaces
			SET is_active = 0, updated_at = datetime('now')
			WHERE is_active = 1
		`,
	).run();
}

export function removeConduitWorkspace(workspaceId: string): void {
	const db = getDatabase();
	try {
		const result = db.prepare('DELETE FROM conduit_workspaces WHERE id = ?').run(workspaceId);
		if (normalizeChanges(result) === 0) {
			throw new Error(`Workspace '${workspaceId}' was not found in conduit_workspaces`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) {
			const sessionCountRow = db
				.prepare<SQLiteCountRow>('SELECT COUNT(*) AS count FROM conduit_sessions WHERE workspace_id = ?')
				.get(workspaceId);
			const childWorkspaceCountRow = db
				.prepare<SQLiteCountRow>(
					'SELECT COUNT(*) AS count FROM conduit_workspaces WHERE parent_workspace_id = ?',
				)
				.get(workspaceId);
			const sessionCount = Number(sessionCountRow?.count || 0);
			const childWorkspaceCount = Number(childWorkspaceCountRow?.count || 0);

			if (sessionCount > 0 && childWorkspaceCount > 0) {
				throw new Error(
					`Cannot remove workspace '${workspaceId}' because it has associated sessions and child worktrees`,
				);
			}
			if (sessionCount > 0) {
				throw new Error(`Cannot remove workspace '${workspaceId}' because it has associated sessions`);
			}
			if (childWorkspaceCount > 0) {
				throw new Error(`Cannot remove workspace '${workspaceId}' because it has child worktrees`);
			}

			throw new Error(`Cannot remove workspace '${workspaceId}' because dependent records still reference it`);
		}
		throw error;
	}
}

export function getConduitWorkspaceById(workspaceId: string): ConduitWorkspaceRecord | null {
	const db = getDatabase();
	const row = db
		.prepare<ConduitWorkspaceRow>(
			`
				SELECT
					id,
					path,
					repo_root_path,
					branch_name,
					parent_workspace_id,
					lifecycle_state,
					completed_at,
					is_active,
					created_at,
					updated_at
				FROM conduit_workspaces
				WHERE id = ?
			`,
		)
		.get(workspaceId);

	return row ? mapConduitWorkspaceRow(row) : null;
}

export function findLatestConduitSessionIdByProviderSession(
	provider: ConduitProvider,
	providerSessionId: string,
): string | null {
	const db = getDatabase();
	const row = db
		.prepare<ConduitSessionIdRow>(
			`
				SELECT session_id
				FROM conduit_sessions
				WHERE provider = ? AND provider_session_id = ?
				ORDER BY updated_at DESC, created_at DESC
				LIMIT 1
			`,
		)
		.get(provider, providerSessionId);

	return row?.session_id || null;
}

export function createConduitSession(input: CreateConduitSessionInput): void {
	const db = getDatabase();
	const startedAt = input.status === 'running' ? "datetime('now')" : 'NULL';
	db.prepare(
		`
			INSERT INTO conduit_sessions (
				session_id,
				provider_session_id,
				provider,
				agent_id,
				pipeline_id,
				workspace_id,
				model,
				status,
				started_at,
				ended_at,
				updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ${startedAt}, NULL, datetime('now')
			)
		`,
	).run(
		input.sessionId,
		input.providerSessionId || null,
		input.provider,
		input.agentId,
		input.pipelineId || null,
		input.workspaceId,
		input.model || null,
		input.status,
	);
}

export function updateConduitSessionForRun(
	sessionId: string,
	input: Omit<CreateConduitSessionInput, 'sessionId'>,
): void {
	const db = getDatabase();
	const result = db
		.prepare(
			`
				UPDATE conduit_sessions
				SET
					provider_session_id = ?,
					provider = ?,
					agent_id = ?,
					pipeline_id = ?,
					workspace_id = ?,
					model = ?,
					status = ?,
					started_at = datetime('now'),
					ended_at = NULL,
					updated_at = datetime('now')
				WHERE session_id = ?
			`,
		)
		.run(
			input.providerSessionId || null,
			input.provider,
			input.agentId,
			input.pipelineId || null,
			input.workspaceId,
			input.model || null,
			input.status,
			sessionId,
		);

	if (normalizeChanges(result) === 0) {
		throw new Error(`Conduit session '${sessionId}' was not found`);
	}
}

export function setConduitSessionProviderSessionId(sessionId: string, providerSessionId: string): void {
	const db = getDatabase();
	const result = db
		.prepare(
			`
				UPDATE conduit_sessions
				SET provider_session_id = ?, updated_at = datetime('now')
				WHERE session_id = ?
			`,
		)
		.run(providerSessionId, sessionId);

	if (normalizeChanges(result) === 0) {
		throw new Error(`Conduit session '${sessionId}' was not found`);
	}
}

export function setConduitSessionStatus(sessionId: string, status: ConduitSessionStatus): void {
	const db = getDatabase();
	const endedAtClause = status === 'running' || status === 'created' ? 'NULL' : "datetime('now')";
	const result = db
		.prepare(
			`
				UPDATE conduit_sessions
				SET
					status = ?,
					ended_at = ${endedAtClause},
					updated_at = datetime('now')
				WHERE session_id = ?
			`,
		)
		.run(status, sessionId);

	if (normalizeChanges(result) === 0) {
		throw new Error(`Conduit session '${sessionId}' was not found`);
	}
}

export function reconcileRunningConduitSessionsOnStartup(): ReconcileRunningConduitSessionsResult {
	const db = getDatabase();
	db.exec('BEGIN IMMEDIATE');

	try {
		const runningSessionRows = db
			.prepare<ConduitSessionIdRow>(
				`
					SELECT session_id
					FROM conduit_sessions
					WHERE status = 'running'
					ORDER BY created_at ASC
				`,
			)
			.all();

		if (runningSessionRows.length === 0) {
			db.exec('COMMIT');
			return {
				cancelledCount: 0,
				cancelledSessionIds: [],
			};
		}

		const updateResult = db
			.prepare(
				`
					UPDATE conduit_sessions
					SET
						status = 'cancelled',
						ended_at = datetime('now'),
						updated_at = datetime('now')
					WHERE status = 'running'
				`,
			)
			.run();

		const appendStatusEventStatement = db.prepare(
			`
				INSERT INTO conduit_session_events (session_id, seq, event_type, role, content)
				VALUES (
					?,
					COALESCE(
						(SELECT MAX(seq) + 1 FROM conduit_session_events WHERE session_id = ?),
						1
					),
					'status',
					'event',
					'cancelled'
				)
			`,
		);

		for (const row of runningSessionRows) {
			appendStatusEventStatement.run(row.session_id, row.session_id);
		}

		db.exec('COMMIT');
		return {
			cancelledCount: normalizeChanges(updateResult),
			cancelledSessionIds: runningSessionRows.map((row) => row.session_id),
		};
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function appendConduitSessionEvent(
	sessionId: string,
	eventType: ConduitSessionEventType,
	role: ConduitSessionEventRole,
	content: string,
): void {
	const db = getDatabase();
	const result = db
		.prepare(
			`
				INSERT INTO conduit_session_events (session_id, seq, event_type, role, content)
				VALUES (
					?,
					COALESCE(
						(SELECT MAX(seq) + 1 FROM conduit_session_events WHERE session_id = ?),
						1
					),
					?,
					?,
					?
				)
			`,
		)
		.run(sessionId, sessionId, eventType, role, content);

	if (normalizeChanges(result) === 0) {
		throw new Error(`Failed to append event for conduit session '${sessionId}'`);
	}
}

export function listConduitSessions(filters: ListConduitSessionsFilters = {}): ListConduitSessionsResult {
	const db = getDatabase();
	const whereConditions: string[] = [];
	const whereParams: unknown[] = [];

	if (filters.agentId) {
		whereConditions.push('s.agent_id = ?');
		whereParams.push(filters.agentId);
	}
	if (filters.pipelineId) {
		whereConditions.push('s.pipeline_id = ?');
		whereParams.push(filters.pipelineId);
	}
	if (filters.workspaceId) {
		whereConditions.push('s.workspace_id = ?');
		whereParams.push(filters.workspaceId);
	}
	if (filters.provider) {
		whereConditions.push('s.provider = ?');
		whereParams.push(filters.provider);
	}
	if (filters.providerSessionId) {
		whereConditions.push('s.provider_session_id = ?');
		whereParams.push(filters.providerSessionId);
	}
	if (filters.status) {
		whereConditions.push('s.status = ?');
		whereParams.push(filters.status);
	}

	const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
	const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
	const offset = Math.max(0, filters.offset ?? 0);

	const countRow = db
		.prepare<SQLiteCountRow>(
			`
				SELECT COUNT(*) AS count
				FROM conduit_sessions s
				${whereClause}
			`,
		)
		.get(...whereParams);

	const rows = db
		.prepare<ConduitSessionWithWorkspaceRow>(
			`
				SELECT
					s.session_id,
					s.provider_session_id,
					s.provider,
					s.agent_id,
					s.pipeline_id,
					s.workspace_id,
					w.path AS workspace_path,
					s.model,
					s.status,
					s.created_at,
					s.started_at,
					s.ended_at,
					s.updated_at
				FROM conduit_sessions s
				LEFT JOIN conduit_workspaces w
					ON w.id = s.workspace_id
				${whereClause}
				ORDER BY s.updated_at DESC, s.created_at DESC
				LIMIT ? OFFSET ?
			`,
		)
		.all(...whereParams, limit, offset);

	return {
		total: Number(countRow?.count || 0),
		limit,
		offset,
		sessions: rows.map(mapConduitSessionRow),
	};
}

export function getConduitSessionById(sessionId: string): ConduitSessionRecord | null {
	const db = getDatabase();
	const row = db
		.prepare<ConduitSessionWithWorkspaceRow>(
			`
				SELECT
					s.session_id,
					s.provider_session_id,
					s.provider,
					s.agent_id,
					s.pipeline_id,
					s.workspace_id,
					w.path AS workspace_path,
					s.model,
					s.status,
					s.created_at,
					s.started_at,
					s.ended_at,
					s.updated_at
				FROM conduit_sessions s
				LEFT JOIN conduit_workspaces w
					ON w.id = s.workspace_id
				WHERE s.session_id = ?
			`,
		)
		.get(sessionId);

	return row ? mapConduitSessionRow(row) : null;
}

export function getConduitSessionEvents(sessionId: string): ConduitSessionEventRecord[] {
	const db = getDatabase();
	const rows = db
		.prepare<ConduitSessionEventRow>(
			`
				SELECT session_id, seq, event_type, role, content, created_at
				FROM conduit_session_events
				WHERE session_id = ?
				ORDER BY seq ASC
			`,
		)
		.all(sessionId);

	return rows.map(mapConduitSessionEventRow);
}
