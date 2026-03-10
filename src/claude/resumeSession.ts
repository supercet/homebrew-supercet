import { createResumeSessionRoute } from '../utils/sessionRouteFactories';

export const resumeSession = createResumeSessionRoute({
	defaultCli: 'claude',
	allowCliOverride: true,
});
