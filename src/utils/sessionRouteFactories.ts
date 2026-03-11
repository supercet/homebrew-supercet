import { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
	beginConduitSessionCapture,
	cancelHeadlessProviderSession,
	createHeadlessProviderSession,
	ensureProviderCapabilityForSession,
	finalizeConduitSessionRun,
	isSupportedProvider,
	isValidUUID,
	resolveConduitSession,
	resumeHeadlessProviderSessionWithFallback,
	validateConduitSessionRequestMetadata,
	type ConduitSessionCaptureHandle,
	type ConduitSessionRequestMetadata,
	type ResolvedResumeSessionTarget,
	type SupportedProvider,
} from './headlessProviderHelpers';
import { resolveReadyWorkspaceForNewWork } from './workspaceReadiness';

interface ValidatedSessionRequest {
	provider: SupportedProvider;
	context?: string;
	metadata: ConduitSessionRequestMetadata;
	model?: string;
	workspacePath: string;
}

interface ValidatedCreateSessionRequest extends ValidatedSessionRequest {
	isDangerous: boolean;
	prompt: string;
}

interface ValidatedResumeSessionRequest extends ValidatedSessionRequest {
	prompt?: string;
	resumeTarget: ResolvedResumeSessionTarget;
}

class SessionRouteError extends Error {
	constructor(
		message: string,
		readonly status: ContentfulStatusCode,
	) {
		super(message);
	}
}

function getErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function normalizeRequestBody(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return {};
	}

	return body as Record<string, unknown>;
}

function readRequiredString(value: unknown, errorMessage: string): string {
	if (!value || typeof value !== 'string') {
		throw new SessionRouteError(errorMessage, 400);
	}

	return value;
}

function readOptionalString(value: unknown, errorMessage: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'string') {
		throw new SessionRouteError(errorMessage, 400);
	}

	return value;
}

function readOptionalBoolean(value: unknown, errorMessage: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'boolean') {
		throw new SessionRouteError(errorMessage, 400);
	}

	return value;
}

function validateExternalSessionId(sessionId: string | undefined): string {
	if (!sessionId || typeof sessionId !== 'string') {
		throw new SessionRouteError('sessionId is required and must be a string', 400);
	}

	if (!isValidUUID(sessionId)) {
		throw new SessionRouteError('Invalid session ID format (must be a valid UUID)', 400);
	}

	return sessionId;
}

function validateRequestMetadata(body: Record<string, unknown>): ConduitSessionRequestMetadata {
	const metadata = {
		agentId: body.agentId as string,
		workspaceId: body.workspaceId as string,
		pipelineId: body.pipelineId as string | undefined,
	};

	try {
		validateConduitSessionRequestMetadata(metadata);
	} catch (error) {
		throw new SessionRouteError(getErrorMessage(error, 'Invalid session metadata'), 400);
	}

	return metadata;
}

function resolveWorkspacePath(workspaceId: string): string {
	const { workspace, error } = resolveReadyWorkspaceForNewWork(workspaceId);
	if (!workspace || error) {
		throw new SessionRouteError(error || 'Workspace is not ready for new work', 400);
	}

	return workspace.path;
}

function readRequiredProvider(value: unknown): SupportedProvider {
	if (!isSupportedProvider(value)) {
		throw new SessionRouteError("provider is required and must be either 'claude' or 'codex'", 400);
	}

	return value;
}

function validateUnifiedCreateSessionRequest(body: Record<string, unknown>): ValidatedCreateSessionRequest {
	const metadata = validateRequestMetadata(body);

	return {
		provider: readRequiredProvider(body.provider),
		context: readOptionalString(body.context, 'Context must be a string'),
		metadata,
		model: readOptionalString(body.model, 'Model must be a string'),
		workspacePath: resolveWorkspacePath(metadata.workspaceId),
		isDangerous: readOptionalBoolean(body.isDangerous, 'isDangerous must be a boolean') ?? false,
		prompt: readRequiredString(body.prompt, 'Prompt is required and must be a string'),
	};
}

function validateUnifiedResumeSessionRequest(
	sessionIdParam: string | undefined,
	body: Record<string, unknown>,
): ValidatedResumeSessionRequest {
	const sessionId = validateExternalSessionId(sessionIdParam);
	const metadata = validateRequestMetadata(body);

	let resolvedSession: ReturnType<typeof resolveConduitSession>;
	try {
		resolvedSession = resolveConduitSession(sessionId);
	} catch (error) {
		throw new SessionRouteError(getErrorMessage(error, 'Invalid session ID'), 404);
	}

	return {
		provider: resolvedSession.provider,
		context: readOptionalString(body.context, 'Context must be a string'),
		metadata,
		model: readOptionalString(body.model, 'Model must be a string'),
		workspacePath: resolveWorkspacePath(metadata.workspaceId),
		prompt: readOptionalString(body.prompt, 'Prompt must be a string when provided'),
		resumeTarget: {
			providerSessionId: resolvedSession.providerSessionId,
			sessionId: resolvedSession.sessionId,
		},
	};
}

