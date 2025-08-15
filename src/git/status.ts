import { gitOperations } from '../utils/gitHelpers';
import type { Context } from 'hono';

export async function getStatus(c: Context) {
	try {
		const status = await gitOperations.status();

		return c.json(status);
	} catch (e) {
		console.error(`exec error : ${e}`);
		return c.json({ error: 'Failed to get status' }, 500);
	}
}
