import { createCreateSessionRoute } from '../utils/sessionRouteFactories';

export const createCodexSessionRoute = createCreateSessionRoute({
	defaultCli: 'codex',
});
