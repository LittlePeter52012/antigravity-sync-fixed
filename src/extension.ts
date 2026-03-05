/**
 * Antigravity Sync - VS Code Extension
 * Sync ~/.gemini/ folder across machines via private Git repository
 */
import * as vscode from 'vscode';
import { SyncService } from './services/SyncService';
import { ConfigService } from './services/ConfigService';
import { StatusBarService } from './services/StatusBarService';
import { WatcherService } from './services/WatcherService';
import { NotificationService } from './services/NotificationService';
import { SidePanelProvider } from './ui/SidePanelProvider';
import { GitService } from './services/GitService';
import { checkIsPublicRepo, isUpstreamRepo, normalizeRepoIdentity, validateGitRepoUrl } from './services/RepoValidationService';
import { UpdateService } from './services/UpdateService';

let syncService: SyncService | undefined;
let watcherService: WatcherService | undefined;
let statusBarService: StatusBarService | undefined;
let sidePanelProvider: SidePanelProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Antigravity 同步与自动重试正在激活...');

  // Initialize services
  const configService = new ConfigService(context);
  statusBarService = new StatusBarService();
  syncService = new SyncService(context, configService, statusBarService);
  watcherService = new WatcherService(configService, syncService);

  // Register side panel
  sidePanelProvider = new SidePanelProvider(
    context.extensionUri,
    syncService,
    configService,
    watcherService
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidePanelProvider.viewType,
      sidePanelProvider
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravitySync.configure', async () => {
      await configureRepository(context, configService, syncService!);
    }),

    vscode.commands.registerCommand('antigravitySync.syncNow', async () => {
      try {
        await NotificationService.withProgress('正在同步...', async () => {
          await syncService?.sync();
        });
        sidePanelProvider?.updatePanelData();
      } catch (error) {
        NotificationService.handleSyncError(error as Error);
      }
    }),

    vscode.commands.registerCommand('antigravitySync.push', async () => {
      try {
        await NotificationService.withProgress('正在推送...', async () => {
          await syncService?.push();
        });
        sidePanelProvider?.updatePanelData();
      } catch (error) {
        NotificationService.handleSyncError(error as Error);
      }
    }),

    vscode.commands.registerCommand('antigravitySync.pull', async () => {
      try {
        await NotificationService.withProgress('正在拉取...', async () => {
          await syncService?.pull();
        });
        sidePanelProvider?.updatePanelData();
      } catch (error) {
        NotificationService.handleSyncError(error as Error);
      }
    }),

    vscode.commands.registerCommand('antigravitySync.showStatus', async () => {
      await showStatus(syncService!);
    }),

    vscode.commands.registerCommand('antigravitySync.openPanel', () => {
      vscode.commands.executeCommand('antigravity-sync-fixed.focus');
    }),

    vscode.commands.registerCommand('antigravitySync.checkUpdates', async () => {
      await checkForUpdates(context);
    }),

    vscode.commands.registerCommand('antigravitySync.resetSyncPassword', async () => {
      await resetSyncPasswordFlow(context, configService, syncService!);
    }),

    statusBarService.getStatusBarItem()
  );

  // Check if first time - show setup wizard
  if (!(await configService.isConfigured())) {
    showWelcomeMessage();
  } else {
    // Start watching if configured
    try {
      await syncService.initialize();
      watcherService.start();
      statusBarService.show();

      // ★ Window Focus Auto-Pull: when user switches to this computer, silently pull latest data
      let lastFocusPullTime = 0;
      const FOCUS_PULL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes minimum between focus pulls
      context.subscriptions.push(
        vscode.window.onDidChangeWindowState(async (state) => {
          if (state.focused && syncService) {
            const now = Date.now();
            if (now - lastFocusPullTime > FOCUS_PULL_COOLDOWN_MS) {
              lastFocusPullTime = now;
              console.log('[Antigravity] 窗口获取焦点，后台静默拉取远端更新...');
              try {
                await syncService.pull();
                sidePanelProvider?.updatePanelData();
              } catch (error) {
                console.warn('[Antigravity] 焦点拉取失败（非致命）：', (error as Error).message);
              }
            }
          }
        })
      );
    } catch (error) {
      NotificationService.handleSyncError(error as Error);
    }
  }

  // Auto-check updates (optional)
  setTimeout(() => {
    void autoCheckForUpdates(context);
  }, 4000);

  // Auto-start Auto Retry if enabled
  const config = vscode.workspace.getConfiguration('antigravitySync');
  if (config.get('autoStartRetry', false)) {
    // Delay auto-start to let UI initialize
    setTimeout(async () => {
      try {
        console.log('[Antigravity] 正在自动启动自动重试...');
        await sidePanelProvider?.tryAutoStartRetry();
      } catch (error) {
        console.error('[Antigravity] 自动启动失败：', error);
      }
    }, 3000);
  }

  console.log('Antigravity 同步与自动重试已激活！');
}

