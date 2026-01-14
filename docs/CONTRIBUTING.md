# Contributing to Antigravity Sync

Thank you for your interest in contributing to Antigravity Sync! 🎉

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Code Style](#code-style)
- [Testing](#testing)

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Yarn](https://yarnpkg.com/) (v1.x)
- [VS Code](https://code.visualstudio.com/)
- Git

### Finding Issues

- Look for issues labeled [`good first issue`](https://github.com/AntisyncOrg/antigravity-sync/labels/good%20first%20issue)
- Check [`help wanted`](https://github.com/AntisyncOrg/antigravity-sync/labels/help%20wanted) for more challenging tasks

## Development Setup

1. **Fork the repository**

2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/antigravity-sync.git
   cd antigravity-sync
   ```

3. **Install dependencies**
   ```bash
   yarn install
   ```

4. **Build the extension**
   ```bash
   yarn build
   ```

5. **Open in VS Code**
   ```bash
   code .
   ```

6. **Launch Extension Development Host**
   - Press `F5` to start debugging
   - A new VS Code window will open with the extension loaded

## Making Changes

### Branch Naming

Use descriptive branch names:
- `feature/add-conflict-ui` — New features
- `fix/sync-error-handling` — Bug fixes
- `docs/update-readme` — Documentation
- `refactor/simplify-config` — Code refactoring

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add selective folder sync
fix: handle network timeout gracefully
docs: update installation instructions
test: add GitHubService unit tests
refactor: extract notification logic
```

### Code Changes

1. Create a new branch from `main`
2. Make your changes
3. Write/update tests
4. Run lint and tests locally
5. Commit with a descriptive message

## Pull Request Process

1. **Update documentation** if needed
2. **Add tests** for new functionality
3. **Ensure all tests pass**
   ```bash
   yarn lint
   yarn test
   ```
4. **Update CHANGELOG.md** if applicable
5. **Create Pull Request** with:
   - Clear title following commit conventions
   - Description of changes
   - Link to related issue(s)
   - Screenshots for UI changes

### PR Review

- At least one maintainer approval is required
- CI checks must pass
- Address review comments promptly

## Code Style

### TypeScript

- Use TypeScript for all source files
- Enable `strict` mode
- Prefer `const` over `let`
- Use meaningful variable names
- Add JSDoc comments for public APIs

### Formatting

- ESLint handles code style
- Run `yarn lint:fix` before committing
- Use 4 spaces for indentation (enforced by ESLint)

### File Organization

```
src/
├── extension.ts       # Entry point
├── services/          # Business logic
├── ui/                # UI components
└── test/              # Tests
    ├── unit/          # Unit tests
    └── e2e/           # End-to-end tests
```

## Testing

### Unit Tests

```bash
# Run all unit tests
yarn test

# Run with coverage
yarn test:coverage

# Watch mode
yarn test:watch
```

### E2E Tests

```bash
yarn test:e2e
```

### Test Guidelines

- Aim for 80%+ code coverage
- Mock external dependencies
- Test both success and error paths
- Use descriptive test names

## Questions?

- Open a [Discussion](https://github.com/AntisyncOrg/antigravity-sync/discussions)
- Check existing [Issues](https://github.com/AntisyncOrg/antigravity-sync/issues)

Thank you for contributing! 🙏
