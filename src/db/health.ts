import type { Context } from 'hono';
import { getSQLiteHealth } from './sqlite';

export async function getDbHealth(c: Context) {
	const data = getSQLiteHealth();
	return c.json({ success: data.healthy, data }, data.healthy ? 200 : 503);
}