function getSessionRunErrorStatus(message: string): ContentfulStatusCode {
	if (message.includes('already has an active run')) {
		return 409;
	}

	if (
		message.includes('provider executable is not available on this system') ||
		message.includes('command not found')
	) {
		return 503;
	}

	return 500;
}

function getCancelErrorStatus(message: string): ContentfulStatusCode {
	if (message === 'No running session matched the provided identifiers') {
		return 404;
	}

	if (message.includes('belongs to')) {
		return 400;
	}

	return 500;
}

function failCapture(captureHandle: ConduitSessionCaptureHandle | null, error: unknown): string {
	const message = getErrorMessage(error, 'Unknown error occurred');
	captureHandle?.fail(message);
	return message;
}

export function createUnifiedCreateSessionRoute() {
	return async function createSession(c: Context) {
		let captureHandle: ConduitSessionCaptureHandle | null = null;

		try {
			const request = validateUnifiedCreateSessionRequest(normalizeRequestBody(await c.req.json()));
			await ensureProviderCapabilityForSession(request.provider, request.workspacePath);

			captureHandle = beginConduitSessionCapture(
				request.provider,
				request.metadata,
				request.prompt,
				request.model,
				undefined,
				request.context,
			);

			const session = await createHeadlessProviderSession(
				request.provider,
				request.prompt,
				request.workspacePath,
				request.model,
				(streamData) => {
					captureHandle?.handleStreamEvent(streamData);
				},
				captureHandle.sessionId,
				request.isDangerous,
			);

			return c.json(finalizeConduitSessionRun(request.provider, captureHandle, session));
		} catch (error) {
			if (error instanceof SessionRouteError) {
				return c.json({ error: error.message }, error.status);
			}

			const message = failCapture(captureHandle, error);
			console.error('Error creating session:', error);
			return c.json({ success: false, error: message }, getSessionRunErrorStatus(message));
		}
	};
}

export function createUnifiedResumeSessionRoute() {
	return async function resumeSession(c: Context) {
		let captureHandle: ConduitSessionCaptureHandle | null = null;

		try {
			const request = validateUnifiedResumeSessionRequest(
				c.req.param('sessionId'),
				normalizeRequestBody(await c.req.json()),
			);
			await ensureProviderCapabilityForSession(request.provider, request.workspacePath);

			captureHandle = beginConduitSessionCapture(
				request.provider,
				request.metadata,
				request.prompt,
				request.model,
				request.resumeTarget.providerSessionId || undefined,
				request.context,
				request.resumeTarget.sessionId || undefined,
			);

			const session = await resumeHeadlessProviderSessionWithFallback(
				request.provider,
				request.resumeTarget,
				request.prompt,
				request.workspacePath,
				request.model,
				(streamData) => {
					captureHandle?.handleStreamEvent(streamData);
				},
				captureHandle.sessionId,
			);

			return c.json(finalizeConduitSessionRun(request.provider, captureHandle, session));
		} catch (error) {
			if (error instanceof SessionRouteError) {
				return c.json({ error: error.message }, error.status);
			}

			const message = failCapture(captureHandle, error);
			console.error('Error resuming session:', error);
			return c.json({ success: false, error: message }, getSessionRunErrorStatus(message));
		}
	};
}

export function createUnifiedCancelSessionRoute() {
	return async function cancelSession(c: Context) {
		try {
			const sessionId = validateExternalSessionId(c.req.param('sessionId'));
			const resolvedSession = resolveConduitSession(sessionId);
			const result = cancelHeadlessProviderSession({
				provider: resolvedSession.provider,
				sessionId: resolvedSession.sessionId,
			});

			return c.json(
				{
					success: true,
					provider: result.provider,
					sessionId: resolvedSession.sessionId,
					status: result.status,
				},
				200,
			);
		} catch (error) {
			const message = getErrorMessage(error, 'Unknown error occurred');
			const status = message.startsWith('Unknown session ID')
				? 404
				: message === 'sessionId is required and must be a string' ||
					  message === 'Invalid session ID format (must be a valid UUID)'
					? 400
					: getCancelErrorStatus(message);
			return c.json({ success: false, error: message }, status);
		}
	};
}
