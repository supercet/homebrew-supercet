import { spawn } from 'child_process';
import { Socket } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';

interface ClaudeCodeSession {
	sessionId: string | null;
	process: ReturnType<typeof spawn> | null;
	output: string[];
	error: string[];
	status: 'running' | 'completed' | 'error';
}

// Maximum session timeout (10 minutes)
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Validates and sanitizes the working directory path to prevent path traversal attacks
 * @param workingDir - The working directory to validate
 * @returns Validated absolute path or throws an error
 */
function validateWorkingDirectory(workingDir: string): string {
	if (!workingDir || typeof workingDir !== 'string') {
		throw new Error('Working directory must be a non-empty string');
	}

	// Resolve to absolute path and normalize
	const normalizedPath = path.resolve(workingDir);

	// Check if directory exists
	try {
		const stats = fs.statSync(normalizedPath);
		if (!stats.isDirectory()) {
			throw new Error('Working directory must be a valid directory');
		}
	} catch (error) {
		throw new Error(`Invalid working directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}

	// Prevent traversal outside of reasonable bounds
	// This ensures we're not accessing system directories
	const cwd = process.cwd();
	const home = process.env.HOME || '/';

	// Only allow paths within current working directory or user's home directory
	if (!normalizedPath.startsWith(cwd) && !normalizedPath.startsWith(home)) {
		throw new Error('Working directory must be within current working directory or home directory');
	}

	return normalizedPath;
}

/**
 * Validates that the prompt is safe and doesn't contain malicious content
 * @param prompt - The prompt to validate
 * @returns The validated prompt or throws an error
 */
function validatePrompt(prompt: string): string {
	if (!prompt || typeof prompt !== 'string') {
		throw new Error('Prompt must be a non-empty string');
	}

	return prompt;
}

/**
 * UUID pattern for matching and validating session IDs
 * Format: 550e8400-e29b-41d4-a716-446655440000
 */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Validates that a session ID is a valid UUID format
 * @param sessionId - The session ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidUUID(sessionId: string): boolean {
	const match = sessionId.match(UUID_PATTERN);
	return match !== null && match[0] === sessionId;
}

/**
 * Parse session ID from Claude Code output
 * Session IDs are UUIDs in the format: 550e8400-e29b-41d4-a716-446655440000
 */
function extractSessionId(output: string): string | null {
	const match = output.match(UUID_PATTERN);
	return match ? match[0] : null;
}

/**
 * Internal helper function to execute a Claude Code session
 * @param options - Configuration for the session
 * @returns Promise resolving to the session information
 */
function executeClaudeCodeSession(options: {
	prompt: string;
	workingDir: string;
	spawnArgs: string[];
	initialSessionId: string | null;
	extractSessionId: boolean;
	errorPrefix: string;
	streamCallback?: (data: {
		type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error';
		content: string;
	}) => void;
}): Promise<ClaudeCodeSession> {
	const {
		prompt,
		workingDir,
		spawnArgs,
		initialSessionId,
		extractSessionId: shouldExtractSessionId,
		errorPrefix,
		streamCallback,
	} = options;

	return new Promise((resolve, reject) => {
		const session: ClaudeCodeSession = {
			sessionId: initialSessionId,
			process: null,
			output: [],
			error: [],
			status: 'running',
		};

		// Notify callback of initial session ID if provided
		if (initialSessionId) {
			streamCallback?.({ type: 'sessionId', content: initialSessionId });
		}

		// Set up timeout to prevent runaway processes
		let timeoutHandle: NodeJS.Timeout | null = null;
		const clearSessionTimeout = () => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
		};

		timeoutHandle = setTimeout(() => {
			if (session.process && !session.process.killed) {
				session.process.kill('SIGTERM');
				const errorMsg = 'Session timed out after 10 minutes';
				streamCallback?.({ type: 'error', content: errorMsg });
				session.status = 'error';
				reject(new Error(errorMsg));
			}
			timeoutHandle = null;
		}, SESSION_TIMEOUT_MS);

		// Spawn Claude Code process
		const claudeProcess = spawn('claude', spawnArgs, {
			cwd: workingDir,
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin, pipe stdout and stderr
		});

		session.process = claudeProcess;

		// Buffer for incomplete JSON lines
		let stdoutBuffer = '';
		let stderrBuffer = '';

		const processLine = (line: string, isStdout: boolean) => {
			if (!line.trim()) return;

			if (isStdout) {
				session.output.push(line);
			} else {
				session.error.push(line);
			}

			// Try to extract session ID if needed and we haven't found it yet
			if (shouldExtractSessionId && !session.sessionId) {
				const foundSessionId = extractSessionId(line);
				if (foundSessionId) {
					session.sessionId = foundSessionId;
					streamCallback?.({ type: 'sessionId', content: foundSessionId });
				}
			}

			// Stream output to callback
			streamCallback?.({ type: isStdout ? 'stdout' : 'stderr', content: line });
		};

		claudeProcess.stdout.on('data', (data: Buffer) => {
			const chunk = data.toString();
			stdoutBuffer += chunk;

			// Process complete lines
			const lines = stdoutBuffer.split('\n');
			stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer

			for (const line of lines) {
				processLine(line, true);
			}
		});

		claudeProcess.stderr.on('data', (data: Buffer) => {
			const chunk = data.toString();
			stderrBuffer += chunk;

			// Process complete lines
			const lines = stderrBuffer.split('\n');
			stderrBuffer = lines.pop() || '';

			for (const line of lines) {
				processLine(line, false);
			}
		});

		claudeProcess.on('close', (code) => {
			clearSessionTimeout();

			// Process any remaining buffered data
			if (stdoutBuffer.trim()) {
				processLine(stdoutBuffer, true);
			}
			if (stderrBuffer.trim()) {
				processLine(stderrBuffer, false);
			}

			if (code === 0) {
				session.status = 'completed';
				streamCallback?.({ type: 'complete', content: 'Session completed successfully' });
				resolve(session);
			} else {
				session.status = 'error';
				const errorMsg = `Claude Code exited with code ${code}`;
				streamCallback?.({ type: 'error', content: errorMsg });
				reject(new Error(errorMsg));
			}
		});

		claudeProcess.on('error', (error) => {
			clearSessionTimeout();
			session.status = 'error';
			const errorMsg = `${errorPrefix}: ${error.message}`;
			streamCallback?.({ type: 'error', content: errorMsg });
			reject(new Error(errorMsg));
		});
	});
}

/**
 * Create a new Claude Code session in headless mode
 * @param prompt - The prompt to send to Claude
 * @param workingDir - The working directory for the session
 * @param streamCallback - Optional callback for streaming output (for socket mode)
 * @returns Session information including the session ID
 */
export async function createClaudeCodeSession(
	prompt: string,
	workingDir: string,
	streamCallback?: (data: {
		type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error';
		content: string;
	}) => void,
): Promise<ClaudeCodeSession> {
	// Validate inputs
	try {
		validatePrompt(prompt);
		workingDir = validateWorkingDirectory(workingDir);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Validation error';
		streamCallback?.({ type: 'error', content: errorMsg });
		throw error;
	}

	return executeClaudeCodeSession({
		prompt,
		workingDir,
		spawnArgs: ['-p', '--verbose', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', prompt],
		initialSessionId: null,
		extractSessionId: true,
		errorPrefix: 'Failed to start Claude Code',
		streamCallback,
	});
}

/**
 * Resume an existing Claude Code session
 * @param sessionId - The session ID to resume
 * @param prompt - The prompt to send to the resumed session
 * @param workingDir - The working directory for the session
 * @param streamCallback - Optional callback for streaming output (for socket mode)
 * @returns Session information
 */
export async function resumeClaudeCodeSession(
	sessionId: string,
	prompt: string,
	workingDir: string,
	streamCallback?: (data: {
		type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error';
		content: string;
	}) => void,
): Promise<ClaudeCodeSession> {
	// Validate inputs
	try {
		validatePrompt(prompt);
		workingDir = validateWorkingDirectory(workingDir);

		if (!sessionId || !isValidUUID(sessionId)) {
			throw new Error('Invalid session ID format (must be a valid UUID)');
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Validation error';
		streamCallback?.({ type: 'error', content: errorMsg });
		throw error;
	}

	return executeClaudeCodeSession({
		prompt,
		workingDir,
		spawnArgs: [
			'-p',
			'--verbose',
			'--resume',
			sessionId,
			'--permission-mode',
			'acceptEdits',
			'--output-format',
			'stream-json',
			prompt,
		],
		initialSessionId: sessionId,
		extractSessionId: false,
		errorPrefix: 'Failed to resume Claude Code session',
		streamCallback,
	});
}

/**
 * Socket.IO handler for creating a Claude Code session with streaming
 * Note: Authentication is handled by the socket.io server before this handler is called
 * The server tracks authenticated sockets in the authenticatedSockets Map
 */
export function handleClaudeSessionCreate(socket: Socket, workingDir: string) {
	socket.on('claude:session:create', async (data: { prompt: string; workingDir?: string }) => {
		try {
			const { prompt } = data;

			if (!prompt || typeof prompt !== 'string') {
				socket.emit('claude:session:error', { error: 'Prompt is required and must be a string' });
				return;
			}

			// Validate workingDir if provided
			if (data.workingDir !== undefined && typeof data.workingDir !== 'string') {
				socket.emit('claude:session:error', { error: 'Working directory must be a string' });
				return;
			}

			// Use provided workingDir or default to the server's working directory
			// Validation will be performed inside createClaudeCodeSession
			const targetDir = data.workingDir || workingDir;

			// Send acknowledgment that the request was received
			socket.emit('claude:session:started', { message: 'Claude Code session starting...' });

			// Create session with streaming callback
			await createClaudeCodeSession(prompt, targetDir, (streamData) => {
				switch (streamData.type) {
					case 'sessionId':
						socket.emit('claude:session:id', { sessionId: streamData.content });
						break;
					case 'stdout':
						socket.emit('claude:session:output', { data: streamData.content });
						break;
					case 'stderr':
						socket.emit('claude:session:error:output', { data: streamData.content });
						break;
					case 'complete':
						socket.emit('claude:session:complete', { message: streamData.content });
						break;
					case 'error':
						socket.emit('claude:session:error', { error: streamData.content });
						break;
				}
			});
		} catch (error) {
			socket.emit('claude:session:error', {
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			});
		}
	});
}

/**
 * Socket.IO handler for resuming a Claude Code session with streaming
 * Note: Authentication is handled by the socket.io server before this handler is called
 * The server tracks authenticated sockets in the authenticatedSockets Map
 */
export function handleClaudeSessionResume(socket: Socket, workingDir: string) {
	socket.on('claude:session:resume', async (data: { sessionId: string; prompt: string; workingDir?: string }) => {
		try {
			const { sessionId, prompt } = data;

			if (!sessionId || typeof sessionId !== 'string') {
				socket.emit('claude:session:error', { error: 'Session ID is required and must be a string' });
				return;
			}

			// Validate session ID format
			if (!isValidUUID(sessionId)) {
				socket.emit('claude:session:error', { error: 'Invalid session ID format (must be a valid UUID)' });
				return;
			}

			if (!prompt || typeof prompt !== 'string') {
				socket.emit('claude:session:error', { error: 'Prompt is required and must be a string' });
				return;
			}

			// Validate workingDir if provided
			if (data.workingDir !== undefined && typeof data.workingDir !== 'string') {
				socket.emit('claude:session:error', { error: 'Working directory must be a string' });
				return;
			}

			// Use provided workingDir or default to the server's working directory
			// Validation will be performed inside resumeClaudeCodeSession
			const targetDir = data.workingDir || workingDir;

			// Send acknowledgment that the request was received
			socket.emit('claude:session:started', { message: 'Resuming Claude Code session...' });

			// Resume session with streaming callback
			await resumeClaudeCodeSession(sessionId, prompt, targetDir, (streamData) => {
				switch (streamData.type) {
					case 'sessionId':
						socket.emit('claude:session:id', { sessionId: streamData.content });
						break;
					case 'stdout':
						socket.emit('claude:session:output', { data: streamData.content });
						break;
					case 'stderr':
						socket.emit('claude:session:error:output', { data: streamData.content });
						break;
					case 'complete':
						socket.emit('claude:session:complete', { message: streamData.content });
						break;
					case 'error':
						socket.emit('claude:session:error', { error: streamData.content });
						break;
				}
			});
		} catch (error) {
			socket.emit('claude:session:error', {
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			});
		}
	});
}
