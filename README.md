# Antigravity 同步与自动重试

**自动同步 AI 上下文 + 自动重试（Auto Retry）**，减少看护与手动操作。  
**Sync AI context + Auto Retry**, less babysitting and manual clicks.

---

## 功能概览

- **自动同步**：将 Gemini/Antigravity 的上下文数据同步到私有 Git 仓库
- **自动重试**：AI 代理出错时自动点击 Retry 按钮
- **私有仓库强制**：公开仓库会被拒绝，保护敏感信息
- **可选目录同步**：在面板中按需勾选需要同步的目录
- **冲突处理**：内置智能合并策略（更大/更新优先）

---

## 默认同步目录

默认会同步以下目录（可在面板中调整）：

- `knowledge/`
- `brain/`
- `conversations/`
- `skills/`
- `annotations/`

> 说明：`annotations/` 存放对话的元数据注解（`.pbtxt`），包含标题/标签、对话状态、Artifacts 批注等。  
> 若需要在多机之间完整延续对话状态，建议与 `conversations/`、`brain/` 一起同步。

---

## 重要说明：跨设备同步

Antigravity 的对话记录与工作区路径相关，**跨设备同步时需要保持工作区路径一致**。

示例：
- 设备 A：`/Users/xxx/Documents/myproject`
- 设备 B：也必须是 `/Users/xxx/Documents/myproject`

如果路径不同，可使用软链接/快捷方式来对齐路径。

同步完成后请执行：

```
Cmd+Shift+P / Ctrl+Shift+P
→ Developer: Reload Window
```

---

## 更新方式（如何升级）

**如果你是通过 VSIX 安装：**
1. 扩展面板 → 右上角 `...` → **Install from VSIX...**
2. 选择新的 `.vsix` 文件
3. 安装后点击 **Reload / Reload Window**

**如果你希望“点更新”自动升级：**
- 需要发布到 Marketplace / Open VSX，并从商店安装该扩展。
- 以后发布新版本时，VS Code 才会出现 **Update / 更新** 按钮。

---

## Update (English)

**If you installed via VSIX:**
1. Extensions view → top-right `...` → **Install from VSIX...**
2. Select the new `.vsix` file
3. Click **Reload / Reload Window**

**If you want a one‑click Update button:**
- Publish to Marketplace / Open VSX and install from the store.
- VS Code will then show **Update** when a newer version is available.

---

## Security Notes (English)

- Private repo only
- Credentials stored in OS keychain / credential manager
- Sensitive files are excluded by default
- Sync data goes into repo subfolder `.antigravity-sync` to avoid touching other content
- Sync password check is supported (password is never uploaded in plain text)

## 安装方式

### 方式 1：从 VSIX 安装

1. 在 IDE 中打开扩展管理（Extensions）
2. 右上角 `...` → **Install from VSIX...**
3. 选择打包好的 `.vsix` 文件

---

## 快速开始

1. 创建 **私有 Git 仓库**
2. 生成 **访问令牌（PAT / App Password）**，确保具备仓库读写权限
3. 打开命令面板，执行：
   - `Antigravity 同步：配置仓库`
4. 按步骤完成配置

---

## 配置项

| 配置项 | 说明 |
| --- | --- |
| `antigravitySync.repositoryUrl` | 私有仓库地址（必须是私有） |
| `antigravitySync.enabled` | 启用/禁用自动同步 |
| `antigravitySync.autoSync` | 文件变更自动同步 |
| `antigravitySync.syncIntervalMinutes` | 自动同步间隔（分钟） |
| `antigravitySync.syncFolders` | 默认同步目录列表 |
| `antigravitySync.excludePatterns` | 额外排除规则 |
| `antigravitySync.geminiPath` | 自定义 .gemini 路径 |
| `antigravitySync.syncRepoSubdir` | 同步数据在仓库中的子目录（默认 `.antigravity-sync`） |
| `antigravitySync.syncPasswordEnabled` | 是否启用同步密码校验 |

---

## 隐私与安全

- 仅允许 **私有仓库**
- 凭据存储在系统凭据管理器
- 默认排除敏感文件（OAuth/凭证/系统文件等）
- 可使用 `.antigravityignore` 追加排除规则
- 同步数据默认写入仓库子目录 `.antigravity-sync`，避免影响仓库其他内容
- 支持同步密码校验（用于设备间验证，不会上传明文）

---

## 版权与致谢

本项目基于开源项目 **mrd9999/antigravity-sync** 进行二次开发与改造，遵循原项目的 **MIT License**。

- 原项目仓库：`https://github.com/mrd9999/antigravity-sync`
- 本项目仓库：`https://github.com/LittlePeter52012/antigravity-sync-fixed`

感谢原作者的开源贡献。

---

## 许可证

MIT License
