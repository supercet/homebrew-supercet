import { spawn } from 'child_process';
import { Socket } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import {
	appendConduitSessionEvent,
	createConduitSession,
	findLatestConduitSessionIdByProviderSession,
	setConduitSessionProviderSessionId,
	setConduitSessionStatus,
	updateConduitSessionForRun,
} from '../db/sqlite';
import { resolveReadyWorkspaceForNewWork } from './workspaceReadiness';

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
	prompt?: string;
	workingDir: string;
	sessionId?: string;
	model?: string;
	streamCallback?: (data: StreamEvent) => void;
}

interface SocketSessionPayload {
	sessionId?: string;
	prompt?: string;
	context?: string;
	cli?: SupportedCli;
	model?: string;
	agentId: string;
	workspaceId: string;
	pipelineId?: string;
}

export interface ConduitSessionRequestMetadata {
	agentId: string;
	workspaceId: string;
	pipelineId?: string;
}

// Maximum session timeout (10 minutes)
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const CLI_PRECHECK_TIMEOUT_MS = 5000;

// UUID pattern for matching and validating session IDs
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const cliAvailabilityCache = new Set<SupportedCli>();

interface ConduitCaptureContext {
	conduitSessionId: string;
}

function mapStreamEventRole(type: StreamEvent['type']): 'assistant' | 'event' {
	if (type === 'stdout') {
		return 'assistant';
	}

	return 'event';
}

export function validateConduitSessionRequestMetadata(metadata: ConduitSessionRequestMetadata): void {
	if (!metadata.agentId || typeof metadata.agentId !== 'string') {
		throw new Error('agentId is required and must be a string');
	}

	if (!isValidUUID(metadata.agentId)) {
		throw new Error('Invalid agentId format (must be a valid UUID)');
	}

	if (!metadata.workspaceId || typeof metadata.workspaceId !== 'string') {
		throw new Error('workspaceId is required and must be a string');
	}

	if (metadata.pipelineId !== undefined && metadata.pipelineId !== null) {
		if (typeof metadata.pipelineId !== 'string') {
			throw new Error('pipelineId must be a string');
		}
		if (!isValidUUID(metadata.pipelineId)) {
			throw new Error('Invalid pipelineId format (must be a valid UUID)');
		}
	}
}

function startConduitSessionCapture(
	cli: SupportedCli,
	metadata: ConduitSessionRequestMetadata,
	prompt?: string,
	model?: string,
	providerSessionId?: string,
	context?: string,
): ConduitCaptureContext {
	const existingConduitSessionId =
		providerSessionId && isValidUUID(providerSessionId)
			? findLatestConduitSessionIdByProviderSession(cli, providerSessionId)
			: null;

	const conduitSessionId = existingConduitSessionId || randomUUID();

	if (existingConduitSessionId) {
		updateConduitSessionForRun(conduitSessionId, {
			providerSessionId: providerSessionId || null,
			provider: cli,
			agentId: metadata.agentId,
			pipelineId: metadata.pipelineId || null,
			workspaceId: metadata.workspaceId,
			model: model || null,
			status: 'running',
		});
	} else {
		createConduitSession({
			conduitSessionId,
			providerSessionId: providerSessionId || null,
			provider: cli,
			agentId: metadata.agentId,
			pipelineId: metadata.pipelineId || null,
			workspaceId: metadata.workspaceId,
			model: model || null,
			status: 'running',
		});
	}

	if (prompt && prompt.trim()) {
		appendConduitSessionEvent(conduitSessionId, 'prompt', 'client', prompt);
	}
	if (context && context.trim()) {
		appendConduitSessionEvent(conduitSessionId, 'context', 'client', context);
	}
	appendConduitSessionEvent(conduitSessionId, 'status', 'event', 'running');

	return { conduitSessionId };
}

