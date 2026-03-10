import { Context } from 'hono';
import { cancelHeadlessCliSession, isValidUUID } from '../utils/headlessCliHelpers';

/**
 * REST API handler to cancel an active Codex session by provider or conduit session id.
 * POST /api/codex/session/:sessionId/cancel
 */
export async function cancelCodexSessionRoute(c: Context) {
	try {
		const sessionId = c.req.param('sessionId');

		if (!sessionId || typeof sessionId !== 'string') {
			return c.json({ success: false, error: 'Session ID is required and must be a string' }, 400);
		}

		if (!isValidUUID(sessionId)) {
			return c.json({ success: false, error: 'Invalid session ID format (must be a valid UUID)' }, 400);
		}

		const result = cancelHeadlessCliSession({ cli: 'codex', sessionId });
		return c.json({ success: true, ...result }, 200);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error occurred';
		const status =
			message === 'No running session matched the provided identifiers'
				? 404
				: message.includes('belongs to')
					? 400
					: 500;
		return c.json({ success: false, error: message }, status);
	}
}
