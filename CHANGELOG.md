# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-01-13

### Added
- Initial release
- Side panel with sync status, files, and history
- Setup wizard for easy configuration
- Private repository validation (rejects public repos)
- Auto-sync with configurable interval
- Selective folder sync
- Sensitive data exclusion (OAuth tokens, credentials)
- Status bar indicator
- Push/Pull/Sync commands
- Unit tests and E2E tests
- GitHub Actions CI/CD

### Security
- PAT stored in VS Code secret storage
- Automatic exclusion of sensitive files
- Private repository enforcement
