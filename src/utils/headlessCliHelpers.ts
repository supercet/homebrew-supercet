import { spawn } from 'child_process';
import { Socket } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import {
	appendConduitSessionEvent,
	createConduitSession,
	findLatestConduitSessionIdByProviderSession,
	getConduitSessionById,
	setConduitSessionProviderSessionId,
	setConduitSessionStatus,
	updateConduitSessionForRun,
} from '../db/sqlite';
import { resolveReadyWorkspaceForNewWork } from './workspaceReadiness';

export type SupportedCli = 'claude' | 'codex';

export interface HeadlessCliSession {
	providerSessionId: string | null;
	process: ReturnType<typeof spawn> | null;
	output: string[];
	error: string[];
	status: 'running' | 'completed' | 'error' | 'cancelled';
}

export interface StreamEvent {
	type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error' | 'cancelled';
	content: string;
}

interface CliSessionOptions {
	prompt?: string;
	workingDir: string;
	providerSessionId?: string;
	sessionId?: string;
	isDangerous?: boolean;
	model?: string;
	streamCallback?: (data: StreamEvent) => void;
}

interface SocketSessionPayload {
	prompt?: string;
	context?: string;
	isDangerous?: boolean;
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

const CLI_PRECHECK_TIMEOUT_MS = 5000;
const SESSION_CANCEL_GRACE_PERIOD_MS = 5000;

// UUID pattern for matching and validating session IDs
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const cliAvailabilityCache = new Set<SupportedCli>();

interface ConduitCaptureContext {
	sessionId: string;
}

interface ActiveHeadlessCliSession {
	cli: SupportedCli;
	sessionId: string | null;
	providerSessionId: string | null;
	process: ReturnType<typeof spawn>;
	cancelRequested: boolean;
	cancelReason: string | null;
	cancelKillTimeout: NodeJS.Timeout | null;
}

export interface CancelHeadlessCliSessionInput {
	cli?: SupportedCli;
	sessionId?: string;
	providerSessionId?: string;
}

export interface CancelHeadlessCliSessionResult {
	cli: SupportedCli;
	sessionId: string | null;
	providerSessionId: string | null;
	status: 'cancelled';
}

export interface ResolvedResumeSessionTarget {
	providerSessionId: string | null;
	sessionId: string | null;
}

export interface ResolvedConduitSession {
	cli: SupportedCli;
	sessionId: string;
	providerSessionId: string | null;
}

export interface HeadlessSessionRunSuccessPayload {
	success: true;
	provider: SupportedCli;
	sessionId: string;
	status: HeadlessCliSession['status'];
	output: string[];
	error?: string[];
}

const activeSessionsBySessionId = new Map<string, ActiveHeadlessCliSession>();
const activeSessionsByProviderId = new Map<string, ActiveHeadlessCliSession>();

function assertNoActiveRunForSession(sessionId: string): void {
	if (activeSessionsBySessionId.has(sessionId)) {
		throw new Error(`Session '${sessionId}' already has an active run`);
	}
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
	preferredSessionId?: string,
): ConduitCaptureContext {
	const existingSessionId =
		preferredSessionId ||
		(providerSessionId && isValidUUID(providerSessionId)
			? findLatestConduitSessionIdByProviderSession(cli, providerSessionId)
			: null);

	const sessionId = existingSessionId || randomUUID();

	if (existingSessionId) {
		assertNoActiveRunForSession(sessionId);
	}

	if (existingSessionId) {
		updateConduitSessionForRun(sessionId, {
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
			sessionId,
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
		appendConduitSessionEvent(sessionId, 'prompt', 'client', prompt);
	}
	if (context && context.trim()) {
		appendConduitSessionEvent(sessionId, 'context', 'client', context);
	}
	appendConduitSessionEvent(sessionId, 'status', 'event', 'running');

	return { sessionId };
}

function captureConduitStreamEvent(captureContext: ConduitCaptureContext, streamData: StreamEvent): void {
	if (streamData.type === 'cancelled') {
		return;
	}

	if (streamData.type === 'sessionId' && isValidUUID(streamData.content)) {
		setConduitSessionProviderSessionId(captureContext.sessionId, streamData.content);
	}

	appendConduitSessionEvent(
		captureContext.sessionId,
		streamData.type,
		mapStreamEventRole(streamData.type),
		streamData.content,
	);
}

function completeConduitSessionCapture(captureContext: ConduitCaptureContext): void {
	appendConduitSessionEvent(captureContext.sessionId, 'status', 'event', 'completed');
	setConduitSessionStatus(captureContext.sessionId, 'completed');
}

function failConduitSessionCapture(captureContext: ConduitCaptureContext, errorMessage: string): void {
	appendConduitSessionEvent(captureContext.sessionId, 'status', 'event', 'error');
	appendConduitSessionEvent(captureContext.sessionId, 'error', 'event', errorMessage);
	setConduitSessionStatus(captureContext.sessionId, 'error');
}

function cancelConduitSessionCapture(captureContext: ConduitCaptureContext): void {
	appendConduitSessionEvent(captureContext.sessionId, 'status', 'event', 'cancelled');
	setConduitSessionStatus(captureContext.sessionId, 'cancelled');
}

export interface ConduitSessionCaptureHandle {
	sessionId: string;
	handleStreamEvent: (streamData: StreamEvent) => void;
	complete: () => void;
	fail: (errorMessage: string) => void;
	cancel: () => void;
}

export function beginConduitSessionCapture(
	cli: SupportedCli,
	metadata: ConduitSessionRequestMetadata,
	prompt?: string,
	model?: string,
	providerSessionId?: string,
	context?: string,
	existingSessionId?: string,
): ConduitSessionCaptureHandle {
	const captureContext = startConduitSessionCapture(
		cli,
		metadata,
		prompt,
		model,
		providerSessionId,
		context,
		existingSessionId,
	);
	let finalized = false;

	const finalize = (handler: () => void) => {
		if (finalized) {
			return;
		}

		finalized = true;
		handler();
	};

	return {
		sessionId: captureContext.sessionId,
		handleStreamEvent: (streamData) => captureConduitStreamEvent(captureContext, streamData),
		complete: () => finalize(() => completeConduitSessionCapture(captureContext)),
		fail: (errorMessage) => finalize(() => failConduitSessionCapture(captureContext, errorMessage)),
		cancel: () => finalize(() => cancelConduitSessionCapture(captureContext)),
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

function registerActiveSession(session: ActiveHeadlessCliSession): void {
	if (session.sessionId) {
		activeSessionsBySessionId.set(session.sessionId, session);
	}

	if (session.providerSessionId) {
		activeSessionsByProviderId.set(session.providerSessionId, session);
	}
}

function attachProviderSessionId(session: ActiveHeadlessCliSession, providerSessionId: string): void {
	if (session.providerSessionId === providerSessionId) {
		return;
	}

	if (session.providerSessionId) {
		activeSessionsByProviderId.delete(session.providerSessionId);
	}

	session.providerSessionId = providerSessionId;
	activeSessionsByProviderId.set(providerSessionId, session);
}

function unregisterActiveSession(session: ActiveHeadlessCliSession): void {
	if (session.cancelKillTimeout) {
		clearTimeout(session.cancelKillTimeout);
		session.cancelKillTimeout = null;
	}

	if (session.sessionId && activeSessionsBySessionId.get(session.sessionId) === session) {
		activeSessionsBySessionId.delete(session.sessionId);
	}

	if (session.providerSessionId && activeSessionsByProviderId.get(session.providerSessionId) === session) {
		activeSessionsByProviderId.delete(session.providerSessionId);
	}
}

function assertSessionCliOwnership(actualCli: SupportedCli, expectedCli?: SupportedCli, sessionId?: string): void {
	if (expectedCli && actualCli !== expectedCli) {
		const sessionLabel = sessionId ? `Session '${sessionId}'` : 'Session';
		throw new Error(`${sessionLabel} belongs to ${actualCli}, not ${expectedCli}`);
	}
}

export function resolveConduitSession(sessionId: string): ResolvedConduitSession {
	const conduitSession = getConduitSessionById(sessionId);
	if (!conduitSession) {
		throw new Error(`Unknown session ID '${sessionId}'`);
	}

	return {
		cli: conduitSession.provider,
		sessionId: conduitSession.sessionId,
		providerSessionId: conduitSession.providerSessionId,
	};
}

function resolveActiveSession(target: CancelHeadlessCliSessionInput): ActiveHeadlessCliSession | null {
	if (target.sessionId) {
		const session = activeSessionsBySessionId.get(target.sessionId);
		if (session) {
			assertSessionCliOwnership(session.cli, target.cli, target.sessionId);
			return session;
		}
	}

	if (target.providerSessionId) {
		const providerSession = activeSessionsByProviderId.get(target.providerSessionId);
		if (providerSession) {
			assertSessionCliOwnership(providerSession.cli, target.cli, target.providerSessionId);
			return providerSession;
		}
	}

	return null;
}

export function cancelHeadlessCliSession(target: CancelHeadlessCliSessionInput): CancelHeadlessCliSessionResult {
	const sessionId =
		typeof target.sessionId === 'string' && target.sessionId.trim() ? target.sessionId.trim() : undefined;
	const providerSessionId =
		typeof target.providerSessionId === 'string' && target.providerSessionId.trim()
			? target.providerSessionId.trim()
			: undefined;

	if (!sessionId && !providerSessionId) {
		throw new Error('Either sessionId or providerSessionId is required');
	}

	const activeSession = resolveActiveSession({ cli: target.cli, sessionId, providerSessionId });
	if (!activeSession) {
		throw new Error('No running session matched the provided identifiers');
	}

	if (!activeSession.cancelRequested) {
		activeSession.cancelRequested = true;
		activeSession.cancelReason = 'Session cancelled by user';

		try {
			activeSession.process.kill('SIGTERM');
		} catch (error) {
			activeSession.cancelRequested = false;
			activeSession.cancelReason = null;
			throw new Error(`Failed to cancel session: ${error instanceof Error ? error.message : String(error)}`);
		}

		activeSession.cancelKillTimeout = setTimeout(() => {
			activeSession.cancelKillTimeout = null;

			if (activeSession.process.exitCode === null) {
				try {
					activeSession.process.kill('SIGKILL');
				} catch {}
			}
		}, SESSION_CANCEL_GRACE_PERIOD_MS);
	}

	return {
		cli: activeSession.cli,
		sessionId: activeSession.sessionId,
		providerSessionId: activeSession.providerSessionId,
		status: 'cancelled',
	};
}

function looksLikeMissingProviderSession(message: string): boolean {
	const normalized = message.toLowerCase();

	return (
		normalized.includes('no session with that id exists') ||
		normalized.includes('no session with this id exists') ||
		normalized.includes('session not found') ||
		normalized.includes('no conversation found') ||
		normalized.includes('could not find session')
	);
}

export async function resumeHeadlessCliSessionWithFallback(
	cli: SupportedCli,
	target: ResolvedResumeSessionTarget,
	prompt: string | undefined,
	workingDir: string,
	model?: string,
	streamCallback?: (data: StreamEvent) => void,
	sessionId?: string,
): Promise<HeadlessCliSession> {
	if (!target.providerSessionId) {
		if (!prompt) {
			throw new Error(
				`Cannot resume session '${target.sessionId}' because no provider session ID was captured and no new prompt was supplied`,
			);
		}

		return createHeadlessCliSession(cli, prompt, workingDir, model, streamCallback, sessionId);
	}

	const resumeMessages: string[] = [];
	const captureResumeEvent = (streamData: StreamEvent) => {
		resumeMessages.push(streamData.content);
		streamCallback?.(streamData);
	};

	try {
		return await resumeHeadlessCliSession(
			cli,
			target.providerSessionId,
			prompt,
			workingDir,
			model,
			captureResumeEvent,
			sessionId,
		);
	} catch (error) {
		if (!prompt) {
			throw error;
		}

		const combinedMessage = [error instanceof Error ? error.message : String(error), ...resumeMessages].join('\n');

		if (!looksLikeMissingProviderSession(combinedMessage)) {
			throw error;
		}

		return createHeadlessCliSession(cli, prompt, workingDir, model, streamCallback, sessionId);
	}
}

export function finalizeConduitSessionRun(
	cli: SupportedCli,
	captureHandle: ConduitSessionCaptureHandle,
	session: HeadlessCliSession,
): HeadlessSessionRunSuccessPayload {
	if (session.status === 'cancelled') {
		captureHandle.cancel();
	} else {
		captureHandle.complete();
	}

	return {
		success: true,
		provider: cli,
		sessionId: captureHandle.sessionId,
		status: session.status,
		output: session.output,
		error: session.error.length > 0 ? session.error : undefined,
	};
}

function buildCliCommand(cli: SupportedCli, options: CliSessionOptions): { command: string; args: string[] } {
	if (cli === 'claude') {
		const modelArgs = options.model ? ['--model', options.model] : [];
		if (options.providerSessionId) {
			const promptArgs = options.prompt ? [options.prompt] : [];
			return {
				command: 'claude',
				args: [
					'-p',
					'--verbose',
					'--resume',
					options.providerSessionId,
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
				...(options.isDangerous ? ['--dangerously-skip-permissions'] : []),
				'--output-format',
				'stream-json',
				validatePrompt(options.prompt || ''),
			],
		};
	}

	const modelArgs = options.model ? ['--model', options.model] : [];
	if (options.providerSessionId) {
		const promptArgs = options.prompt ? [options.prompt] : [];
		return {
			command: 'codex',
			args: [
				'exec',
				'resume',
				'--json',
				'--skip-git-repo-check',
				...modelArgs,
				options.providerSessionId,
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
			...(options.isDangerous ? ['--yolo'] : []),
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
			providerSessionId: options.providerSessionId || null,
			process: null,
			output: [],
			error: [],
			status: 'running',
		};

		if (options.providerSessionId) {
			streamCallback?.({ type: 'sessionId', content: options.providerSessionId });
		}

		const child = spawn(command.command, command.args, {
			cwd: options.workingDir,
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const activeSession: ActiveHeadlessCliSession = {
			cli,
			sessionId: options.sessionId || null,
			providerSessionId: options.providerSessionId || null,
			process: child,
			cancelRequested: false,
			cancelReason: null,
			cancelKillTimeout: null,
		};

		session.process = child;
		registerActiveSession(activeSession);

		let stdoutBuffer = '';
		let stderrBuffer = '';

		const processLine = (line: string, isStdout: boolean) => {
			if (!line.trim()) return;

			if (isStdout) {
				session.output.push(line);
			} else {
				session.error.push(line);
			}

			if (!session.providerSessionId) {
				const foundProviderSessionId = extractSessionId(line);
				if (foundProviderSessionId) {
					session.providerSessionId = foundProviderSessionId;
					attachProviderSessionId(activeSession, foundProviderSessionId);
					streamCallback?.({ type: 'sessionId', content: foundProviderSessionId });
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
			unregisterActiveSession(activeSession);

			if (stdoutBuffer.trim()) {
				processLine(stdoutBuffer, true);
			}
			if (stderrBuffer.trim()) {
				processLine(stderrBuffer, false);
			}

			if (activeSession.cancelRequested) {
				session.status = 'cancelled';
				streamCallback?.({
					type: 'cancelled',
					content: activeSession.cancelReason || 'Session cancelled by user',
				});
				resolve(session);
				return;
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
			unregisterActiveSession(activeSession);

			if (activeSession.cancelRequested) {
				session.status = 'cancelled';
				streamCallback?.({
					type: 'cancelled',
					content: activeSession.cancelReason || 'Session cancelled by user',
				});
				resolve(session);
				return;
			}

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
	sessionId?: string,
	isDangerous = false,
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

	return executeHeadlessCliSession(
		cli,
		{ prompt, workingDir, model, streamCallback, sessionId, isDangerous },
		`Failed to start ${cli}`,
	);
}

export async function resumeHeadlessCliSession(
	cli: SupportedCli,
	providerSessionId: string,
	prompt: string | undefined,
	workingDir: string,
	model?: string,
	streamCallback?: (data: StreamEvent) => void,
	sessionId?: string,
): Promise<HeadlessCliSession> {
	try {
		prompt = normalizeResumePrompt(prompt);
		workingDir = validateWorkingDirectory(workingDir);
		await ensureCliAvailable(cli, workingDir);

		if (!providerSessionId || !isValidUUID(providerSessionId)) {
			throw new Error('Invalid provider session ID format (must be a valid UUID)');
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Validation error';
		streamCallback?.({ type: 'error', content: errorMsg });
		throw error;
	}

	return executeHeadlessCliSession(
		cli,
		{ providerSessionId, prompt, workingDir, model, streamCallback, sessionId },
		`Failed to resume ${cli} session`,
	);
}

interface SocketSessionEventContext {
	provider: SupportedCli;
	sessionId: string;
}

function emitSessionEvent(
	socket: Socket,
	eventPrefix: string,
	streamData: StreamEvent,
	context: SocketSessionEventContext,
) {
	const eventPayload = {
		provider: context.provider,
		sessionId: context.sessionId,
	};

	switch (streamData.type) {
		case 'sessionId':
			break;
		case 'stdout':
			socket.emit(`${eventPrefix}:output`, { ...eventPayload, data: streamData.content });
			break;
		case 'stderr':
			socket.emit(`${eventPrefix}:error:output`, { ...eventPayload, data: streamData.content });
			break;
		case 'complete':
			socket.emit(`${eventPrefix}:complete`, { ...eventPayload, message: streamData.content });
			break;
		case 'error':
			socket.emit(`${eventPrefix}:error`, { ...eventPayload, error: streamData.content });
			break;
		case 'cancelled':
			socket.emit(`${eventPrefix}:cancelled`, { ...eventPayload, message: streamData.content });
			break;
	}
}

interface UnifiedSocketSessionCreatePayload extends SocketSessionPayload {
	provider?: SupportedCli;
}

interface UnifiedSocketSessionResumePayload extends SocketSessionPayload {
	sessionId?: string;
}

interface UnifiedSocketSessionCancelPayload {
	sessionId?: string;
}

function emitSessionError(
	socket: Socket,
	eventPrefix: string,
	error: unknown,
	context?: Partial<SocketSessionEventContext>,
): void {
	socket.emit(`${eventPrefix}:error`, {
		provider: context?.provider,
		sessionId: context?.sessionId,
		error: error instanceof Error ? error.message : 'Unknown error occurred',
	});
}

function persistConduitStreamEvent(captureContext: ConduitCaptureContext, streamData: StreamEvent): void {
	try {
		captureConduitStreamEvent(captureContext, streamData);
	} catch (error) {
		console.error('Failed to persist conduit stream event:', error);
	}
}

function finalizeSocketCapture(
	captureContext: ConduitCaptureContext | null,
	session: HeadlessCliSession,
): void {
	if (!captureContext) {
		return;
	}

	if (session.status === 'cancelled') {
		cancelConduitSessionCapture(captureContext);
		return;
	}

	completeConduitSessionCapture(captureContext);
}

export function handleUnifiedSessionCancel(socket: Socket, eventPrefix = 'session') {
	socket.on(`${eventPrefix}:cancel`, (data: UnifiedSocketSessionCancelPayload = {}) => {
		const requestedSessionId = data.sessionId;

		try {
			if (!requestedSessionId || typeof requestedSessionId !== 'string') {
				socket.emit(`${eventPrefix}:cancel:update`, {
					success: false,
					error: 'sessionId is required and must be a string',
				});
				return;
			}

			if (!isValidUUID(requestedSessionId)) {
				socket.emit(`${eventPrefix}:cancel:update`, {
					success: false,
					sessionId: requestedSessionId,
					error: 'Invalid session ID format (must be a valid UUID)',
				});
				return;
			}

			const resolvedSession = resolveConduitSession(requestedSessionId);
			const result = cancelHeadlessCliSession({
				cli: resolvedSession.cli,
				sessionId: resolvedSession.sessionId,
			});

			socket.emit(`${eventPrefix}:cancel:update`, {
				success: true,
				provider: result.cli,
				sessionId: resolvedSession.sessionId,
				status: result.status,
			});
		} catch (error) {
			socket.emit(`${eventPrefix}:cancel:update`, {
				success: false,
				sessionId: typeof requestedSessionId === 'string' ? requestedSessionId : undefined,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			});
		}
	});
}

export function handleUnifiedSessionCreate(socket: Socket, eventPrefix = 'session') {
	socket.on(`${eventPrefix}:create`, async (data: UnifiedSocketSessionCreatePayload) => {
		let captureContext: ConduitCaptureContext | null = null;
		let cli: SupportedCli | null = null;

		try {
			const { prompt, context, agentId, workspaceId, pipelineId } = data;

			if (!isSupportedCli(data.provider)) {
				socket.emit(`${eventPrefix}:error`, {
					error: "provider is required and must be either 'claude' or 'codex'",
				});
				return;
			}

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

			if (data.isDangerous !== undefined && typeof data.isDangerous !== 'boolean') {
				socket.emit(`${eventPrefix}:error`, { error: 'isDangerous must be a boolean' });
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

			cli = data.provider;
			captureContext = startConduitSessionCapture(
				cli,
				{ agentId, workspaceId, pipelineId },
				prompt,
				data.model,
				undefined,
				context,
			);

			const sessionContext = {
				provider: cli,
				sessionId: captureContext.sessionId,
			};

			socket.emit(`${eventPrefix}:started`, {
				...sessionContext,
				message: `${cli} session starting...`,
			});

			const session = await createHeadlessCliSession(
				cli,
				prompt,
				workspace.path,
				data.model,
				(streamData) => {
					emitSessionEvent(socket, eventPrefix, streamData, sessionContext);
					if (captureContext) {
						persistConduitStreamEvent(captureContext, streamData);
					}
				},
				captureContext.sessionId,
				data.isDangerous ?? false,
			);

			finalizeSocketCapture(captureContext, session);
		} catch (error) {
			if (captureContext) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				failConduitSessionCapture(captureContext, errorMessage);
			}

			emitSessionError(socket, eventPrefix, error, {
				provider: cli ?? undefined,
				sessionId: captureContext?.sessionId,
			});
		}
	});
}

export function handleUnifiedSessionResume(socket: Socket, eventPrefix = 'session') {
	socket.on(`${eventPrefix}:resume`, async (data: UnifiedSocketSessionResumePayload) => {
		let captureContext: ConduitCaptureContext | null = null;
		let cli: SupportedCli | null = null;
		const requestedSessionId = data.sessionId;

		try {
			const { prompt, context, agentId, workspaceId, pipelineId } = data;

			if (!requestedSessionId || typeof requestedSessionId !== 'string') {
				socket.emit(`${eventPrefix}:error`, { error: 'sessionId is required and must be a string' });
				return;
			}

			if (!isValidUUID(requestedSessionId)) {
				socket.emit(`${eventPrefix}:error`, {
					sessionId: requestedSessionId,
					error: 'Invalid session ID format (must be a valid UUID)',
				});
				return;
			}

			if (prompt !== undefined && typeof prompt !== 'string') {
				socket.emit(`${eventPrefix}:error`, {
					sessionId: requestedSessionId,
					error: 'Prompt must be a string when provided',
				});
				return;
			}

			const normalizedPrompt = normalizeResumePrompt(prompt);

			if (data.model !== undefined && typeof data.model !== 'string') {
				socket.emit(`${eventPrefix}:error`, {
					sessionId: requestedSessionId,
					error: 'Model must be a string',
				});
				return;
			}

			if (context !== undefined && typeof context !== 'string') {
				socket.emit(`${eventPrefix}:error`, {
					sessionId: requestedSessionId,
					error: 'Context must be a string',
				});
				return;
			}

			validateConduitSessionRequestMetadata({ agentId, workspaceId, pipelineId });
			const { workspace, error: workspaceError } = resolveReadyWorkspaceForNewWork(workspaceId);
			if (!workspace || workspaceError) {
				socket.emit(`${eventPrefix}:error`, {
					sessionId: requestedSessionId,
					error: workspaceError || 'Workspace is not ready for new work',
				});
				return;
			}

			const resolvedSession = resolveConduitSession(requestedSessionId);
			cli = resolvedSession.cli;
			const resumeTarget = {
				providerSessionId: resolvedSession.providerSessionId,
				sessionId: resolvedSession.sessionId,
			};

			captureContext = startConduitSessionCapture(
				cli,
				{ agentId, workspaceId, pipelineId },
				normalizedPrompt,
				data.model,
				resumeTarget.providerSessionId || undefined,
				context,
				resumeTarget.sessionId,
			);

			const sessionContext = {
				provider: cli,
				sessionId: captureContext.sessionId,
			};

			socket.emit(`${eventPrefix}:started`, {
				...sessionContext,
				message: `Resuming ${cli} session...`,
			});

			const session = await resumeHeadlessCliSessionWithFallback(
				cli,
				resumeTarget,
				normalizedPrompt,
				workspace.path,
				data.model,
				(streamData) => {
					emitSessionEvent(socket, eventPrefix, streamData, sessionContext);
					if (captureContext) {
						persistConduitStreamEvent(captureContext, streamData);
					}
				},
				captureContext.sessionId,
			);

			finalizeSocketCapture(captureContext, session);
		} catch (error) {
			if (captureContext) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				failConduitSessionCapture(captureContext, errorMessage);
			}

			emitSessionError(socket, eventPrefix, error, {
				provider: cli ?? undefined,
				sessionId: typeof requestedSessionId === 'string' ? requestedSessionId : captureContext?.sessionId,
			});
		}
	});
}
