# Homebrew Supercet Tap

This repository contains the Homebrew tap for the Supercet project, a Node.js application for git operations.

## Quick Installation

To install Supercet via Homebrew:

```bash
brew tap supercet/supercet
brew install supercet
```

## Usage

After installation, you can use the `supercet` command:

```bash
supercet --help
```

## Development

### Prerequisites

- Homebrew installed
- Node.js (for building the project)
- Ruby (for formula updates)

### Local Development

1. Clone this repository:

   ```bash
   git clone https://github.com/supercet/homebrew-supercet.git
   cd homebrew-supercet
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the project:

   ```bash
   npm run build
   ```

4. Test the formula locally:

   ```bash
   npm run tap:test
   ```

### Updating the Formula

When you need to update the formula for a new release:

1. Update the version in `package.json`
2. Create a new git tag: `git tag v0.1.1`
3. Push the tag: `git push origin v0.1.1`
4. GitHub Actions will automatically:
   - Build and release the binaries for ARM64 and x64
   - Update the formula with the correct SHA256 hashes
   - Test the formula installation

Or manually update the formula:

```bash
npm run tap:update
```

### Testing the Tap

To test the tap installation:

```bash
# Install from the tap
brew tap supercet/supercet
brew install supercet

# Test the installation
supercet --help

# Uninstall
npm run tap:uninstall
```

## Project Structure

```
homebrew-supercet/
├── Formula/
│   └── supercet.rb          # Homebrew formula
├── scripts/
│   └── update-formula.rb    # Script to update formula SHA256
├── .github/
│   └── workflows/
│       ├── build-release.yml # Builds and releases binaries
│       └── release.yml       # Updates formula after release
├── src/                     # Source code
├── package.json             # Node.js dependencies
└── README.md               # This file
```

## Formula Details

The formula:

- Downloads pre-compiled binaries for macOS ARM64 and x64
- Automatically selects the correct binary for the target architecture
- Installs the binary as `supercet` in `/usr/local/bin`
- No Node.js runtime required - binaries are self-contained

## Release Process

1. Update the version in `package.json`
2. Commit and push changes
3. Create and push a git tag (e.g., `v0.1.1`)
4. GitHub Actions will automatically:
   - Build standalone binaries for both architectures
   - Create a GitHub release with the binaries
   - Update the formula with correct SHA256 hashes
   - Test the formula installation

## Troubleshooting

### Formula Installation Issues

If you encounter issues installing the formula:

```bash
# Check formula syntax
brew audit --strict Formula/supercet.rb

# Install with verbose output
brew install --verbose --build-from-source ./Formula/supercet.rb

# Check for conflicts
brew doctor
```

### Development Issues

If the build fails:

```bash
# Clean and rebuild
rm -rf dist node_modules
npm install
npm run build-bundle
```

### Binary Release Issues

If the release process fails:

1. Check that the GitHub release was created with the binary files
2. Verify the binary file names match the formula expectations
3. Ensure the binaries are executable

## Project Information

- **Homepage**: https://github.com/supercet/homebrew-supercet
- **License**: MIT
- **Dependencies**: None (self-contained binaries)
- **Tap Name**: supercet/supercet

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test the formula locally
5. Submit a pull request

## License

This project is licensed under the MIT License.