function captureConduitStreamEvent(captureContext: ConduitCaptureContext, streamData: StreamEvent): void {
	if (streamData.type === 'sessionId' && isValidUUID(streamData.content)) {
		setConduitSessionProviderSessionId(captureContext.conduitSessionId, streamData.content);
	}

	appendConduitSessionEvent(
		captureContext.conduitSessionId,
		streamData.type,
		mapStreamEventRole(streamData.type),
		streamData.content,
	);
}

function completeConduitSessionCapture(captureContext: ConduitCaptureContext): void {
	appendConduitSessionEvent(captureContext.conduitSessionId, 'status', 'event', 'completed');
	setConduitSessionStatus(captureContext.conduitSessionId, 'completed');
}

function failConduitSessionCapture(captureContext: ConduitCaptureContext, errorMessage: string): void {
	appendConduitSessionEvent(captureContext.conduitSessionId, 'status', 'event', 'error');
	appendConduitSessionEvent(captureContext.conduitSessionId, 'error', 'event', errorMessage);
	setConduitSessionStatus(captureContext.conduitSessionId, 'error');
}

export interface ConduitSessionCaptureHandle {
	conduitSessionId: string;
	handleStreamEvent: (streamData: StreamEvent) => void;
	complete: () => void;
	fail: (errorMessage: string) => void;
}

export function beginConduitSessionCapture(
	cli: SupportedCli,
	metadata: ConduitSessionRequestMetadata,
	prompt?: string,
	model?: string,
	providerSessionId?: string,
	context?: string,
): ConduitSessionCaptureHandle {
	const captureContext = startConduitSessionCapture(cli, metadata, prompt, model, providerSessionId, context);

	return {
		conduitSessionId: captureContext.conduitSessionId,
		handleStreamEvent: (streamData) => captureConduitStreamEvent(captureContext, streamData),
		complete: () => completeConduitSessionCapture(captureContext),
		fail: (errorMessage) => failConduitSessionCapture(captureContext, errorMessage),
	};
}

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

