import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HTTPServer } from 'node:http';
import { execFile, type ExecFileException } from 'node:child_process';
import pty from 'node-pty';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'node:util';
import 'dotenv/config';
import { handleSocketGitOperation, createGitOperations, releaseGitClient } from './utils/gitHelpers';
import { isPortAvailable, checkForUpdates } from './utils/routeHelpers';
import { validateAndDecodePath, handleFileOperation, fileOperations, isPathInside } from './utils/fileHelpers';
// Import git route handlers
import { getBranches } from './git/branches';
import { postCheckout } from './git/checkout';
import { postCommit } from './git/commit';
import { getCommits } from './git/commits';
import { getDiff } from './git/diff';
import { postPush } from './git/push';
import { getRemote } from './git/remote';
import { getRemotes } from './git/remotes';
import { postStage } from './git/stage';
import { getStatus } from './git/status';
import { postUnstage } from './git/unstage';
import { getRevParse } from './git/revParse';
import { getSymbolicRef } from './git/symbolicRef';

// Import file route handlers
import { getFile } from './file/get';
import { writeFile } from './file/write';
import { getDbHealth } from './db/health';
import { closeSQLite, initializeSQLite } from './db/sqlite';

// Import Claude Code route handlers
import { createSession } from './claude/createSession';
import { resumeSession } from './claude/resumeSession';
import { createCodexSessionRoute } from './codex/createSession';
import { resumeCodexSessionRoute } from './codex/resumeSession';
import {
	handleClaudeSessionCreate,
	handleClaudeSessionResume,
	handleCodexSessionCreate,
	handleCodexSessionResume,
} from './utils/claudeCodeHelpers';

const PORT = 4444;
const HOST = process.env.SUPERCET_URL || 'https://supercet.com';
const isDebugMode = process.env.DEBUG === 'true';
const corsConfig = {
	origin: [HOST],
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization'],
	credentials: true,
};

/**
 * Interface for tracking authenticated socket connections with token expiration management.
 * This allows the server to automatically notify clients when their tokens are about to expire.
 */
interface AuthenticatedSocket {
	socketId: string;
	tokenExpiration: number;
	refreshTimeout: NodeJS.Timeout;
}

interface WorkspaceContext {
	id: string;
	rootPath: string;
	watcher: fs.FSWatcher | null;
	gitignorePatterns: string[];
	fileHashes: Map<string, string>;
	subscribers: Set<string>;
}

interface WorkspaceSummary {
	id: string;
	path: string;
	isWatching: boolean;
	isActive: boolean;
}

interface WorkspaceStatus {
	activeWorkspaceId: string | null;
	activeWorkspace: WorkspaceSummary | null;
	workspaces: WorkspaceSummary[];
}

interface DirectorySelectionResult {
	path: string | null;
	cancelled: boolean;
}

// Map to store authenticated socket information
const authenticatedSockets = new Map<string, AuthenticatedSocket>();

const workspacesById = new Map<string, WorkspaceContext>();
const workspaceIdByRootPath = new Map<string, string>();
const workspaceDebounceTimeouts = new Map<string, NodeJS.Timeout>();
const isBroadcastingGitUpdates = new Set<string>();
const DEBOUNCE_DELAY = 300; // Reduced from 1 second to 300ms for more responsive updates
// Shared workspace selection across all connected sockets on this host.
let activeWorkspaceId: string | null = null;

const app = new Hono();
const execFileAsync = promisify(execFile);

function normalizeCommandOutput(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (Buffer.isBuffer(value)) {
		return value.toString();
	}
	return '';
}

function listWorkspaceSummaries(): WorkspaceSummary[] {
	return Array.from(workspacesById.values()).map((workspace) => ({
		id: workspace.id,
		path: workspace.rootPath,
		isWatching: workspace.watcher !== null,
		isActive: workspace.id === activeWorkspaceId,
	}));
}

function buildWorkspaceStatus(): WorkspaceStatus {
	const workspaces = listWorkspaceSummaries();
	const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) || null;

	return {
		activeWorkspaceId,
		activeWorkspace,
		workspaces,
	};
}

function slugifyWorkspaceName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return slug || 'workspace';
}

function createWorkspaceId(rootPath: string): string {
	const baseName = path.basename(rootPath) || 'workspace';
	const baseId = slugifyWorkspaceName(baseName);

	if (!workspacesById.has(baseId)) {
		return baseId;
	}

	let attempt = 2;
	while (workspacesById.has(`${baseId}-${attempt}`)) {
		attempt++;
	}

	return `${baseId}-${attempt}`;
}

async function runCommand(
	command: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, { encoding: 'utf8' });
		return {
			stdout: stdout.trim(),
			stderr: stderr.trim(),
			exitCode: 0,
		};
	} catch (error) {
		const execError = error as ExecFileException & { stdout?: string | Buffer; stderr?: string | Buffer };
		if (execError.code === 'ENOENT') {
			throw error;
		}

		const stdout = normalizeCommandOutput(execError.stdout);
		const stderr = normalizeCommandOutput(execError.stderr);
		return {
			stdout: stdout.trim(),
			stderr: stderr.trim(),
			exitCode: typeof execError.code === 'number' ? execError.code : -1,
		};
	}
}

function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapePowerShellSingleQuoted(value: string): string {
	return value.replace(/'/g, "''");
}

function resolveExistingDirectoryForPicker(inputPath?: string): string | undefined {
	if (!inputPath || typeof inputPath !== 'string') {
		return undefined;
	}

	try {
		const resolvedPath = path.resolve(inputPath);
		if (!fs.statSync(resolvedPath).isDirectory()) {
			return undefined;
		}

		return fs.realpathSync(resolvedPath);
	} catch {
		return undefined;
	}
}

async function chooseDirectoryOnDarwin(startPath?: string): Promise<DirectorySelectionResult> {
	const defaultLocationClause = startPath
		? ` default location POSIX file "${escapeAppleScriptString(startPath)}"`
		: '';
	const script = [
		'try',
		`set selectedFolder to choose folder with prompt "Select a workspace folder"${defaultLocationClause}`,
		'return POSIX path of selectedFolder',
		'on error number -128',
		'return ""',
		'end try',
	].join('\n');

	const result = await runCommand('osascript', ['-e', script]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || 'Failed to open directory chooser');
	}

	if (!result.stdout) {
		return { path: null, cancelled: true };
	}

	return { path: result.stdout, cancelled: false };
}

