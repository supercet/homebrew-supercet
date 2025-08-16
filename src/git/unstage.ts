import { gitOperations } from '../utils/gitHelpers';
import type { Context } from 'hono';

type UnStageReqBody = {
	files: string[];
};

export async function postUnstage(c: Context) {
	try {
		const data: UnStageReqBody = await c.req.json();

		if (data?.files?.length) {
			try {
				await gitOperations.unstage(data.files);

				return c.json({}, 200);
			} catch (e) {
				console.error('failed git reset', e);
				return c.json({ error: 'Failed to unstage files' }, 500);
			}
		} else {
			return c.json({ error: 'No files provided' }, 400);
		}
	} catch (e) {
		console.error(`unstage error : ${e}`);
		return c.json({ error: 'Failed to unstage files' }, 500);
	}
}
