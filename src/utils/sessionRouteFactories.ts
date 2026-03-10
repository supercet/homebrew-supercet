import { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
	beginConduitSessionCapture,
	cancelHeadlessCliSession,
	createHeadlessCliSession,
	finalizeConduitSessionRun,
	isValidUUID,
	resolveResumeSessionTarget,
	resolveSupportedCli,
	resumeHeadlessCliSessionWithFallback,
	validateConduitSessionRequestMetadata,
	type ConduitSessionCaptureHandle,
	type ConduitSessionRequestMetadata,
	type ResolvedResumeSessionTarget,
	type SupportedCli,
} from './headlessCliHelpers';
import { resolveReadyWorkspaceForNewWork } from './workspaceReadiness';

interface SessionRouteFactoryOptions {
	defaultCli: SupportedCli;
	allowCliOverride?: boolean;
}

interface ValidatedSessionRequest {
	cli: SupportedCli;
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

function getRouteLogLabel(options: SessionRouteFactoryOptions): string {
	return options.allowCliOverride ? 'CLI' : options.defaultCli === 'codex' ? 'Codex' : 'Claude';
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

function validateSessionId(sessionId: string | undefined): string {
	if (!sessionId || typeof sessionId !== 'string') {
		throw new SessionRouteError('Session ID is required and must be a string', 400);
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

function resolveRouteCli(bodyCli: unknown, options: SessionRouteFactoryOptions): SupportedCli {
	if (!options.allowCliOverride) {
		return options.defaultCli;
	}

	try {
		return resolveSupportedCli(bodyCli, options.defaultCli);
	} catch (error) {
		throw new SessionRouteError(getErrorMessage(error, 'Invalid cli'), 400);
	}
}

function validateSharedSessionRequest(
	body: Record<string, unknown>,
	options: SessionRouteFactoryOptions,
): ValidatedSessionRequest {
	const model = readOptionalString(body.model, 'Model must be a string');
	const context = readOptionalString(body.context, 'Context must be a string');
	const metadata = validateRequestMetadata(body);

	return {
		cli: resolveRouteCli(body.cli, options),
		context,
		metadata,
		model,
		workspacePath: resolveWorkspacePath(metadata.workspaceId),
	};
}

function validateCreateSessionRequest(
	body: Record<string, unknown>,
	options: SessionRouteFactoryOptions,
): ValidatedCreateSessionRequest {
	return {
		...validateSharedSessionRequest(body, options),
		isDangerous: readOptionalBoolean(body.isDangerous, 'isDangerous must be a boolean') ?? false,
		prompt: readRequiredString(body.prompt, 'Prompt is required and must be a string'),
	};
}

function validateResumeSessionRequest(
	sessionIdParam: string | undefined,
	body: Record<string, unknown>,
	options: SessionRouteFactoryOptions,
): ValidatedResumeSessionRequest {
	const sessionId = validateSessionId(sessionIdParam);
	const request = validateSharedSessionRequest(body, options);
	const prompt = readOptionalString(body.prompt, 'Prompt must be a string when provided');

	let resumeTarget: ResolvedResumeSessionTarget;
	try {
		resumeTarget = resolveResumeSessionTarget(request.cli, sessionId);
	} catch (error) {
		throw new SessionRouteError(getErrorMessage(error, 'Invalid session ID'), 400);
	}

	return {
		...request,
		prompt,
		resumeTarget,
	};
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

export function createCancelSessionRoute(cli: SupportedCli) {
	return async function cancelSession(c: Context) {
		try {
			const sessionId = validateSessionId(c.req.param('sessionId'));
			const result = cancelHeadlessCliSession({ cli, sessionId });
			return c.json({ success: true, ...result }, 200);
		} catch (error) {
			const message = getErrorMessage(error, 'Unknown error occurred');
			return c.json({ success: false, error: message }, getCancelErrorStatus(message));
		}
	};
}

export function createCreateSessionRoute(options: SessionRouteFactoryOptions) {
	return async function createSession(c: Context) {
		let captureHandle: ConduitSessionCaptureHandle | null = null;

		try {
			const request = validateCreateSessionRequest(normalizeRequestBody(await c.req.json()), options);

			captureHandle = beginConduitSessionCapture(
				request.cli,
				request.metadata,
				request.prompt,
				request.model,
				undefined,
				request.context,
			);

			const session = await createHeadlessCliSession(
				request.cli,
				request.prompt,
				request.workspacePath,
				request.model,
				(streamData) => {
					captureHandle?.handleStreamEvent(streamData);
				},
				captureHandle.conduitSessionId,
				request.isDangerous,
			);

			return c.json(finalizeConduitSessionRun(request.cli, captureHandle, session));
		} catch (error) {
			if (error instanceof SessionRouteError) {
				return c.json({ error: error.message }, error.status);
			}

			const message = failCapture(captureHandle, error);
			console.error(`Error creating ${getRouteLogLabel(options)} session:`, error);
			return c.json({ success: false, error: message }, 500);
		}
	};
}

export function createResumeSessionRoute(options: SessionRouteFactoryOptions) {
	return async function resumeSession(c: Context) {
		let captureHandle: ConduitSessionCaptureHandle | null = null;

		try {
			const request = validateResumeSessionRequest(
				c.req.param('sessionId'),
				normalizeRequestBody(await c.req.json()),
				options,
			);

			captureHandle = beginConduitSessionCapture(
				request.cli,
				request.metadata,
				request.prompt,
				request.model,
				request.resumeTarget.providerSessionId || undefined,
				request.context,
				request.resumeTarget.conduitSessionId || undefined,
			);

			const session = await resumeHeadlessCliSessionWithFallback(
				request.cli,
				request.resumeTarget,
				request.prompt,
				request.workspacePath,
				request.model,
				(streamData) => {
					captureHandle?.handleStreamEvent(streamData);
				},
				captureHandle.conduitSessionId,
			);

			return c.json(finalizeConduitSessionRun(request.cli, captureHandle, session));
		} catch (error) {
			if (error instanceof SessionRouteError) {
				return c.json({ error: error.message }, error.status);
			}

			const message = failCapture(captureHandle, error);
			console.error(`Error resuming ${getRouteLogLabel(options)} session:`, error);
			return c.json({ success: false, error: message }, 500);
		}
	};
}
