import { spawn } from 'child_process';
import { Socket } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';

export type SupportedCli = 'claude' | 'codex';

export interface HeadlessCliSession {
	sessionId: string | null;
	process: ReturnType<typeof spawn> | null;
	output: string[];
	error: string[];
	status: 'running' | 'completed' | 'error';
}

export interface StreamEvent {
	type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error';
	content: string;
}

interface CliSessionOptions {
	prompt: string;
	workingDir: string;
	sessionId?: string;
	model?: string;
	streamCallback?: (data: StreamEvent) => void;
}

interface SocketSessionPayload {
	sessionId?: string;
	prompt: string;
	workingDir?: string;
	cli?: SupportedCli;
	model?: string;
}

// Maximum session timeout (10 minutes)
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const CLI_PRECHECK_TIMEOUT_MS = 5000;

// UUID pattern for matching and validating session IDs
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const cliAvailabilityCache = new Set<SupportedCli>();

export function isSupportedCli(value: unknown): value is SupportedCli {
	return value === 'claude' || value === 'codex';
}

/**
 * Validates and sanitizes the working directory path to prevent path traversal attacks
 */
export function validateWorkingDirectory(workingDir: string): string {
	if (!workingDir || typeof workingDir !== 'string') {
		throw new Error('Working directory must be a non-empty string');
	}

	const normalizedPath = path.resolve(workingDir);

	try {
		const stats = fs.statSync(normalizedPath);
		if (!stats.isDirectory()) {
			throw new Error('Working directory must be a valid directory');
		}
	} catch (error) {
		throw new Error(`Invalid working directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}

	const cwd = process.cwd();
	const home = process.env.HOME || '/';
	if (!normalizedPath.startsWith(cwd) && !normalizedPath.startsWith(home)) {
		throw new Error('Working directory must be within current working directory or home directory');
	}

	return normalizedPath;
}

/**
 * Validates that the prompt is safe and doesn't contain malicious content
 */
function validatePrompt(prompt: string): string {
	if (!prompt || typeof prompt !== 'string') {
		throw new Error('Prompt must be a non-empty string');
	}

	return prompt;
}

/**
 * Validates that a session ID is a valid UUID format
 */
export function isValidUUID(sessionId: string): boolean {
	const match = sessionId.match(UUID_PATTERN);
	return match !== null && match[0] === sessionId;
}

function extractSessionIdFromJsonLine(line: string): string | null {
	try {
		const parsed = JSON.parse(line) as unknown;
		const queue: unknown[] = [parsed];

		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) continue;

			if (typeof item === 'string') {
				const match = item.match(UUID_PATTERN);
				if (match) return match[0];
				continue;
			}

			if (Array.isArray(item)) {
				queue.push(...item);
				continue;
			}

			if (typeof item === 'object') {
				queue.push(...Object.values(item as Record<string, unknown>));
			}
		}
	} catch {
		// Not JSON; ignore and fallback to regex.
	}

	return null;
}

function extractSessionId(output: string): string | null {
	const fromJson = extractSessionIdFromJsonLine(output);
	if (fromJson) return fromJson;

	const match = output.match(UUID_PATTERN);
	return match ? match[0] : null;
}

function buildCliCommand(cli: SupportedCli, options: CliSessionOptions): { command: string; args: string[] } {
	if (cli === 'claude') {
		const modelArgs = options.model ? ['--model', options.model] : [];
		if (options.sessionId) {
			return {
				command: 'claude',
				args: [
					'-p',
					'--verbose',
					'--resume',
					options.sessionId,
					...modelArgs,
					'--permission-mode',
					'acceptEdits',
					'--output-format',
					'stream-json',
					options.prompt,
				],
			};
		}

		return {
			command: 'claude',
			args: [
				'-p',
				'--verbose',
				...modelArgs,
				'--permission-mode',
				'acceptEdits',
				'--output-format',
				'stream-json',
				options.prompt,
			],
		};
	}

	const modelArgs = options.model ? ['--model', options.model] : [];
	if (options.sessionId) {
		return {
			command: 'codex',
			args: [
				'exec',
				'resume',
				'--json',
				'--skip-git-repo-check',
				...modelArgs,
				options.sessionId,
				options.prompt,
			],
		};
	}

	return {
		command: 'codex',
		args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...modelArgs, options.prompt],
	};
}

function preflightArgsFor(cli: SupportedCli): string[] {
	if (cli === 'claude') {
		return ['--version'];
	}

	return ['--version'];
}

async function ensureCliAvailable(cli: SupportedCli, workingDir: string): Promise<void> {
	if (cliAvailabilityCache.has(cli)) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const preflight = spawn(cli, preflightArgsFor(cli), {
			cwd: workingDir,
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stderr = '';
		let stdout = '';
		let settled = false;

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (error) {
				reject(error);
				return;
			}

			cliAvailabilityCache.add(cli);
			resolve();
		};

		const timeout = setTimeout(() => {
			try {
				preflight.kill('SIGTERM');
			} catch {}
			finish(
				new Error(`'${cli}' is installed but failed preflight (timeout after ${CLI_PRECHECK_TIMEOUT_MS}ms).`),
			);
		}, CLI_PRECHECK_TIMEOUT_MS);

		preflight.stdout.on('data', (data: Buffer) => {
			stdout += data.toString();
		});

		preflight.stderr.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		preflight.on('error', (error) => {
			clearTimeout(timeout);
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				finish(new Error(`'${cli}' CLI is not available on this system (command not found).`));
				return;
			}

			finish(new Error(`Failed to run '${cli}' preflight check: ${error.message}`));
		});

		preflight.on('close', (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				finish();
				return;
			}

			const details = `${stdout}\n${stderr}`.trim();
			finish(
				new Error(
					`'${cli}' CLI is available but failed preflight with exit code ${code}${
						details ? `: ${details}` : ''
					}`,
				),
			);
		});
	});
}

function executeHeadlessCliSession(
	cli: SupportedCli,
	options: CliSessionOptions,
	errorPrefix: string,
): Promise<HeadlessCliSession> {
	const { streamCallback } = options;
	const command = buildCliCommand(cli, options);

	return new Promise((resolve, reject) => {
		const session: HeadlessCliSession = {
			sessionId: options.sessionId || null,
			process: null,
			output: [],
			error: [],
			status: 'running',
		};

		if (options.sessionId) {
			streamCallback?.({ type: 'sessionId', content: options.sessionId });
		}

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

		const child = spawn(command.command, command.args, {
			cwd: options.workingDir,
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		session.process = child;

		let stdoutBuffer = '';
		let stderrBuffer = '';

		const processLine = (line: string, isStdout: boolean) => {
			if (!line.trim()) return;

			if (isStdout) {
				session.output.push(line);
			} else {
				session.error.push(line);
			}

			if (!session.sessionId) {
				const foundSessionId = extractSessionId(line);
				if (foundSessionId) {
					session.sessionId = foundSessionId;
					streamCallback?.({ type: 'sessionId', content: foundSessionId });
				}
			}

			streamCallback?.({ type: isStdout ? 'stdout' : 'stderr', content: line });
		};

		child.stdout.on('data', (data: Buffer) => {
			const chunk = data.toString();
			stdoutBuffer += chunk;
			const lines = stdoutBuffer.split('\n');
			stdoutBuffer = lines.pop() || '';
			for (const line of lines) {
				processLine(line, true);
			}
		});

		child.stderr.on('data', (data: Buffer) => {
			const chunk = data.toString();
			stderrBuffer += chunk;
			const lines = stderrBuffer.split('\n');
			stderrBuffer = lines.pop() || '';
			for (const line of lines) {
				processLine(line, false);
			}
		});

		child.on('close', (code) => {
			clearSessionTimeout();

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
				const errorMsg = `${cli} exited with code ${code}`;
				streamCallback?.({ type: 'error', content: errorMsg });
				reject(new Error(errorMsg));
			}
		});

		child.on('error', (error) => {
			clearSessionTimeout();
			session.status = 'error';
			const errorMsg = `${errorPrefix}: ${error.message}`;
			streamCallback?.({ type: 'error', content: errorMsg });
			reject(new Error(errorMsg));
		});
	});
}

export async function createHeadlessCliSession(
	cli: SupportedCli,
	prompt: string,
	workingDir: string,
	model?: string,
	streamCallback?: (data: StreamEvent) => void,
): Promise<HeadlessCliSession> {
	try {
		validatePrompt(prompt);
		workingDir = validateWorkingDirectory(workingDir);
		await ensureCliAvailable(cli, workingDir);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Validation error';
		streamCallback?.({ type: 'error', content: errorMsg });
		throw error;
	}

	return executeHeadlessCliSession(cli, { prompt, workingDir, model, streamCallback }, `Failed to start ${cli}`);
}

export async function resumeHeadlessCliSession(
	cli: SupportedCli,
	sessionId: string,
	prompt: string,
	workingDir: string,
	model?: string,
	streamCallback?: (data: StreamEvent) => void,
): Promise<HeadlessCliSession> {
	try {
		validatePrompt(prompt);
		workingDir = validateWorkingDirectory(workingDir);
		await ensureCliAvailable(cli, workingDir);

		if (!sessionId || !isValidUUID(sessionId)) {
			throw new Error('Invalid session ID format (must be a valid UUID)');
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Validation error';
		streamCallback?.({ type: 'error', content: errorMsg });
		throw error;
	}

	return executeHeadlessCliSession(
		cli,
		{ sessionId, prompt, workingDir, model, streamCallback },
		`Failed to resume ${cli} session`,
	);
}

function emitSessionEvent(socket: Socket, eventPrefix: string, streamData: StreamEvent) {
	switch (streamData.type) {
		case 'sessionId':
			socket.emit(`${eventPrefix}:id`, { sessionId: streamData.content });
			break;
		case 'stdout':
			socket.emit(`${eventPrefix}:output`, { data: streamData.content });
			break;
		case 'stderr':
			socket.emit(`${eventPrefix}:error:output`, { data: streamData.content });
			break;
		case 'complete':
			socket.emit(`${eventPrefix}:complete`, { message: streamData.content });
			break;
		case 'error':
			socket.emit(`${eventPrefix}:error`, { error: streamData.content });
			break;
	}
}

function resolveCli(value: unknown, fallback: SupportedCli): SupportedCli {
	if (value === undefined || value === null) return fallback;
	if (!isSupportedCli(value)) {
		throw new Error(`Unsupported cli '${String(value)}'. Supported values are: claude, codex`);
	}
	return value;
}

export function handleHeadlessSessionCreate(
	socket: Socket,
	serverWorkingDir: string,
	eventPrefix: string,
	defaultCli: SupportedCli,
) {
	socket.on(`${eventPrefix}:create`, async (data: SocketSessionPayload) => {
		try {
			const { prompt } = data;

			if (!prompt || typeof prompt !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Prompt is required and must be a string' });
				return;
			}

			if (data.workingDir !== undefined && typeof data.workingDir !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Working directory must be a string' });
				return;
			}

			if (data.model !== undefined && typeof data.model !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Model must be a string' });
				return;
			}

			const cli = resolveCli(data.cli, defaultCli);
			const targetDir = data.workingDir || serverWorkingDir;

			socket.emit(`${eventPrefix}:started`, { message: `${cli} session starting...` });

			await createHeadlessCliSession(cli, prompt, targetDir, data.model, (streamData) => {
				emitSessionEvent(socket, eventPrefix, streamData);
			});
		} catch (error) {
			socket.emit(`${eventPrefix}:error`, {
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			});
		}
	});
}

export function handleHeadlessSessionResume(
	socket: Socket,
	serverWorkingDir: string,
	eventPrefix: string,
	defaultCli: SupportedCli,
) {
	socket.on(`${eventPrefix}:resume`, async (data: SocketSessionPayload) => {
		try {
			const { sessionId, prompt } = data;

			if (!sessionId || typeof sessionId !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Session ID is required and must be a string' });
				return;
			}

			if (!isValidUUID(sessionId)) {
				socket.emit(`${eventPrefix}:error`, { error: 'Invalid session ID format (must be a valid UUID)' });
				return;
			}

			if (!prompt || typeof prompt !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Prompt is required and must be a string' });
				return;
			}

			if (data.workingDir !== undefined && typeof data.workingDir !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Working directory must be a string' });
				return;
			}

			if (data.model !== undefined && typeof data.model !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Model must be a string' });
				return;
			}

			const cli = resolveCli(data.cli, defaultCli);
			const targetDir = data.workingDir || serverWorkingDir;

			socket.emit(`${eventPrefix}:started`, { message: `Resuming ${cli} session...` });

			await resumeHeadlessCliSession(cli, sessionId, prompt, targetDir, data.model, (streamData) => {
				emitSessionEvent(socket, eventPrefix, streamData);
			});
		} catch (error) {
			socket.emit(`${eventPrefix}:error`, {
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			});
		}
	});
}

export function resolveSupportedCli(value: unknown, fallback: SupportedCli): SupportedCli {
	return resolveCli(value, fallback);
}
