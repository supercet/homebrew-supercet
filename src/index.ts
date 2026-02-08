import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'node:http';
import pty from 'node-pty';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import 'dotenv/config';
import { handleSocketGitOperation, gitOperations } from './utils/gitHelpers';
import { isPortAvailable, checkForUpdates } from './utils/routeHelpers';
import { validateAndDecodePath, handleFileOperation, fileOperations } from './utils/fileHelpers';
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

// Map to store authenticated socket information
const authenticatedSockets = new Map<string, AuthenticatedSocket>();

// File watcher state
let fileWatcher: fs.FSWatcher | null = null;
let debounceTimeout: NodeJS.Timeout | null = null;
const DEBOUNCE_DELAY = 300; // Reduced from 1 second to 300ms for more responsive updates
let isBroadcastingGitUpdates = false; // Prevent recursive broadcasts
let gitignorePatterns: string[] = [];
const fileHashes = new Map<string, string>(); // Track file content hashes

const app = new Hono();

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

// Start server
async function startServer() {
	// Check if port is already in use
	const portAvailable = await isPortAvailable(PORT);
	if (!portAvailable) {
		throw new Error(`Supercet is already running on port ${PORT}`);
	}

	// Create HTTP server using Hono's serve function
	const httpServer = serve({
		fetch: app.fetch,
		port: PORT,
	});
	const io = new SocketIOServer(httpServer as HTTPServer, {
		cors: corsConfig,
	});

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

		// Handle git status updates
		socket.on('git:status', async () => {
			const result = await handleSocketGitOperation(gitOperations.status, 'get git status');
			socket.emit('git:status:update', result);
		});

		// Handle git branches
		socket.on('git:branches', async () => {
			const result = await handleSocketGitOperation(gitOperations.branches, 'get git branches');
			socket.emit('git:branches:update', result);
		});

		// Handle git commits
		socket.on('git:commits', async (params: { branch?: string; from?: string; to?: string }) => {
			const result = await handleSocketGitOperation(
				() => gitOperations.commits(params.branch, params.from, params.to),
				'get git commits',
			);
			socket.emit('git:commits:update', result);
		});

		// Handle git diff
		socket.on('git:diff', async (params: { from?: string; to?: string }) => {
			const result = await handleSocketGitOperation(
				() => gitOperations.diff(params.from, params.to),
				'get git diff',
			);
			socket.emit('git:diff:update', result);
		});

		// Handle git remotes
		socket.on('git:remotes', async () => {
			const result = await handleSocketGitOperation(gitOperations.remotes, 'get git remotes');
			socket.emit('git:remotes:update', result);
		});

		// Handle git remote
		socket.on('git:remote', async (params: { remote: string }) => {
			if (!params?.remote) {
				socket.emit('git:remote:update', {
					success: false,
					error: 'Remote name is required',
				});
				return;
			}

			const result = await handleSocketGitOperation(() => gitOperations.remote(params.remote), 'get git remote');
			socket.emit('git:remote:update', result);
		});

		// Handle git stage
		socket.on('git:stage', async (params: { files: string[]; areFilesUntracked: boolean }) => {
			if (!params?.files?.length) {
				socket.emit('git:stage:update', {
					success: false,
					error: 'Files array is required',
				});
				return;
			}

			const result = await handleSocketGitOperation(
				() => gitOperations.stage(params.files, params.areFilesUntracked),
				'stage git files',
			);

			// Invalidate cache for staged files
			if (result.success) {
				invalidateFileHashCache(params.files);
			}

			socket.emit('git:stage:update', result);
		});

		// Handle git unstage
		socket.on('git:unstage', async (params: { files: string[] }) => {
			if (!params?.files?.length) {
				socket.emit('git:unstage:update', {
					success: false,
					error: 'Files array is required',
				});
				return;
			}

			const result = await handleSocketGitOperation(
				() => gitOperations.unstage(params.files),
				'unstage git files',
			);

			// Invalidate cache for unstaged files
			if (result.success) {
				invalidateFileHashCache(params.files);
			}

			socket.emit('git:unstage:update', result);
		});

		// Handle git commit
		socket.on('git:commit', async (params: { message: string }) => {
			if (!params?.message) {
				socket.emit('git:commit:update', {
					success: false,
					error: 'Commit message is required',
				});
				return;
			}

			const result = await handleSocketGitOperation(
				() => gitOperations.commit(params.message),
				'commit git changes',
			);

			// Clear entire cache after commit since it affects staged files
			if (result.success) {
				invalidateFileHashCache();
			}

			socket.emit('git:commit:update', result);
		});

		// Handle git push
		socket.on('git:push', async (params: { remote: string; branch: string }) => {
			if (!params?.remote || !params?.branch) {
				socket.emit('git:push:update', {
					success: false,
					error: 'Remote and branch are required',
				});
				return;
			}
			const result = await handleSocketGitOperation(
				() => gitOperations.push(params.remote, params.branch),
				'push git changes',
			);
			socket.emit('git:push:update', result);
		});

		// Handle git checkout
		socket.on('git:checkout', async (params: { target: string; isFile?: boolean }) => {
			if (!params?.target) {
				socket.emit('git:checkout:update', {
					success: false,
					error: 'Target is required',
				});
				return;
			}

			const result = await handleSocketGitOperation(
				() => gitOperations.checkout(params.target, params.isFile || false),
				'checkout git branch',
			);

			// Clear cache after checkout since it can change many files
			if (result.success) {
				if (params.isFile) {
					// For file checkout, only invalidate that specific file
					invalidateFileHashCache([params.target]);
				} else {
					// For branch checkout, clear entire cache
					invalidateFileHashCache();
				}
			}

			socket.emit('git:checkout:update', result);
		});

		// Handle git revParse
		socket.on('git:rev-parse', async (params: { ref: string; remote?: string }) => {
			const result = await handleSocketGitOperation(
				() => gitOperations.revParse(params.ref, params.remote),
				'rev parse git ref',
			);
			socket.emit('git:rev-parse:update', result);
		});

		// Handle git symbolicRef
		socket.on('git:symbolic-ref', async (params: { remote: string; ref?: string }) => {
			const result = await handleSocketGitOperation(
				() => gitOperations.symbolicRef(params.remote, params.ref),
				'symbolic ref git remote',
			);
			socket.emit('git:symbolic-ref:update', result);
		});

		// Handle file:get
		socket.on('file:get', async (params: { path: string }) => {
			// Validate and decode path
			const pathValidation = validateAndDecodePath(params?.path);
			if (!pathValidation.isValid) {
				socket.emit('file:get:update', {
					success: false,
					error: pathValidation.error,
				});
				return;
			}

			// Perform file read operation
			const result = await handleFileOperation(
				() => fileOperations.readFile(params.path, pathValidation.path!),
				'file:get socket',
			);

			socket.emit('file:get:update', result);
		});

		// Handle file:write
		socket.on('file:write', async (params: { path: string; content: string }) => {
			// Validate and decode path
			const pathValidation = validateAndDecodePath(params?.path);
			if (!pathValidation.isValid) {
				socket.emit('file:write:update', {
					success: false,
					error: pathValidation.error,
				});
				return;
			}

			// Perform file write operation
			const result = await handleFileOperation(
				() => fileOperations.writeFile(params.path, pathValidation.path!, params.content),
				'file:write socket',
			);

			socket.emit('file:write:update', result);
		});

		// Handle Claude Code session creation and resumption
		handleClaudeSessionCreate(socket, process.cwd());
		handleClaudeSessionResume(socket, process.cwd());
		handleCodexSessionCreate(socket, process.cwd());
		handleCodexSessionResume(socket, process.cwd());

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
		});
	});

	// File watcher functionality
	function broadcastGitUpdates() {
		if (isBroadcastingGitUpdates) {
			// Already broadcasting git updates, skipping to prevent infinite loop
			return;
		}

		if (debounceTimeout) {
			clearTimeout(debounceTimeout);
		}

		debounceTimeout = setTimeout(async () => {
			if (isBroadcastingGitUpdates) {
				// Broadcast already in progress, skipping
				return;
			}

			isBroadcastingGitUpdates = true;

			try {
				const authenticatedCount = authenticatedSockets.size;

				// Get git status and diff for all authenticated clients
				const statusResult = await handleSocketGitOperation(gitOperations.status, 'get git status');
				const diffResult = await handleSocketGitOperation(() => gitOperations.diff(), 'get git diff');

				// Broadcast to all authenticated sockets
				for (const [socketId] of authenticatedSockets) {
					const socket = io.sockets.sockets.get(socketId);
					if (socket) {
						socket.emit('git:status:push', statusResult);
						socket.emit('git:diff:push', diffResult);
					}
				}
			} catch (error) {
				console.error('Error broadcasting git updates:', error);
			} finally {
				isBroadcastingGitUpdates = false;
			}
		}, DEBOUNCE_DELAY);
	}

	function isGitRepository(dir: string): boolean {
		try {
			const gitDir = path.join(dir, '.git');
			return fs.existsSync(gitDir) && (fs.statSync(gitDir).isDirectory() || fs.statSync(gitDir).isFile());
		} catch {
			console.warn('⚠️  Warning: Current directory is not a git repository');
			console.warn('Initialize git with: git init');
			return false;
		}
	}

	function parseGitignore(dir: string): string[] | null {
		const gitignorePath = path.join(dir, '.gitignore');
		const patterns: string[] = [];

		try {
			if (!fs.existsSync(gitignorePath)) {
				console.warn('⚠️  Warning: No .gitignore file found. Please create one to enable file watching.');
				return null; // No .gitignore file found
			}

			const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
			const lines = gitignoreContent.split('\n');

			for (const line of lines) {
				const trimmed = line.trim();
				// Skip empty lines and comments
				if (trimmed && !trimmed.startsWith('#')) {
					patterns.push(trimmed);
				}
			}
		} catch (error) {
			console.warn('Failed reading .gitignore:', error);
			return null;
		}

		return patterns;
	}

	function shouldIgnoreFile(filename: string): boolean {
		for (const pattern of gitignorePatterns) {
			// Handle directory patterns (ending with /)
			if (pattern.endsWith('/')) {
				if (filename.includes(pattern)) {
					return true;
				}
			}
			// Handle exact matches and wildcard patterns
			else if (pattern.includes('*')) {
				// Simple glob matching for * wildcard
				const regex = new RegExp(pattern.replace(/\*/g, '.*'));
				if (regex.test(path.basename(filename))) {
					return true;
				}
			}
			// Handle exact filename matches
			else if (filename.includes(pattern)) {
				return true;
			}
		}
		return false;
	}

	function getFileHash(filePath: string): string | null {
		try {
			const content = fs.readFileSync(filePath);
			return crypto.createHash('md5').update(content).digest('hex');
		} catch (error) {
			// File might have been deleted or is temporarily inaccessible
			return null;
		}
	}

	function hasFileChanged(filePath: string): boolean {
		// filePath is already the full absolute path from the file watcher
		const newHash = getFileHash(filePath);
		const oldHash = fileHashes.get(filePath);

		// If file was deleted, consider it changed
		if (newHash === null) {
			if (oldHash !== undefined) {
				fileHashes.delete(filePath);
				return true;
			}
			// File not found (was never tracked
			return false;
		}

		// If this is a new file or content changed
		if (oldHash !== newHash) {
			fileHashes.set(filePath, newHash);
			return true;
		}

		// File unchanged
		return false;
	}

	/**
	 * Initialize file hash cache for existing files
	 * This ensures we have a baseline for detecting changes
	 */
	function initializeFileHashCache() {
		try {
			const watchDir = process.cwd();

			// Walk through the directory and cache existing files
			function walkDir(dir: string) {
				const files = fs.readdirSync(dir);
				for (const file of files) {
					const fullPath = path.join(dir, file);
					const stat = fs.statSync(fullPath);

					if (stat.isDirectory() && !file.startsWith('.')) {
						walkDir(fullPath);
					} else if (stat.isFile() && !shouldIgnoreFile(file)) {
						const hash = getFileHash(fullPath);
						if (hash) {
							fileHashes.set(fullPath, hash);
						}
					}
				}
			}

			walkDir(watchDir);
		} catch (error) {
			console.error('Failed to initialize file hash cache:', error);
		}
	}

	function invalidateFileHashCache(specificFiles?: string[]) {
		if (specificFiles && specificFiles.length > 0) {
			// Clear hashes for specific files
			for (const file of specificFiles) {
				const fullPath = path.join(process.cwd(), file);
				fileHashes.delete(fullPath);
			}
		} else {
			// Clear entire cache for operations that could affect many files
			fileHashes.clear();
		}
	}

	function setupFileWatcher() {
		try {
			const watchDir = process.cwd();

			// Check if the directory is a git repository and don't start file watcher if not found
			if (!isGitRepository(watchDir)) {
				return;
			}

			// Parse .gitignore patterns
			const parsedPatterns = parseGitignore(watchDir);
			// Don't start file watcher if no .gitignore
			if (parsedPatterns === null) {
				return;
			}

			gitignorePatterns = parsedPatterns;

			// Initialize file hash cache for existing files
			initializeFileHashCache();

			// Watch for file changes in the current directory
			fileWatcher = fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
				if (!filename) return;

				// Ignore node-pty temporary files that can cause frequent events
				if (
					filename.includes('node-pty-spawn-helper-') ||
					filename.includes('.tmp') ||
					filename.includes('/tmp/')
				) {
					return;
				}

				// Use .gitignore patterns to determine if file should be ignored
				if (shouldIgnoreFile(filename)) {
					return;
				}

				// Convert relative filename to absolute path for consistent handling
				const fullPath = path.join(watchDir, filename);

				// For file writes, always check for changes to ensure we don't miss any
				// This is especially important for rapid successive writes to the same file
				if (eventType === 'change') {
					// Add a small delay to ensure the file system has settled
					setTimeout(() => {
						if (hasFileChanged(fullPath)) {
							// Trigger git updates for relevant file changes
							broadcastGitUpdates();
						} else {
							// File content unchanged after delay, skipping
						}
					}, 50); // 50ms delay to ensure file system has settled
				} else {
					// For other event types (rename, delete), check immediately
					if (hasFileChanged(fullPath)) {
						// Trigger git updates for relevant file changes
						broadcastGitUpdates();
					} else {
						// File content unchanged, skipping
					}
				}
			});

			console.log(`\n📂 Watching for file changes in: ${watchDir}\n`);
		} catch (error) {
			console.error('Failed to setup file watcher:', error);
		}
	}

	console.log(`Supercet version ${process.env.SUPERCET_VERSION} is running on http://localhost:${PORT}`);

	// Check for updates
	await checkForUpdates();
	console.log(`\n⮕ Review your local code changes at \x1b[34m${HOST}/conduit\x1b[0m`);

	// Start file watcher
	setupFileWatcher();
}

// Cleanup file watcher on process exit
process.on('SIGINT', () => {
	if (fileWatcher) {
		fileWatcher.close();
	}
	if (debounceTimeout) {
		clearTimeout(debounceTimeout);
	}
	fileHashes.clear();
	process.exit(0);
});

process.on('SIGTERM', () => {
	if (fileWatcher) {
		fileWatcher.close();
	}
	if (debounceTimeout) {
		clearTimeout(debounceTimeout);
	}
	fileHashes.clear();
	process.exit(0);
});

// Start the server
startServer().catch((error) => {
	console.error('❌ Failed to start server:', error.message);
	process.exit(1);
});