async function chooseDirectoryOnWindows(startPath?: string): Promise<DirectorySelectionResult> {
	const selectedPathClause = startPath ? `$dialog.SelectedPath='${escapePowerShellSingleQuoted(startPath)}';` : '';
	const script = [
		'Add-Type -AssemblyName System.Windows.Forms;',
		'$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
		selectedPathClause,
		'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
		'Write-Output $dialog.SelectedPath',
		'}',
	].join(' ');

	const result = await runCommand('powershell', ['-NoProfile', '-Command', script]);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || 'Failed to open directory chooser');
	}

	if (!result.stdout) {
		return { path: null, cancelled: true };
	}

	return { path: result.stdout, cancelled: false };
}

async function chooseDirectoryOnLinux(startPath?: string): Promise<DirectorySelectionResult> {
	const zenityArgs = ['--file-selection', '--directory', '--title=Select workspace folder'];
	if (startPath) {
		const pathWithSeparator = startPath.endsWith(path.sep) ? startPath : `${startPath}${path.sep}`;
		zenityArgs.push(`--filename=${pathWithSeparator}`);
	}

	try {
		const result = await runCommand('zenity', zenityArgs);
		if (result.exitCode === 0 && result.stdout) {
			return { path: result.stdout, cancelled: false };
		}
		if (result.exitCode === 1) {
			return { path: null, cancelled: true };
		}
	} catch (error) {
		const errorCode = (error as NodeJS.ErrnoException).code;
		if (errorCode !== 'ENOENT') {
			throw error;
		}
	}

	try {
		const result = await runCommand('kdialog', [
			'--getexistingdirectory',
			startPath || os.homedir(),
			'--title',
			'Select workspace folder',
		]);
		if (result.exitCode === 0 && result.stdout) {
			return { path: result.stdout, cancelled: false };
		}
		if (result.exitCode === 1) {
			return { path: null, cancelled: true };
		}
	} catch (error) {
		const errorCode = (error as NodeJS.ErrnoException).code;
		if (errorCode !== 'ENOENT') {
			throw error;
		}
	}

	throw new Error('No supported directory chooser found (tried zenity and kdialog).');
}

async function chooseDirectory(startPath?: string): Promise<DirectorySelectionResult> {
	const normalizedStartPath = resolveExistingDirectoryForPicker(startPath);

	if (process.platform === 'darwin') {
		return chooseDirectoryOnDarwin(normalizedStartPath);
	}

	if (process.platform === 'win32') {
		return chooseDirectoryOnWindows(normalizedStartPath);
	}

	if (process.platform === 'linux') {
		return chooseDirectoryOnLinux(normalizedStartPath);
	}

	throw new Error(`Directory chooser is not supported on platform "${process.platform}".`);
}

function ensurePath(input?: string): string {
	const fallback = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
	const parts = new Set((input || '').split(':').filter(Boolean).concat(fallback));
	return Array.from(parts).join(':');
}

function pickShell(): string {
	const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean) as string[];
	return candidates.find((shell) => shell.startsWith('/') && fs.existsSync(shell)) || '/bin/sh';
}

function pickCwd(): string {
	const candidates = [process.cwd(), process.env.HOME, os.homedir?.(), '/tmp', '/'].filter(Boolean) as string[];
	for (const dir of candidates) {
		try {
			if (fs.statSync(dir).isDirectory()) return dir;
		} catch {}
	}
	return '/';
}

function buildEnv(): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')) as Record<
		string,
		string
	>;

	return {
		...env,
		PATH: ensurePath(env.PATH),
		HOME: env.HOME || os.homedir?.() || '/',
		SHELL: env.SHELL || '/bin/zsh',
		TERM: env.TERM || 'xterm-256color',
		LANG: env.LANG || 'en_US.UTF-8',
		LC_ALL: env.LC_ALL || 'en_US.UTF-8',
	};
}

function shellArgsFor(file: string): string[] {
	if (file.endsWith('/zsh')) return ['-i']; // interactive
	if (file.endsWith('/bash')) return ['--login']; // login
	if (file.endsWith('/sh')) return []; // minimal
	return []; // safe default
}

export function spawnLoginShell(cols = 80, rows = 24) {
	const file = pickShell();
	const cwd = pickCwd();
	const env = buildEnv();

	// Verify shell is executable
	fs.accessSync(file, fs.constants.X_OK);

	const p = pty.spawn(file, shellArgsFor(file), {
		name: 'xterm-256color',
		cols,
		rows,
		cwd,
		env,
	});
	return p;
}

// CORS middleware - allow requests from specified origins
app.use('*', cors(corsConfig));

// Authentication middleware
app.use('*', async (c, next) => {
	const authHeader = c.req.header('authorization');

	if (!authHeader) {
		return c.json({ error: 'Authorization header is required' }, 401);
	}

	// Extract token from Authorization header (supports "Bearer <token>" or just "<token>")
	const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;

	if (!token) {
		return c.json({ error: 'Invalid authorization header format' }, 401);
	}

	try {
		// Make request to Supercet API to validate token
		const response = await fetch(`${HOST}/api/conduit/token/validate`, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
		});

		if (response.status === 200) {
			// Token is valid, continue with the request
			await next();
		} else {
			// Token validation failed
			return c.json(response, response.status as ContentfulStatusCode);
		}
	} catch (error) {
		// Network error or other issues
		return c.json({ error }, 500);
	}
});

