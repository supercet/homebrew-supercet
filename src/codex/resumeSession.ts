import { createResumeSessionRoute } from '../utils/sessionRouteFactories';

export const resumeCodexSessionRoute = createResumeSessionRoute({
	defaultCli: 'codex',
});
