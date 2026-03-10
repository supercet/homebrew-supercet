import { createCreateSessionRoute } from '../utils/sessionRouteFactories';

export const createSession = createCreateSessionRoute({
	defaultCli: 'claude',
	allowCliOverride: true,
});
