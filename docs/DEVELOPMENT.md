# Development Guide

This guide covers local development setup for Antigravity Sync.

## Prerequisites

- Node.js 18+
- Yarn 1.x
- VS Code
- Git

## Quick Start

```bash
# Clone and install
git clone https://github.com/AntisyncOrg/antigravity-sync.git
cd antigravity-sync
yarn install

# Build
yarn build

# Run tests
yarn test
```

## Project Structure

```
antigravity-sync/
├── src/                    # Extension source
│   ├── extension.ts        # Entry point
│   ├── services/           # Business logic
│   │   ├── SyncService.ts
│   │   ├── GitService.ts
│   │   ├── GitHubService.ts
│   │   ├── FilterService.ts
│   │   └── ConfigService.ts
│   └── ui/                 # UI providers
├── webview/                # Webview source
│   └── src/
│       ├── index.ts
│       └── panels/
├── dist/                   # Build output
└── docs/                   # Documentation
```

## Development Workflow

### 1. Launch Extension Host

- Open project in VS Code
- Press `F5` to launch Extension Development Host
- Extension will be active in the new window

### 2. Make Changes

- Edit source files in `src/`
- Webpack will rebuild automatically (`yarn watch`)
- Reload Extension Host window (`Cmd+R`)

### 3. Debug

- Set breakpoints in VS Code
- Use Debug Console for logging
- Check Output panel → "Antigravity Sync"

## Scripts

| Command | Description |
|---------|-------------|
| `yarn build` | Production build |
| `yarn build:dev` | Development build |
| `yarn watch` | Watch mode |
| `yarn lint` | Run ESLint |
| `yarn test` | Run unit tests |
| `yarn test:e2e` | Run E2E tests |
| `yarn package` | Create VSIX |

## Architecture

### Services

- **SyncService** — Orchestrates sync operations
- **GitService** — Local Git wrapper (simple-git)
- **GitHubService** — GitHub API (Octokit)
- **FilterService** — File filtering
- **ConfigService** — Settings management

### UI

- **SidePanelProvider** — Webview panel
- **StatusBarService** — Status bar item
- **NotificationService** — VS Code notifications

### Webview

Built with `@vscode/webview-ui-toolkit` for native VS Code look.

## Testing

### Unit Tests (Jest)

```bash
yarn test           # Run all
yarn test:watch     # Watch mode
yarn test:coverage  # With coverage
```

### E2E Tests

```bash
yarn test:e2e
```

## Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create git tag: `git tag v0.2.0`
4. Push: `git push --tags`
5. CI will auto-publish to Marketplace