export function deactivate(): void {
  watcherService?.stop();
  statusBarService?.hide();
  console.log('Antigravity 同步与自动重试已停用');
}

async function checkForUpdates(context: vscode.ExtensionContext): Promise<void> {
  await checkForUpdatesInternal(context, { silent: false, trigger: 'manual' });
}

async function autoCheckForUpdates(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('antigravitySync');
  if (!config.get('autoCheckUpdates', true)) {
    return;
  }

  const now = Date.now();
  const lastCheck = context.globalState.get<number>('antigravitySync.lastUpdateCheck', 0);
  const intervalMs = 12 * 60 * 60 * 1000; // 12 hours
  if (now - lastCheck < intervalMs) {
    return;
  }

  await context.globalState.update('antigravitySync.lastUpdateCheck', now);
  await checkForUpdatesInternal(context, { silent: true, trigger: 'auto' });
}

async function checkForUpdatesInternal(
  context: vscode.ExtensionContext,
  options: { silent: boolean; trigger: 'manual' | 'auto' }
): Promise<void> {
  const updateService = new UpdateService(context);
  const currentVersion = updateService.getCurrentVersion();

  try {
    const latest = await updateService.getLatestRelease();
    if (!latest.version) {
      if (!options.silent) {
        await NotificationService.info('未找到可用的更新版本');
      }
      return;
    }

    const compare = compareVersions(latest.version, currentVersion);
    if (compare <= 0) {
      if (!options.silent) {
        await NotificationService.info(`已是最新版本（${currentVersion}）`);
      }
      return;
    }

    const skipped = context.globalState.get<string>('antigravitySync.skipVersion', '');
    if (options.silent && skipped === latest.version) {
      return;
    }

    await promptInstallUpdate(context, updateService, latest, currentVersion, options.trigger);
  } catch (error) {
    if (options.silent) {
      return;
    }
    const message = error instanceof Error ? error.message : '检查更新失败';
    await NotificationService.error('检查更新失败', { detail: message });
  }
}