function normalizeResumePrompt(prompt: unknown): string | undefined {
	if (prompt === undefined || prompt === null) {
		return undefined;
	}

	if (typeof prompt !== 'string') {
		throw new Error('Prompt must be a string when provided');
	}

	return prompt.trim() ? prompt : undefined;
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
			const promptArgs = options.prompt ? [options.prompt] : [];
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
					...promptArgs,
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
				validatePrompt(options.prompt || ''),
			],
		};
	}

	const modelArgs = options.model ? ['--model', options.model] : [];
	if (options.sessionId) {
		const promptArgs = options.prompt ? [options.prompt] : [];
		return {
			command: 'codex',
			args: [
				'exec',
				'resume',
				'--json',
				'--skip-git-repo-check',
				...modelArgs,
				options.sessionId,
				...promptArgs,
			],
		};
	}

	return {
		command: 'codex',
		args: [
			'exec',
			'--json',
			'--skip-git-repo-check',
			'--sandbox',
			'workspace-write',
			...modelArgs,
			validatePrompt(options.prompt || ''),
		],
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
	prompt: string | undefined,
	workingDir: string,
	model?: string,
	streamCallback?: (data: StreamEvent) => void,
): Promise<HeadlessCliSession> {
	try {
		prompt = normalizeResumePrompt(prompt);
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

export function handleHeadlessSessionCreate(socket: Socket, eventPrefix: string, defaultCli: SupportedCli) {
	socket.on(`${eventPrefix}:create`, async (data: SocketSessionPayload) => {
		let captureContext: ConduitCaptureContext | null = null;

		try {
			const { prompt, context, agentId, workspaceId, pipelineId } = data;

			if (!prompt || typeof prompt !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Prompt is required and must be a string' });
				return;
			}

			if (data.model !== undefined && typeof data.model !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Model must be a string' });
				return;
			}

			if (context !== undefined && typeof context !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Context must be a string' });
				return;
			}

			validateConduitSessionRequestMetadata({ agentId, workspaceId, pipelineId });
			const { workspace, error: workspaceError } = resolveReadyWorkspaceForNewWork(workspaceId);
			if (!workspace || workspaceError) {
				socket.emit(`${eventPrefix}:error`, {
					error: workspaceError || 'Workspace is not ready for new work',
				});
				return;
			}

			const cli = resolveCli(data.cli, defaultCli);
			const targetDir = workspace.path;
			captureContext = startConduitSessionCapture(
				cli,
				{ agentId, workspaceId, pipelineId },
				prompt,
				data.model,
				undefined,
				context,
			);

			socket.emit(`${eventPrefix}:started`, {
				message: `${cli} session starting...`,
				conduitSessionId: captureContext.conduitSessionId,
			});

			await createHeadlessCliSession(cli, prompt, targetDir, data.model, (streamData) => {
				emitSessionEvent(socket, eventPrefix, streamData);

				if (captureContext) {
					try {
						captureConduitStreamEvent(captureContext, streamData);
					} catch (error) {
						console.error('Failed to persist conduit stream event:', error);
					}
				}
			});

			if (captureContext) {
				completeConduitSessionCapture(captureContext);
			}
		} catch (error) {
			if (captureContext) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				failConduitSessionCapture(captureContext, errorMessage);
			}

			socket.emit(`${eventPrefix}:error`, {
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			});
		}
	});
}

export function handleHeadlessSessionResume(socket: Socket, eventPrefix: string, defaultCli: SupportedCli) {
	socket.on(`${eventPrefix}:resume`, async (data: SocketSessionPayload) => {
		let captureContext: ConduitCaptureContext | null = null;

		try {
			const { sessionId, prompt, context, agentId, workspaceId, pipelineId } = data;

			if (!sessionId || typeof sessionId !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Session ID is required and must be a string' });
				return;
			}

			if (!isValidUUID(sessionId)) {
				socket.emit(`${eventPrefix}:error`, { error: 'Invalid session ID format (must be a valid UUID)' });
				return;
			}

			if (prompt !== undefined && typeof prompt !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Prompt must be a string when provided' });
				return;
			}

			const normalizedPrompt = normalizeResumePrompt(prompt);

			if (data.model !== undefined && typeof data.model !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Model must be a string' });
				return;
			}

			if (context !== undefined && typeof context !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'Context must be a string' });
				return;
			}

			validateConduitSessionRequestMetadata({ agentId, workspaceId, pipelineId });
			const { workspace, error: workspaceError } = resolveReadyWorkspaceForNewWork(workspaceId);
			if (!workspace || workspaceError) {
				socket.emit(`${eventPrefix}:error`, {
					error: workspaceError || 'Workspace is not ready for new work',
				});
				return;
			}

			const cli = resolveCli(data.cli, defaultCli);
			const targetDir = workspace.path;
			captureContext = startConduitSessionCapture(
				cli,
				{ agentId, workspaceId, pipelineId },
				normalizedPrompt,
				data.model,
				sessionId,
				context,
			);

			socket.emit(`${eventPrefix}:started`, {
				message: `Resuming ${cli} session...`,
				conduitSessionId: captureContext.conduitSessionId,
			});

			await resumeHeadlessCliSession(cli, sessionId, normalizedPrompt, targetDir, data.model, (streamData) => {
				emitSessionEvent(socket, eventPrefix, streamData);

				if (captureContext) {
					try {
						captureConduitStreamEvent(captureContext, streamData);
					} catch (error) {
						console.error('Failed to persist conduit stream event:', error);
					}
				}
			});

			if (captureContext) {
				completeConduitSessionCapture(captureContext);
			}
		} catch (error) {
			if (captureContext) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				failConduitSessionCapture(captureContext, errorMessage);
			}

			socket.emit(`${eventPrefix}:error`, {
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			});
		}
	});
}

export function resolveSupportedCli(value: unknown, fallback: SupportedCli): SupportedCli {
	return resolveCli(value, fallback);
}
