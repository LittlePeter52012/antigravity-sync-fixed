# Antigravity 同步与自动重试

**自动同步 AI 上下文 + 自动重试（Auto Retry）**，减少看护与手动操作。  
**Sync AI context + Auto Retry**, less babysitting and manual clicks.

---

## 功能

- 私有仓库同步（保护敏感信息）
- 自动重试（AI 出错时自动点击 Retry）
- 可选目录同步 + 更新优先的智能合并（冲突副本保留）
- 同步子目录隔离（默认 `.antigravity-sync`）+ 同步密码校验

---

> 冲突时会保留双方副本，文件名包含 `.conflict-设备-时间戳`，避免数据丢失。

## 快速开始

1. 创建 **私有 Git 仓库**
2. 生成 **访问令牌（PAT / App Password）**
3. 命令面板运行：`Antigravity 同步：配置仓库`
4. 设置 **同步密码**（用于设备间验证）

---

## 默认同步目录

- `knowledge/`
- `brain/`
- `conversations/`
- `skills/`
- `annotations/`

> `annotations/` 存放对话元数据注解（`.pbtxt`），包含标题/标签、状态与批注等。  
> 多机同步建议与 `conversations/`、`brain/` 一起同步。

---

## 安装 / 更新

**VSIX 安装：**
- Extensions → `...` → **Install from VSIX...** → 选择 `.vsix` → Reload

**检查更新（GitHub Release）：**
- 命令面板运行：`Antigravity 同步：检查更新`
- 或在面板「仓库」栏点击“检查更新”

**为什么没有“点更新”？**
- 只有从 Marketplace / Open VSX 安装，才会出现 **Update / 更新**。

**Update (English):**
- Install via VSIX: Extensions → `...` → **Install from VSIX...** → Reload
- One‑click Update requires Marketplace / Open VSX installation.
- Check Updates: Command Palette → `Antigravity 同步：检查更新`

---

## 配置（常用）

- `antigravitySync.repositoryUrl`：私有仓库地址
- `antigravitySync.syncFolders`：同步目录
- `antigravitySync.syncRepoSubdir`：仓库内同步子目录（默认 `.antigravity-sync`）
- `antigravitySync.syncPasswordEnabled`：是否启用同步密码校验

---

## 隐私与安全

- 仅允许私有仓库
- 凭据存储在系统凭据管理器
- 默认排除敏感文件（OAuth/凭证/系统文件等）
- 同步数据写入 `.antigravity-sync`，避免影响仓库其他内容
- 同步密码只存本机 Secret Storage，仓库仅存哈希

---

## 忘记同步密码怎么办？

- 同步密码不可找回（仓库只保存哈希）
- 使用命令 **Antigravity 同步：重置同步密码** 重新设置

---

## 版权与致谢

本项目基于 **mrd9999/antigravity-sync** 二次开发，遵循原项目 **MIT License**。

- 原项目仓库：`https://github.com/mrd9999/antigravity-sync`
- 本项目仓库：`https://github.com/LittlePeter52012/antigravity-sync-fixed`

MIT License