// Git routes
app.get('/api/git/branches', getBranches);
app.post('/api/git/checkout', postCheckout);
app.post('/api/git/commit', postCommit);
app.get('/api/git/commits', getCommits);
app.get('/api/git/diff', getDiff);
app.post('/api/git/push', postPush);
app.post('/api/git/stage', postStage);
app.get('/api/git/status', getStatus);
app.post('/api/git/unstage', postUnstage);
app.get('/api/git/remote', getRemote);
app.get('/api/git/remotes', getRemotes);
app.get('/api/git/rev-parse', getRevParse);
app.get('/api/git/symbolic-ref', getSymbolicRef);

// File routes
app.get('/api/file/get', getFile);
app.post('/api/file/write', writeFile);

// Claude Code session routes
app.post('/api/claude/session', createSession);
app.post('/api/claude/session/:sessionId/resume', resumeSession);
app.post('/api/codex/session', createCodexSessionRoute);
app.post('/api/codex/session/:sessionId/resume', resumeCodexSessionRoute);

// Heartbeat route
app.get('/api/heartbeat', (c) => {
	return c.json(null, 200);
});

// SQLite routes
app.get('/api/db/health', getDbHealth);

// Workspace routes
app.get('/api/workspaces', (c) => {
	const workspaces = listWorkspaceSummaries();
	return c.json({ success: true, data: workspaces }, 200);
});

app.get('/api/workspace/status', (c) => {
	return c.json({ success: true, data: buildWorkspaceStatus() }, 200);
});

app.get('/api/workspaces/active', (c) => {
	const activeWorkspaces = listWorkspaceSummaries().filter((workspace) => workspace.isActive);
	return c.json({ success: true, data: activeWorkspaces }, 200);
});

app.get('/api/workspaces/:workspaceId', (c) => {
	const workspaceId = c.req.param('workspaceId');
	const workspace = listWorkspaceSummaries().find((candidate) => candidate.id === workspaceId);
	if (!workspace) {
		return c.json({ success: false, error: 'Workspace not found' }, 404);
	}

	return c.json({ success: true, data: workspace }, 200);
});

