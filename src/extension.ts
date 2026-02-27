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
import { checkIsPublicRepo, isUpstreamRepo, validateGitRepoUrl } from './services/RepoValidationService';

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
        await syncService?.sync();
        sidePanelProvider?.updatePanelData();
      } catch (error) {
        NotificationService.handleSyncError(error as Error);
      }
    }),

    vscode.commands.registerCommand('antigravitySync.push', async () => {
      try {
        await syncService?.push();
        sidePanelProvider?.updatePanelData();
      } catch (error) {
        NotificationService.handleSyncError(error as Error);
      }
    }),

    vscode.commands.registerCommand('antigravitySync.pull', async () => {
      try {
        await syncService?.pull();
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
    } catch (error) {
      NotificationService.handleSyncError(error as Error);
    }
  }

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
    title: '步骤 1/4：访问令牌',
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
    title: '步骤 2/4：私有仓库地址',
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
    title: '步骤 3/4：同步密码',
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
    '步骤 4/4：确认配置',
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
