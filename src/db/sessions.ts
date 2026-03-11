import type { Context } from 'hono';
import {
	getConduitSessionById,
	getConduitSessionEvents,
	listConduitSessions,
	type ConduitProvider,
	type ConduitSessionStatus,
} from './sqlite';

const VALID_PROVIDERS: ConduitProvider[] = ['claude', 'codex'];
const VALID_SESSION_STATUSES: ConduitSessionStatus[] = [
	'created',
	'running',
	'completed',
	'error',
	'timed_out',
	'cancelled',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseIntegerQuery(rawValue: string | undefined, fallback: number): number {
	if (!rawValue) {
		return fallback;
	}

	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return parsed;
}

function isValidUUID(value: string): boolean {
	return UUID_PATTERN.test(value);
}

export async function getSessions(c: Context) {
	try {
		const agentId = c.req.query('agentId');
		const pipelineId = c.req.query('pipelineId');
		const workspaceId = c.req.query('workspaceId');
		const provider = c.req.query('provider');
		const status = c.req.query('status');
		const limit = parseIntegerQuery(c.req.query('limit'), 50);
		const offset = parseIntegerQuery(c.req.query('offset'), 0);

		if (agentId && !isValidUUID(agentId)) {
			return c.json({ success: false, error: 'Invalid agentId format (must be a valid UUID)' }, 400);
		}

		if (pipelineId && !isValidUUID(pipelineId)) {
			return c.json({ success: false, error: 'Invalid pipelineId format (must be a valid UUID)' }, 400);
		}

		if (provider && !VALID_PROVIDERS.includes(provider as ConduitProvider)) {
			return c.json({ success: false, error: "Invalid provider (must be 'claude' or 'codex')" }, 400);
		}

		if (status && !VALID_SESSION_STATUSES.includes(status as ConduitSessionStatus)) {
			return c.json({ success: false, error: 'Invalid status filter' }, 400);
		}

		if (limit <= 0) {
			return c.json({ success: false, error: 'limit must be greater than 0' }, 400);
		}

		if (offset < 0) {
			return c.json({ success: false, error: 'offset must be 0 or greater' }, 400);
		}

		const data = listConduitSessions({
			agentId: agentId || undefined,
			pipelineId: pipelineId || undefined,
			workspaceId: workspaceId || undefined,
			provider: provider as ConduitProvider | undefined,
			status: status as ConduitSessionStatus | undefined,
			limit,
			offset,
		});
		const sessions = data.sessions.map(({ providerSessionId: _providerSessionId, ...session }) => session);

		return c.json(
			{
				success: true,
				data: sessions,
				pagination: {
					total: data.total,
					limit: data.limit,
					offset: data.offset,
				},
			},
			200,
		);
	} catch (error) {
		console.error('Failed to read sessions:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}

export async function getSession(c: Context) {
	try {
		const sessionId = c.req.param('sessionId');
		if (!sessionId || typeof sessionId !== 'string') {
			return c.json({ success: false, error: 'sessionId is required' }, 400);
		}

		if (!isValidUUID(sessionId)) {
			return c.json({ success: false, error: 'Invalid sessionId format (must be a valid UUID)' }, 400);
		}

		const session = getConduitSessionById(sessionId);
		if (!session) {
			return c.json({ success: false, error: 'Session not found' }, 404);
		}

		const events = getConduitSessionEvents(sessionId);
		const { providerSessionId: _providerSessionId, ...publicSession } = session;
		const publicEvents = events
			.filter((event) => event.eventType !== 'sessionId')
			.map(({ sessionId: _eventSessionId, ...event }) => event);
		return c.json(
			{
				success: true,
				data: {
					session: publicSession,
					events: publicEvents,
				},
			},
			200,
		);
	} catch (error) {
		console.error('Failed to read session:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}
