import { createServer } from 'http';

// Check if port is available
export function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(port, () => {
			server.close();
			resolve(true);
		});
		server.on('error', () => {
			resolve(false);
		});
	});
}

// Version check function
export async function checkForUpdates(): Promise<void> {
	const currentVersion = process.env.SUPERCET_VERSION;

	if (!currentVersion) {
		console.warn('SUPERCET_VERSION environment variable not set');
		return;
	}

	try {
		// Fetch the latest release from GitHub
		const response = await fetch('https://api.github.com/repos/supercet/homebrew-supercet/releases/latest', {
			headers: {
				Accept: 'application/vnd.github.v3+json',
			},
		});

		if (!response.ok) {
			console.warn('Failed to fetch latest release information from GitHub');
			return;
		}

		const releaseData = await response.json();
		const latestVersion = releaseData.tag_name?.replace(/^v/, ''); // Remove 'v' prefix if present

		if (!latestVersion) {
			console.warn('Could not determine latest version from GitHub release data');
			return;
		}

		console.log('\n');

		// Compare versions (simple string comparison for semantic versions)
		if (latestVersion !== currentVersion) {
			console.log('\n' + '='.repeat(60));
			console.log('🚀 A new version of Supercet is available!');
			console.log(`Current version: ${currentVersion}`);
			console.log(`Latest version:  ${latestVersion}`);
			console.log('To upgrade, run:');
			console.log('brew update && brew upgrade supercet');
			console.log('='.repeat(60) + '\n');
		} else {
			console.log('✨ You are on the latest version of Supercet ✨');
		}
	} catch (error) {
		console.warn('Error checking for updates:', error);
	}
}
