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

export async function getConduitSessions(c: Context) {
	try {
		const agentId = c.req.query('agentId');
		const pipelineId = c.req.query('pipelineId');
		const workspaceId = c.req.query('workspaceId');
		const provider = c.req.query('provider');
		const providerSessionId = c.req.query('providerSessionId');
		const status = c.req.query('status');
		const limit = parseIntegerQuery(c.req.query('limit'), 50);
		const offset = parseIntegerQuery(c.req.query('offset'), 0);

		if (agentId && !isValidUUID(agentId)) {
			return c.json({ success: false, error: 'Invalid agentId format (must be a valid UUID)' }, 400);
		}

		if (pipelineId && !isValidUUID(pipelineId)) {
			return c.json({ success: false, error: 'Invalid pipelineId format (must be a valid UUID)' }, 400);
		}

		if (providerSessionId && !isValidUUID(providerSessionId)) {
			return c.json({ success: false, error: 'Invalid providerSessionId format (must be a valid UUID)' }, 400);
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
			providerSessionId: providerSessionId || undefined,
			status: status as ConduitSessionStatus | undefined,
			limit,
			offset,
		});

		return c.json(
			{
				success: true,
				data: data.sessions,
				pagination: {
					total: data.total,
					limit: data.limit,
					offset: data.offset,
				},
			},
			200,
		);
	} catch (error) {
		console.error('Failed to read conduit sessions:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}

export async function getConduitSession(c: Context) {
	try {
		const conduitSessionId = c.req.param('conduitSessionId');
		if (!conduitSessionId || typeof conduitSessionId !== 'string') {
			return c.json({ success: false, error: 'conduitSessionId is required' }, 400);
		}

		if (!isValidUUID(conduitSessionId)) {
			return c.json({ success: false, error: 'Invalid conduitSessionId format (must be a valid UUID)' }, 400);
		}

		const session = getConduitSessionById(conduitSessionId);
		if (!session) {
			return c.json({ success: false, error: 'Conduit session not found' }, 404);
		}

		const events = getConduitSessionEvents(conduitSessionId);
		return c.json({ success: true, data: { session, events } }, 200);
	} catch (error) {
		console.error('Failed to read conduit session:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}