async function promptInstallUpdate(
  context: vscode.ExtensionContext,
  updateService: UpdateService,
  latest: { version: string; htmlUrl: string; assetUrl?: string; assetName?: string },
  currentVersion: string,
  trigger: 'manual' | 'auto'
): Promise<void> {
  const title = trigger === 'auto'
    ? `发现新版本 v${latest.version}（自动检查）`
    : `发现新版本 v${latest.version}（当前 v${currentVersion}）`;

  const choice = await vscode.window.showInformationMessage(
    title,
    { modal: trigger === 'manual' },
    '下载并安装',
    '打开发布页',
    '忽略此版本'
  );

  if (choice === '忽略此版本') {
    await context.globalState.update('antigravitySync.skipVersion', latest.version);
    return;
  }

  if (choice === '打开发布页') {
    void vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl));
    return;
  }

  if (choice !== '下载并安装') {
    return;
  }

  if (!latest.assetUrl || !latest.assetName) {
    await NotificationService.error('未找到可安装的 VSIX', {
      detail: '请打开发布页手动下载 VSIX。',
      actions: [
        { title: '打开发布页', action: () => void vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl)) }
      ]
    });
    return;
  }

  await NotificationService.withProgress('正在下载更新...', async (progress) => {
    progress.report({ message: '下载 VSIX...' });
    const vsixPath = await updateService.downloadVsix(latest.assetUrl!, latest.assetName!);
    progress.report({ message: '安装中...' });
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
  });

  const reload = await vscode.window.showInformationMessage(
    '更新已安装，是否立即重载窗口？',
    '立即重载'
  );
  if (reload === '立即重载') {
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function resetSyncPasswordFlow(
  context: vscode.ExtensionContext,
  configService: ConfigService,
  syncService: SyncService
): Promise<void> {
  const config = configService.getConfig();
  if (!config.repositoryUrl) {
    await NotificationService.error('尚未配置仓库', {
      detail: '请先完成仓库配置。',
      actions: [
        { title: '立即配置', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
      ]
    });
    return;
  }

  const warning = await vscode.window.showWarningMessage(
    '重置同步密码需要重新设置所有设备的密码。为避免误操作，请按提示确认。',
    { modal: true },
    '继续'
  );
  if (warning !== '继续') {
    return;
  }

  const confirmText = await vscode.window.showInputBox({
    title: '确认重置',
    prompt: '请输入 RESET 继续',
    placeHolder: 'RESET',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().toUpperCase() !== 'RESET') {
        return '请输入 RESET 以继续';
      }
      return undefined;
    }
  });
  if (!confirmText) {
    return;
  }

  const repoConfirm = await vscode.window.showInputBox({
    title: '确认仓库地址',
    prompt: '请再次输入仓库地址以确认',
    placeHolder: config.repositoryUrl,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const original = normalizeRepoIdentity(config.repositoryUrl);
      const input = normalizeRepoIdentity(value || '');
      if (!input || !original) {
        return '请输入有效的仓库地址';
      }
      if (input.host !== original.host || input.path !== original.path) {
        return '仓库地址不匹配';
      }
      return undefined;
    }
  });
  if (!repoConfirm) {
    return;
  }

  const token = await vscode.window.showInputBox({
    title: '验证访问权限',
    prompt: '请输入访问令牌以确认权限',
    password: true,
    placeHolder: '具有仓库访问权限的令牌',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.length < 8) {
        return '请输入有效的访问令牌';
      }
      return undefined;
    }
  });
  if (!token) {
    return;
  }

  const newPassword = await vscode.window.showInputBox({
    title: '设置新同步密码',
    prompt: '请输入新的同步密码（用于设备间验证）',
    password: true,
    placeHolder: '至少 6 位',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.length < 6) {
        return '同步密码长度至少 6 位';
      }
      return undefined;
    }
  });
  if (!newPassword) {
    return;
  }

  const confirmPassword = await vscode.window.showInputBox({
    title: '确认新同步密码',
    prompt: '请再次输入同步密码以确认',
    password: true,
    placeHolder: '与上一步保持一致',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.length < 6) {
        return '同步密码长度至少 6 位';
      }
      if (value !== newPassword) {
        return '两次输入的同步密码不一致';
      }
      return undefined;
    }
  });
  if (!confirmPassword) {
    return;
  }

  try {
    await NotificationService.withProgress('正在重置同步密码...', async (progress) => {
      progress.report({ message: '验证访问权限...' });
      const tempGitService = new GitService(configService.getSyncRepoPath());
      await tempGitService.verifyAccess(config.repositoryUrl, token);

      progress.report({ message: '写入新密码并推送...' });
      await syncService.resetSyncPassword(newPassword, token);
      await configService.saveSyncPassword(newPassword);
    });

    await NotificationService.info('同步密码已重置，请在其他设备输入新密码');
  } catch (error) {
    NotificationService.handleSyncError(error as Error);
  }
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map(x => parseInt(x, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * Show welcome message for first-time users
 */
function showWelcomeMessage(): void {
  vscode.window.showInformationMessage(
    '欢迎使用 Antigravity 同步！请先配置私有仓库以同步 Gemini 上下文。',
    '立即配置',
    '稍后'
  ).then(selection => {
    if (selection === '立即配置') {
      vscode.commands.executeCommand('antigravitySync.configure');
    }
  });
}

/**
 * Configure repository with setup wizard
 */
async function configureRepository(
  context: vscode.ExtensionContext,
  configService: ConfigService,
  syncService: SyncService
): Promise<void> {
  // Step 1: Welcome and explanation
  const proceed = await vscode.window.showInformationMessage(
    'Antigravity 同步设置\n\n将同步 ~/.gemini 中的内容到你的私有 Git 仓库。',
    { modal: true },
    '继续'
  );

  if (proceed !== '继续') {
    return;
  }

  // Step 2: Get access token
  const token = await vscode.window.showInputBox({
    title: '步骤 1/5：访问令牌',
    prompt: '请输入访问令牌（GitHub/GitLab 的 PAT 或 Bitbucket App Password）',
    password: true,
    placeHolder: '具有仓库访问权限的令牌',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.length < 8) {
        return '请输入有效的访问令牌';
      }
      return undefined;
    }
  });

  if (!token) {
    return;
  }

  // Step 3: Get repository URL
  const repoUrl = await vscode.window.showInputBox({
    title: '步骤 2/5：私有仓库地址',
    prompt: '请输入私有仓库地址（GitHub / GitLab / Bitbucket 等）',
    placeHolder: 'https://github.com/user/repo 或 https://gitlab.com/user/repo',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || !value.includes('://')) {
        return '请输入有效的 Git 仓库地址';
      }
      return undefined;
    }
  });

  if (!repoUrl) {
    return;
  }

  // Step 4: Get sync password
  const syncPassword = await vscode.window.showInputBox({
    title: '步骤 3/5：同步密码',
    prompt: '请设置同步密码（用于设备间验证）',
    password: true,
    placeHolder: '至少 6 位',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.length < 6) {
        return '同步密码长度至少 6 位';
      }
      return undefined;
    }
  });

  if (!syncPassword) {
    return;
  }

  const syncPasswordConfirm = await vscode.window.showInputBox({
    title: '步骤 4/5：确认同步密码',
    prompt: '请再次输入同步密码以确认',
    password: true,
    placeHolder: '与上一步保持一致',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.length < 6) {
        return '同步密码长度至少 6 位';
      }
      if (value !== syncPassword) {
        return '两次输入的同步密码不一致';
      }
      return undefined;
    }
  });

  if (!syncPasswordConfirm) {
    return;
  }

  const validationResult = validateGitRepoUrl(repoUrl);
  if (!validationResult.valid) {
    await NotificationService.error('仓库地址无效', {
      detail: validationResult.error,
      modal: true
    });
    return;
  }

  const isPublic = await checkIsPublicRepo(repoUrl);
  if (isPublic) {
    await NotificationService.error('仓库必须为私有', {
      detail: '检测到仓库为公开仓库，请改用私有仓库以保护敏感数据。',
      modal: true
    });
    return;
  }

  if (isUpstreamRepo(repoUrl)) {
    const choice = await vscode.window.showWarningMessage(
      '你正在使用原作者仓库地址，这会把数据推送到他人仓库，存在安全风险。是否仍然继续？',
      { modal: true },
      '仍然继续'
    );
    if (choice !== '仍然继续') {
      return;
    }
  }

  // Step 5: Confirmation dialog
  const confirmMessage = [
    '步骤 5/5：确认配置',
    '',
    `仓库地址：${repoUrl}`,
    '同步密码：已设置',
    '',
    '接下来将执行：',
    '• 验证访问权限',
    '• 准备同步目录（仓库内 .antigravity-sync）',
    '• 启动自动同步',
    '',
    '是否继续？'
  ].join('\n');

  const confirm = await vscode.window.showInformationMessage(
    confirmMessage,
    { modal: true },
    '确认并连接'
  );

  if (confirm !== '确认并连接') {
    return;
  }

  // Step 5: Validate and save
  try {
    await NotificationService.withProgress(
      '正在连接仓库...',
      async (progress) => {
        progress.report({ message: '验证访问权限...' });

        const tempGitService = new GitService(configService.getSyncRepoPath());
        await tempGitService.verifyAccess(repoUrl, token);

        // URL must be set first (credentials storage depends on URL)
        await configService.setRepositoryUrl(repoUrl);
        await configService.saveCredentials(token);
        await configService.saveSyncPassword(syncPassword);

        progress.report({ message: '初始化同步仓库...' });
        await syncService.initialize();

        progress.report({ message: '启动自动同步...' });
      }
    );

    vscode.window.showInformationMessage(
      '配置成功！🎉\n\n你的上下文将自动同步。',
      '打开面板'
    ).then(selection => {
      if (selection === '打开面板') {
        vscode.commands.executeCommand('antigravity-sync-fixed.focus');
      }
    });

    // Start watching
    watcherService?.start();
    statusBarService?.show();
    sidePanelProvider?.updatePanelData();
  } catch (error) {
    await configService.deleteSyncPassword();
    await configService.deleteCredentials();
    await vscode.workspace.getConfiguration('antigravitySync')
      .update('repositoryUrl', '', vscode.ConfigurationTarget.Global);
    NotificationService.handleSyncError(error as Error);
  }
}

/**
 * Show sync status quick pick
 */
async function showStatus(syncService: SyncService): Promise<void> {
  const status = await syncService.getStatus();

  const items: vscode.QuickPickItem[] = [
    { label: '$(sync) 同步状态', description: status.syncStatus },
    { label: '$(git-commit) 最近同步', description: status.lastSync || '从未' },
    { label: '$(file) 待同步变更', description: String(status.pendingChanges) },
    { label: '$(repo) 仓库', description: status.repository || '未配置' }
  ];

  await vscode.window.showQuickPick(items, {
    title: 'Antigravity 同步状态',
    placeHolder: '当前同步状态'
  });
}