// Start server
async function startServer() {
	// Check if port is already in use
	const portAvailable = await isPortAvailable(PORT);
	if (!portAvailable) {
		throw new Error(`Supercet is already running on port ${PORT}`);
	}

	const sqliteStatus = initializeSQLite();
	console.log(`🗄️  SQLite initialized at ${sqliteStatus.dbPath}`);

	// Create HTTP server using Hono's serve function
	const httpServer = serve({
		fetch: app.fetch,
		port: PORT,
	});
	const io = new SocketIOServer(httpServer as HTTPServer, {
		cors: corsConfig,
	});

	try {
		const initialWorkspace = registerWorkspace(process.cwd(), false);
		console.log(`📁 Initial workspace: ${initialWorkspace.rootPath} (${initialWorkspace.id})`);
	} catch (error) {
		console.warn(`⚠️  Failed to initialize initial workspace at ${process.cwd()}:`, error);
	}

	/**
	 * Schedules a token refresh notification to be sent 3 seconds before the token expires.
	 * @param socketId - The ID of the socket to send the refresh notification to
	 * @param expirationTime - The timestamp when the token expires
	 * @returns A timeout handle that can be used to cancel the scheduled refresh
	 */
	function scheduleTokenRefresh(socketId: string, expirationTime: number) {
		const now = Date.now();
		const timeUntilRefresh = expirationTime - now - 3000;

		const sendTokenRefresh = () => {
			const socket = io.sockets.sockets.get(socketId);
			if (socket) {
				socket.emit('token:refresh');

				// Set a 5-second expectation for re-authentication
				const authExpectationTimeout = setTimeout(() => {
					socket.disconnect(true);
				}, 5000);

				// Store the expectation timeout so it can be cleared if re-authentication occurs
				socket.data.authExpectationTimeout = authExpectationTimeout;
			}
			// Remove from authenticated sockets (safe to call even if key doesn't exist)
			authenticatedSockets.delete(socketId);
		};

		if (timeUntilRefresh <= 0) {
			// Token expires in less than 3 seconds, send refresh immediately
			sendTokenRefresh();
			return;
		}

		const timeout = setTimeout(() => sendTokenRefresh(), timeUntilRefresh);

		return timeout;
	}

	function emitWorkspaceStatusUpdate() {
		const payload = {
			success: true,
			data: buildWorkspaceStatus(),
		};

		for (const socketId of authenticatedSockets.keys()) {
			const connectedSocket = io.sockets.sockets.get(socketId);
			if (connectedSocket) {
				connectedSocket.emit('workspace:status:update', payload);
			}
		}
	}

	// Socket.IO event handlers
	io.on('connection', (socket) => {
		if (isDebugMode) {
			console.log(`🔌 WebSocket client connected: ${socket.id}`);

			// Add debug logging middleware for all socket events
			const originalOn = socket.on.bind(socket);
			const originalEmit = socket.emit.bind(socket);

			// Log incoming messages
			socket.on = function (event: string, listener: (...args: any[]) => void) {
				return originalOn(event, (...args: any[]) => {
					console.log(`📥 [${socket.id}] Received: ${event}`, args.length > 0 ? args : '');
					return listener(...args);
				});
			};

			// Log outgoing messages
			socket.emit = function (event: string, ...args: any[]) {
				console.log(`📤 [${socket.id}] Sent: ${event}`, args.length > 0 ? args : '');
				return originalEmit(event, ...args);
			};
		}

		const initialWorkspace = activeWorkspaceId ? workspacesById.get(activeWorkspaceId) || null : null;
		if (initialWorkspace) {
			subscribeSocketToWorkspace(socket, initialWorkspace);
		}

		function resolveWorkspaceOrEmitError(
			workspaceId: string | undefined,
			updateEvent: string,
		): WorkspaceContext | null {
			const workspace = resolveWorkspaceForSocket(socket, workspaceId);
			if (!workspace) {
				socket.emit(updateEvent, {
					success: false,
					error: 'Workspace is not initialized. Call workspace:init or workspace:select first.',
				});
				return null;
			}

			return workspace;
		}

		function ensureAuthenticated(updateEvent: string): boolean {
			if (authenticatedSockets.has(socket.id)) {
				return true;
			}

			socket.emit(updateEvent, {
				success: false,
				error: 'Authentication required',
			});
			return false;
		}

		// Handle client authentication
		socket.on('authenticate', (token: string) => {
			// Clear any existing auth expectation timeout
			if (socket.data.authExpectationTimeout) {
				clearTimeout(socket.data.authExpectationTimeout);
				socket.data.authExpectationTimeout = null;
			}

			// Validate token (you can reuse the same validation logic)
			fetch(`${HOST}/api/conduit/token/validate`, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
			})
				.then(async (response) => {
					if (response.status === 200) {
						// Parse the response to get token expiration
						const responseData = await response.json();
						let expirationTime: number = Date.now() + 60 * 1000; // Default to 1 minute

						// Try to extract expiration from various possible response formats
						if (responseData.expiresAt) {
							// Handle Unix timestamp in seconds (multiply by 1000) or ISO string
							const expiresAt = responseData.expiresAt;
							if (typeof expiresAt === 'number') {
								// Unix timestamp in seconds - convert to milliseconds
								expirationTime = expiresAt * 1000;
							}
						}

						// Clear any existing timeout for this socket
						const existingAuth = authenticatedSockets.get(socket.id);
						if (existingAuth?.refreshTimeout) {
							clearTimeout(existingAuth.refreshTimeout);
						}

						// Schedule token refresh
						const refreshTimeout = scheduleTokenRefresh(socket.id, expirationTime);

						// Store authenticated socket information
						authenticatedSockets.set(socket.id, {
							socketId: socket.id,
							tokenExpiration: expirationTime,
							refreshTimeout: refreshTimeout!,
						});

						socket.emit('authenticated', { success: true });
					} else {
						socket.emit('authenticated', {
							success: false,
							error: 'Invalid token',
						});
						console.log(`❌ WebSocket client authentication failed: invalid token`);
					}
				})
				.catch((error) => {
					console.error('Authentication failed:', error);
					socket.emit('authenticated', {
						success: false,
						error: 'Authentication failed',
					});
				});
		});

		// Initialize and select workspace
		socket.on('workspace:init', (params: { path: string }) => {
			if (!ensureAuthenticated('workspace:init:update')) {
				return;
			}

			try {
				const workspace = registerWorkspace(params?.path, true);
				subscribeSocketToWorkspace(socket, workspace);

				socket.emit('workspace:init:update', {
					success: true,
					workspaceId: workspace.id,
					path: workspace.rootPath,
					data: buildWorkspaceStatus(),
				});
				emitWorkspaceStatusUpdate();
			} catch (error) {
				socket.emit('workspace:init:update', {
					success: false,
					error: error instanceof Error ? error.message : 'Failed to initialize workspace',
				});
			}
		});

		socket.on('workspace:select', async (params: { startPath?: string } = {}) => {
			if (!ensureAuthenticated('workspace:select:update')) {
				return;
			}

			try {
				const selection = await chooseDirectory(params?.startPath);
				if (selection.cancelled || !selection.path) {
					socket.emit('workspace:select:update', {
						success: true,
						cancelled: true,
						data: buildWorkspaceStatus(),
					});
					return;
				}

				const workspace = registerWorkspace(selection.path, true);
				subscribeSocketToWorkspace(socket, workspace);

				socket.emit('workspace:select:update', {
					success: true,
					cancelled: false,
					workspaceId: workspace.id,
					path: workspace.rootPath,
					data: buildWorkspaceStatus(),
				});
				emitWorkspaceStatusUpdate();
			} catch (error) {
				socket.emit('workspace:select:update', {
					success: false,
					error: error instanceof Error ? error.message : 'Failed to select workspace',
				});
			}
		});

		socket.on('workspace:remove', (params: { workspaceId?: string } = {}) => {
			if (!ensureAuthenticated('workspace:remove:update')) {
				return;
			}

			if (!params?.workspaceId || typeof params.workspaceId !== 'string') {
				socket.emit('workspace:remove:update', {
					success: false,
					error: 'workspaceId is required',
				});
				return;
			}

			try {
				unregisterWorkspace(params.workspaceId);
				const fallbackWorkspace =
					(activeWorkspaceId && workspacesById.get(activeWorkspaceId)) ||
					Array.from(workspacesById.values())[0] ||
					null;

				for (const connectedSocket of io.sockets.sockets.values()) {
					if (connectedSocket.data.workspaceId !== params.workspaceId) {
						continue;
					}

					if (fallbackWorkspace) {
						subscribeSocketToWorkspace(connectedSocket, fallbackWorkspace);
						continue;
					}

					for (const workspace of workspacesById.values()) {
						workspace.subscribers.delete(connectedSocket.id);
					}
					connectedSocket.data.workspaceId = null;
				}

				socket.emit('workspace:remove:update', {
					success: true,
					workspaceId: params.workspaceId,
					data: buildWorkspaceStatus(),
				});
				emitWorkspaceStatusUpdate();
			} catch (error) {
				socket.emit('workspace:remove:update', {
					success: false,
					error: error instanceof Error ? error.message : 'Failed to remove workspace',
				});
			}
		});

		socket.on('workspace:status', () => {
			socket.emit('workspace:status:update', {
				success: true,
				data: buildWorkspaceStatus(),
			});
		});

		socket.on('workspace:activate', (params: { workspaceId?: string } = {}) => {
			if (!ensureAuthenticated('workspace:activate:update')) {
				return;
			}

			if (!params?.workspaceId || typeof params.workspaceId !== 'string') {
				socket.emit('workspace:activate:update', {
					success: false,
					error: 'workspaceId is required',
				});
				return;
			}

			const workspace = workspacesById.get(params.workspaceId);
			if (!workspace) {
				socket.emit('workspace:activate:update', {
					success: false,
					error: 'Workspace not found',
				});
				return;
			}

			subscribeSocketToWorkspace(socket, workspace);
			socket.emit('workspace:activate:update', {
				success: true,
				workspaceId: workspace.id,
				path: workspace.rootPath,
				data: buildWorkspaceStatus(),
			});
			emitWorkspaceStatusUpdate();
		});

		type WorkspaceParams = { workspaceId?: string };
		type WorkspaceGitOperation = ReturnType<typeof createGitOperations>;

		async function executeWorkspaceGitOperation(
			params: WorkspaceParams | undefined,
			updateEvent: string,
			operationName: string,
			operation: (gitOperations: WorkspaceGitOperation) => Promise<unknown>,
			onSuccess?: (workspace: WorkspaceContext) => void,
		): Promise<void> {
			const workspace = resolveWorkspaceOrEmitError(params?.workspaceId, updateEvent);
			if (!workspace) {
				return;
			}

			const workspaceGitOperations = createGitOperations(workspace.rootPath);
			const result = await handleSocketGitOperation(() => operation(workspaceGitOperations), operationName);
			if (result.success) {
				onSuccess?.(workspace);
			}

			socket.emit(updateEvent, { workspaceId: workspace.id, ...result });
		}

		// Handle git status updates
		socket.on('git:status', async (params: WorkspaceParams = {}) => {
			await executeWorkspaceGitOperation(params, 'git:status:update', 'get git status', (gitOperations) =>
				gitOperations.status(),
			);
		});

		// Handle git branches
		socket.on('git:branches', async (params: WorkspaceParams = {}) => {
			await executeWorkspaceGitOperation(params, 'git:branches:update', 'get git branches', (gitOperations) =>
				gitOperations.branches(),
			);
		});

		// Handle git commits
		socket.on(
			'git:commits',
			async (params: { branch?: string; from?: string; to?: string; workspaceId?: string }) => {
				await executeWorkspaceGitOperation(params, 'git:commits:update', 'get git commits', (gitOperations) =>
					gitOperations.commits(params?.branch, params?.from, params?.to),
				);
			},
		);

		// Handle git diff
		socket.on('git:diff', async (params: { from?: string; to?: string; workspaceId?: string }) => {
			await executeWorkspaceGitOperation(params, 'git:diff:update', 'get git diff', (gitOperations) =>
				gitOperations.diff(params?.from, params?.to),
			);
		});

		// Handle git remotes
		socket.on('git:remotes', async (params: WorkspaceParams = {}) => {
			await executeWorkspaceGitOperation(params, 'git:remotes:update', 'get git remotes', (gitOperations) =>
				gitOperations.remotes(),
			);
		});

		// Handle git remote
		socket.on('git:remote', async (params: { remote: string; workspaceId?: string }) => {
			if (!params?.remote) {
				socket.emit('git:remote:update', {
					success: false,
					error: 'Remote name is required',
				});
				return;
			}

			await executeWorkspaceGitOperation(params, 'git:remote:update', 'get git remote', (gitOperations) =>
				gitOperations.remote(params.remote),
			);
		});

		// Handle git stage
		socket.on(
			'git:stage',
			async (params: { files: string[]; areFilesUntracked: boolean; workspaceId?: string }) => {
				if (!params?.files?.length) {
					socket.emit('git:stage:update', {
						success: false,
						error: 'Files array is required',
					});
					return;
				}

				await executeWorkspaceGitOperation(
					params,
					'git:stage:update',
					'stage git files',
					(gitOperations) => gitOperations.stage([...params.files], params.areFilesUntracked),
					(workspace) => invalidateFileHashCache(workspace, params.files),
				);
			},
		);

		// Handle git unstage
		socket.on('git:unstage', async (params: { files: string[]; workspaceId?: string }) => {
			if (!params?.files?.length) {
				socket.emit('git:unstage:update', {
					success: false,
					error: 'Files array is required',
				});
				return;
			}

			await executeWorkspaceGitOperation(
				params,
				'git:unstage:update',
				'unstage git files',
				(gitOperations) => gitOperations.unstage(params.files),
				(workspace) => invalidateFileHashCache(workspace, params.files),
			);
		});

		// Handle git commit
		socket.on('git:commit', async (params: { message: string; workspaceId?: string }) => {
			if (!params?.message) {
				socket.emit('git:commit:update', {
					success: false,
					error: 'Commit message is required',
				});
				return;
			}

			await executeWorkspaceGitOperation(
				params,
				'git:commit:update',
				'commit git changes',
				(gitOperations) => gitOperations.commit(params.message),
				(workspace) => invalidateFileHashCache(workspace),
			);
		});

		// Handle git push
		socket.on('git:push', async (params: { remote: string; branch: string; workspaceId?: string }) => {
			if (!params?.remote || !params?.branch) {
				socket.emit('git:push:update', {
					success: false,
					error: 'Remote and branch are required',
				});
				return;
			}

			await executeWorkspaceGitOperation(params, 'git:push:update', 'push git changes', (gitOperations) =>
				gitOperations.push(params.remote, params.branch),
			);
		});

		// Handle git checkout
		socket.on('git:checkout', async (params: { target: string; isFile?: boolean; workspaceId?: string }) => {
			if (!params?.target) {
				socket.emit('git:checkout:update', {
					success: false,
					error: 'Target is required',
				});
				return;
			}

			await executeWorkspaceGitOperation(
				params,
				'git:checkout:update',
				'checkout git branch',
				(gitOperations) => gitOperations.checkout(params.target, params.isFile || false),
				(workspace) => {
					if (params.isFile) {
						invalidateFileHashCache(workspace, [params.target]);
						return;
					}

					invalidateFileHashCache(workspace);
				},
			);
		});

		// Handle git revParse
		socket.on('git:rev-parse', async (params: { ref: string; remote?: string; workspaceId?: string }) => {
			if (!params?.ref) {
				socket.emit('git:rev-parse:update', {
					success: false,
					error: 'Ref is required',
				});
				return;
			}

			await executeWorkspaceGitOperation(params, 'git:rev-parse:update', 'rev parse git ref', (gitOperations) =>
				gitOperations.revParse(params.ref, params.remote),
			);
		});

		// Handle git symbolicRef
		socket.on('git:symbolic-ref', async (params: { remote: string; ref?: string; workspaceId?: string }) => {
			if (!params?.remote) {
				socket.emit('git:symbolic-ref:update', {
					success: false,
					error: 'Remote is required',
				});
				return;
			}

			await executeWorkspaceGitOperation(
				params,
				'git:symbolic-ref:update',
				'symbolic ref git remote',
				(gitOperations) => gitOperations.symbolicRef(params.remote, params.ref),
			);
		});

		// Handle file:get
		socket.on('file:get', async (params: { path: string; workspaceId?: string }) => {
			const workspace = resolveWorkspaceOrEmitError(params?.workspaceId, 'file:get:update');
			if (!workspace) {
				return;
			}

			const pathValidation = validateAndDecodePath(params?.path, workspace.rootPath);
			if (!pathValidation.isValid) {
				socket.emit('file:get:update', {
					success: false,
					error: pathValidation.error,
					workspaceId: workspace.id,
				});
				return;
			}

			const result = await handleFileOperation(
				() => fileOperations.readFile(params.path, pathValidation.path!),
				'file:get socket',
			);

			socket.emit('file:get:update', { workspaceId: workspace.id, ...result });
		});

		// Handle file:write
		socket.on('file:write', async (params: { path: string; content: string; workspaceId?: string }) => {
			const workspace = resolveWorkspaceOrEmitError(params?.workspaceId, 'file:write:update');
			if (!workspace) {
				return;
			}

			const pathValidation = validateAndDecodePath(params?.path, workspace.rootPath);
			if (!pathValidation.isValid) {
				socket.emit('file:write:update', {
					success: false,
					error: pathValidation.error,
					workspaceId: workspace.id,
				});
				return;
			}

			const result = await handleFileOperation(
				() => fileOperations.writeFile(params.path, pathValidation.path!, params.content),
				'file:write socket',
			);

			socket.emit('file:write:update', { workspaceId: workspace.id, ...result });
		});

		// Handle Claude Code session creation and resumption
		handleClaudeSessionCreate(socket, () => resolveWorkspaceForSocket(socket)?.rootPath || process.cwd());
		handleClaudeSessionResume(socket, () => resolveWorkspaceForSocket(socket)?.rootPath || process.cwd());
		handleCodexSessionCreate(socket, () => resolveWorkspaceForSocket(socket)?.rootPath || process.cwd());
		handleCodexSessionResume(socket, () => resolveWorkspaceForSocket(socket)?.rootPath || process.cwd());

		let ptyProcess: ReturnType<typeof spawnLoginShell> | null = null;

		// Handle terminal initialization
		socket.on('terminal:init', ({ cols = 80, rows = 24 }: { cols?: number; rows?: number } = {}) => {
			// Allow reinitializing after termination by removing the existing check
			if (ptyProcess) {
				// Clean up existing terminal first
				try {
					ptyProcess.kill();
					ptyProcess = null;
				} catch (error) {
					console.error('Error cleaning up existing terminal during reinit:', error);
				}
			}

			try {
				ptyProcess = spawnLoginShell(cols, rows);

				// Server -> Client: stream data
				ptyProcess.onData((data) => {
					socket.emit('terminal:data', data);
				});

				socket.emit('terminal:init:update', {
					success: true,
					message: 'Terminal initialized successfully',
				});
			} catch (error) {
				socket.emit('terminal:init:update', {
					success: false,
					error: `Failed to initialize terminal: ${error}`,
				});
			}
		});

		// Handle terminal termination
		socket.on('terminal:terminate', () => {
			if (!ptyProcess) {
				socket.emit('terminal:terminate:update', {
					success: false,
					error: 'No terminal to terminate',
				});
				return;
			}

			try {
				ptyProcess.kill();
				ptyProcess = null;

				socket.emit('terminal:terminate:update', {
					success: true,
					message: 'Terminal terminated successfully',
				});
			} catch (error) {
				socket.emit('terminal:terminate:update', {
					success: false,
					error: `Failed to terminate terminal: ${error}`,
				});
			}
		});

		// Client -> Server: user input
		socket.on('terminal:input', (data: string) => {
			if (!ptyProcess) {
				socket.emit('terminal:input:update', {
					success: false,
					error: 'No terminal available. Please initialize a terminal first.',
				});
				return;
			}
			ptyProcess.write(data);
		});

		// Resize from client
		socket.on('terminal:resize', ({ cols, rows }: { cols: number; rows: number }) => {
			if (!ptyProcess) {
				socket.emit('terminal:resize:update', {
					success: false,
					error: 'No terminal available. Please initialize a terminal first.',
				});
				return;
			}
			if (!cols || !rows) {
				socket.emit('terminal:resize:update', {
					success: false,
					error: 'Invalid dimensions. Both cols and rows must be provided.',
				});
				return;
			}
			ptyProcess.resize(cols, rows);
			socket.emit('terminal:resize:update', {
				success: true,
				message: `Terminal resized to ${cols}x${rows}`,
			});
		});

		// Handle disconnect
		socket.on('disconnect', () => {
			if (isDebugMode) {
				console.log(`WebSocket client disconnected: ${socket.id}`);
			}

			// Clean up terminal if active
			if (ptyProcess) {
				try {
					ptyProcess.kill();
					ptyProcess = null;
				} catch (error) {
					console.error('Error cleaning up terminal on disconnect:', error);
				}
			}

			// Clean up authenticated socket tracking
			const existingAuth = authenticatedSockets.get(socket.id);
			if (existingAuth?.refreshTimeout) {
				clearTimeout(existingAuth.refreshTimeout);
			}
			authenticatedSockets.delete(socket.id);

			// Clean up auth expectation timeout
			if (socket.data.authExpectationTimeout) {
				clearTimeout(socket.data.authExpectationTimeout);
				socket.data.authExpectationTimeout = null;
			}

			for (const workspace of workspacesById.values()) {
				workspace.subscribers.delete(socket.id);
			}
		});
	});

	// Workspace and file watcher functionality
	function normalizeWorkspacePath(inputPath: string): string {
		if (!inputPath || typeof inputPath !== 'string') {
			throw new Error('Workspace path is required and must be a string');
		}

		const resolvedPath = path.resolve(inputPath);
		const stats = fs.statSync(resolvedPath);
		if (!stats.isDirectory()) {
			throw new Error('Workspace path must be a valid directory');
		}

		return fs.realpathSync(resolvedPath);
	}

	function isGitRepository(dir: string): boolean {
		try {
			const gitDir = path.join(dir, '.git');
			return fs.existsSync(gitDir) && (fs.statSync(gitDir).isDirectory() || fs.statSync(gitDir).isFile());
		} catch {
			return false;
		}
	}

	function parseGitignore(dir: string): string[] | null {
		const gitignorePath = path.join(dir, '.gitignore');
		const patterns: string[] = [];

		try {
			if (!fs.existsSync(gitignorePath)) {
				console.warn(`⚠️  Warning: No .gitignore file found in ${dir}. Skipping file watcher.`);
				return null;
			}

			const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
			const lines = gitignoreContent.split('\n');

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed && !trimmed.startsWith('#')) {
					patterns.push(trimmed);
				}
			}
		} catch (error) {
			console.warn(`Failed reading .gitignore in ${dir}:`, error);
			return null;
		}

		return patterns;
	}

	function shouldIgnoreFile(filename: string, patterns: string[]): boolean {
		for (const pattern of patterns) {
			if (pattern.endsWith('/')) {
				if (filename.includes(pattern)) {
					return true;
				}
			} else if (pattern.includes('*')) {
				const regex = new RegExp(pattern.replace(/\*/g, '.*'));
				if (regex.test(path.basename(filename))) {
					return true;
				}
			} else if (filename.includes(pattern)) {
				return true;
			}
		}
		return false;
	}

	function getFileHash(filePath: string): string | null {
		try {
			const content = fs.readFileSync(filePath);
			return crypto.createHash('md5').update(content).digest('hex');
		} catch {
			return null;
		}
	}

	function hasFileChanged(workspace: WorkspaceContext, filePath: string): boolean {
		const newHash = getFileHash(filePath);
		const oldHash = workspace.fileHashes.get(filePath);

		if (newHash === null) {
			if (oldHash !== undefined) {
				workspace.fileHashes.delete(filePath);
				return true;
			}
			return false;
		}

		if (oldHash !== newHash) {
			workspace.fileHashes.set(filePath, newHash);
			return true;
		}

		return false;
	}

	function initializeFileHashCache(workspace: WorkspaceContext) {
		try {
			function walkDir(dir: string) {
				const files = fs.readdirSync(dir);
				for (const file of files) {
					const fullPath = path.join(dir, file);
					let stat: fs.Stats;
					try {
						stat = fs.statSync(fullPath);
					} catch {
						continue;
					}

					if (stat.isDirectory() && !file.startsWith('.')) {
						walkDir(fullPath);
					} else if (stat.isFile()) {
						const relativePath = path.relative(workspace.rootPath, fullPath).replace(/\\/g, '/');
						if (shouldIgnoreFile(relativePath, workspace.gitignorePatterns)) {
							continue;
						}

						const hash = getFileHash(fullPath);
						if (hash) {
							workspace.fileHashes.set(fullPath, hash);
						}
					}
				}
			}

			walkDir(workspace.rootPath);
		} catch (error) {
			console.error(`Failed to initialize file hash cache for ${workspace.rootPath}:`, error);
		}
	}

	function invalidateFileHashCache(workspace: WorkspaceContext, specificFiles?: string[]) {
		if (specificFiles && specificFiles.length > 0) {
			for (const file of specificFiles) {
				const resolvedPath = path.isAbsolute(file)
					? path.resolve(file)
					: path.resolve(workspace.rootPath, file);
				if (isPathInside(workspace.rootPath, resolvedPath)) {
					workspace.fileHashes.delete(resolvedPath);
				}
			}
			return;
		}

		workspace.fileHashes.clear();
	}

	function resolveWorkspaceForSocket(socket: Socket, workspaceId?: string): WorkspaceContext | null {
		if (workspaceId) {
			const explicitWorkspace = workspacesById.get(workspaceId);
			if (!explicitWorkspace) {
				return null;
			}
			if (!explicitWorkspace.subscribers.has(socket.id)) {
				return null;
			}
			return explicitWorkspace;
		}

		const targetWorkspaceId = socket.data.workspaceId || activeWorkspaceId;
		if (!targetWorkspaceId) {
			return null;
		}

		return workspacesById.get(targetWorkspaceId) || null;
	}

	function registerWorkspace(inputPath: string, requireGitRepo: boolean = true): WorkspaceContext {
		const normalizedPath = normalizeWorkspacePath(inputPath);
		const existingWorkspaceId = workspaceIdByRootPath.get(normalizedPath);
		if (existingWorkspaceId) {
			const existingWorkspace = workspacesById.get(existingWorkspaceId);
			if (existingWorkspace) {
				if (!existingWorkspace.watcher) {
					setupWorkspaceWatcher(existingWorkspace);
				}
				return existingWorkspace;
			}
		}

		if (requireGitRepo && !isGitRepository(normalizedPath)) {
			throw new Error('Workspace must be a git repository. Run `git init` in that directory first.');
		}

		const workspace: WorkspaceContext = {
			id: createWorkspaceId(normalizedPath),
			rootPath: normalizedPath,
			watcher: null,
			gitignorePatterns: [],
			fileHashes: new Map<string, string>(),
			subscribers: new Set<string>(),
		};

		workspacesById.set(workspace.id, workspace);
		workspaceIdByRootPath.set(normalizedPath, workspace.id);

		if (!activeWorkspaceId) {
			activeWorkspaceId = workspace.id;
		}

		setupWorkspaceWatcher(workspace);

		return workspace;
	}

	function unregisterWorkspace(workspaceId: string): WorkspaceContext {
		const workspace = workspacesById.get(workspaceId);
		if (!workspace) {
			throw new Error('Workspace not found');
		}

		const debounceTimeout = workspaceDebounceTimeouts.get(workspaceId);
		if (debounceTimeout) {
			clearTimeout(debounceTimeout);
			workspaceDebounceTimeouts.delete(workspaceId);
		}
		isBroadcastingGitUpdates.delete(workspaceId);

		if (workspace.watcher) {
			workspace.watcher.close();
			workspace.watcher = null;
		}

		workspace.fileHashes.clear();
		workspace.subscribers.clear();

		workspacesById.delete(workspaceId);
		workspaceIdByRootPath.delete(workspace.rootPath);
		releaseGitClient(workspace.rootPath);

		const firstRemainingWorkspace = Array.from(workspacesById.values())[0] || null;
		if (activeWorkspaceId === workspaceId) {
			activeWorkspaceId = firstRemainingWorkspace ? firstRemainingWorkspace.id : null;
		}

		return workspace;
	}

	function subscribeSocketToWorkspace(socket: Socket, workspace: WorkspaceContext) {
		for (const candidateWorkspace of workspacesById.values()) {
			candidateWorkspace.subscribers.delete(socket.id);
		}
		workspace.subscribers.add(socket.id);
		socket.data.workspaceId = workspace.id;
		activeWorkspaceId = workspace.id;
	}

	function broadcastGitUpdates(workspaceId: string) {
		if (isBroadcastingGitUpdates.has(workspaceId)) {
			return;
		}

		const existingTimeout = workspaceDebounceTimeouts.get(workspaceId);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		const timeout = setTimeout(async () => {
			if (isBroadcastingGitUpdates.has(workspaceId)) {
				return;
			}

			const workspace = workspacesById.get(workspaceId);
			if (!workspace) {
				return;
			}

			isBroadcastingGitUpdates.add(workspaceId);
			try {
				const workspaceGitOperations = createGitOperations(workspace.rootPath);
				const statusResult = await handleSocketGitOperation(workspaceGitOperations.status, 'get git status');
				const diffResult = await handleSocketGitOperation(() => workspaceGitOperations.diff(), 'get git diff');

				for (const socketId of workspace.subscribers) {
					if (!authenticatedSockets.has(socketId)) {
						continue;
					}

					const socket = io.sockets.sockets.get(socketId);
					if (socket) {
						socket.emit('git:status:push', { workspaceId: workspace.id, ...statusResult });
						socket.emit('git:diff:push', { workspaceId: workspace.id, ...diffResult });
					}
				}
			} catch (error) {
				console.error(`Error broadcasting git updates for workspace ${workspaceId}:`, error);
			} finally {
				isBroadcastingGitUpdates.delete(workspaceId);
			}
		}, DEBOUNCE_DELAY);

		workspaceDebounceTimeouts.set(workspaceId, timeout);
	}

	function setupWorkspaceWatcher(workspace: WorkspaceContext) {
		try {
			if (!isGitRepository(workspace.rootPath)) {
				console.warn(`⚠️  Warning: ${workspace.rootPath} is not a git repository. Skipping file watcher.`);
				return;
			}

			const parsedPatterns = parseGitignore(workspace.rootPath);
			if (parsedPatterns === null) {
				return;
			}

			workspace.gitignorePatterns = parsedPatterns;
			workspace.fileHashes.clear();
			initializeFileHashCache(workspace);

			if (workspace.watcher) {
				workspace.watcher.close();
			}

			workspace.watcher = fs.watch(workspace.rootPath, { recursive: true }, (eventType, filename) => {
				if (!filename) return;

				const normalizedFilename = String(filename).replace(/\\/g, '/');
				if (
					normalizedFilename.includes('node-pty-spawn-helper-') ||
					normalizedFilename.includes('.tmp') ||
					normalizedFilename.includes('/tmp/')
				) {
					return;
				}

				if (shouldIgnoreFile(normalizedFilename, workspace.gitignorePatterns)) {
					return;
				}

				const fullPath = path.join(workspace.rootPath, normalizedFilename);
				if (eventType === 'change') {
					setTimeout(() => {
						if (hasFileChanged(workspace, fullPath)) {
							broadcastGitUpdates(workspace.id);
						}
					}, 50);
				} else if (hasFileChanged(workspace, fullPath)) {
					broadcastGitUpdates(workspace.id);
				}
			});

			console.log(`\n📂 Watching for file changes in workspace ${workspace.id}: ${workspace.rootPath}\n`);
		} catch (error) {
			console.error(`Failed to setup file watcher for ${workspace.rootPath}:`, error);
		}
	}

	console.log(`Supercet version ${process.env.SUPERCET_VERSION} is running on http://localhost:${PORT}`);

	// Check for updates
	await checkForUpdates();
	console.log(`\n⮕ Review your local code changes at \x1b[34m${HOST}/conduit\x1b[0m`);
}

function cleanupWorkspaces() {
	for (const timeout of workspaceDebounceTimeouts.values()) {
		clearTimeout(timeout);
	}
	workspaceDebounceTimeouts.clear();

	for (const workspace of workspacesById.values()) {
		if (workspace.watcher) {
			workspace.watcher.close();
			workspace.watcher = null;
		}
		workspace.fileHashes.clear();
		workspace.subscribers.clear();
		releaseGitClient(workspace.rootPath);
	}

	workspacesById.clear();
	workspaceIdByRootPath.clear();
	isBroadcastingGitUpdates.clear();
	activeWorkspaceId = null;
	closeSQLite();
}

// Cleanup workspace watchers on process exit
process.on('SIGINT', () => {
	cleanupWorkspaces();
	process.exit(0);
});

process.on('SIGTERM', () => {
	cleanupWorkspaces();
	process.exit(0);
});

// Start the server
startServer().catch((error) => {
	console.error('❌ Failed to start server:', error.message);
	process.exit(1);
});
