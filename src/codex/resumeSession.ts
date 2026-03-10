import { Context } from 'hono';
import {
	beginConduitSessionCapture,
	finalizeConduitSessionRun,
	isValidUUID,
	resolveResumeSessionTarget,
	resumeHeadlessCliSessionWithFallback,
	validateConduitSessionRequestMetadata,
	type ConduitSessionCaptureHandle,
} from '../utils/headlessCliHelpers';
import { resolveReadyWorkspaceForNewWork } from '../utils/workspaceReadiness';

/**
 * REST API handler to resume an existing Codex session
 * POST /api/codex/session/:sessionId/resume
 * Body: {
 *   prompt?: string,
 *   context?: string,
 *   model?: string,
 *   agentId: string,
 *   workspaceId: string,
 *   pipelineId?: string
 * }
 */
export async function resumeCodexSessionRoute(c: Context) {
	let captureHandle: ConduitSessionCaptureHandle | null = null;

	try {
		const sessionId = c.req.param('sessionId');
		const body = await c.req.json();
		const { prompt, context, model, agentId, workspaceId, pipelineId } = body;

		if (!sessionId || typeof sessionId !== 'string') {
			return c.json({ error: 'Session ID is required and must be a string' }, 400);
		}

		if (prompt !== undefined && typeof prompt !== 'string') {
			return c.json({ error: 'Prompt must be a string when provided' }, 400);
		}

		if (model !== undefined && typeof model !== 'string') {
			return c.json({ error: 'Model must be a string' }, 400);
		}

		if (context !== undefined && typeof context !== 'string') {
			return c.json({ error: 'Context must be a string' }, 400);
		}

		try {
			validateConduitSessionRequestMetadata({ agentId, workspaceId, pipelineId });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : 'Invalid session metadata' }, 400);
		}

		if (!isValidUUID(sessionId)) {
			return c.json({ error: 'Invalid session ID format (must be a valid UUID)' }, 400);
		}

		const { workspace, error: workspaceError } = resolveReadyWorkspaceForNewWork(workspaceId);
		if (!workspace || workspaceError) {
			return c.json({ error: workspaceError || 'Workspace is not ready for new work' }, 400);
		}

		let resumeTarget: ReturnType<typeof resolveResumeSessionTarget>;
		try {
			resumeTarget = resolveResumeSessionTarget('codex', sessionId);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : 'Invalid session ID' }, 400);
		}

		captureHandle = beginConduitSessionCapture(
			'codex',
			{ agentId, workspaceId, pipelineId },
			prompt,
			model,
			resumeTarget.providerSessionId || undefined,
			context,
			resumeTarget.conduitSessionId || undefined,
		);
		const session = await resumeHeadlessCliSessionWithFallback(
			'codex',
			resumeTarget,
			prompt,
			workspace.path,
			model,
			(streamData) => {
				captureHandle?.handleStreamEvent(streamData);
			},
			captureHandle.conduitSessionId,
		);
		return c.json(finalizeConduitSessionRun('codex', captureHandle, session));
	} catch (error) {
		if (captureHandle) {
			const message = error instanceof Error ? error.message : 'Unknown error occurred';
			captureHandle.fail(message);
		}

		console.error('Error resuming Codex session:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}
