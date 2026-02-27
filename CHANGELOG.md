# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.8] - 2026-02-27

### Added
- 启动后自动检查 GitHub Release 更新（可关闭）

## [0.4.7] - 2026-02-27

### Added
- 支持从 GitHub Release 检查更新并安装 VSIX
- 新增“重置同步密码”安全流程（二次确认 + 令牌验证）

## [0.4.6] - 2026-02-27

### Changed
- 配置向导与面板新增“确认同步密码”，避免首次输入错误

## [0.4.5] - 2026-02-27

### Changed
- 智能合并策略升级为“云盘式冲突副本”：保留较新版本，旧版本以 `.conflict-设备-时间戳` 形式保留
- 内容一致时跳过处理，减少无谓冲突

## [0.4.4] - 2026-02-27

### Changed
- 智能合并策略升级：对所有差异文件采用“更新优先/大小优先”决策，降低多设备冲突
- 远端删除按时间决策，避免误复活旧文件

## [0.4.3] - 2026-02-27

### Changed
- README 精简为中英双语简明版
- 移除不必要的文档 MD 文件
- 同步拷贝跳过未变化文件，减少 IO

## [0.4.2] - 2026-02-27

### Added
- 同步密码校验（设备间验证）
- 仓库子目录隔离（默认 `.antigravity-sync`）

### Changed
- 同步改为只影响同步子目录，避免误改仓库其他内容

### Fixed
- 自动重试“开始/停止”按钮文字换行显示问题

## [0.4.0] - 2026-02-27

### Added
- 默认同步目录新增 `skills/`、`annotations/`
- 同步开关生效（禁用后不再自动同步）

### Changed
- 插件身份、仓库链接更新为私有化版本
- 配置流程统一校验（私有仓库、令牌权限）
- 面板/通知/状态栏全面中文化
- 自动同步间隔改为读取配置值

### Fixed
- 切换仓库后 `origin` 仍指向旧仓库的问题

## [0.3.3] - 2026-01-22

### Changed
- Improve Auto Retry setup UX:
  - "Copy & Quit" button: auto-close IDE after copying command
  - Commands run in background (Windows: `start`, Linux: `nohup`)
  - Clear terminal instructions (Win+R for Windows, Ctrl+Alt+T for Linux)


## [0.3.2] - 2026-01-22

### Added
- **Auto Retry**: Automatically click Retry buttons when AI agent encounters errors
- CDP (Chrome DevTools Protocol) integration for Auto Retry
- Platform-specific setup dialogs (macOS, Windows, Linux)
- One-click Auto Retry: Check CDP → Auto setup → Show instructions
- About Me section in README with VNLF link

### Changed
- Improved git sync logic with better merge conflict handling

## [0.2.0] - 2026-01-15

### Added
- Git Credential Manager integration for persistent credential storage
- Per-repository credential support (no conflicts with multiple GitHub accounts)
- Cross-platform credential storage (macOS Keychain, Windows Credential Manager, Linux libsecret/GNOME Keyring)
- Automatic credential helper configuration

### Changed
- Credentials now stored via Git credential manager instead of VS Code secret storage
- Credentials persist across all workspaces and VS Code installations
- No need to re-enter credentials when switching workspaces

### Security
- Credentials stored in OS-native secure storage
- Per-repository isolation prevents credential conflicts
- Backwards compatible with existing host-level credentials

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
