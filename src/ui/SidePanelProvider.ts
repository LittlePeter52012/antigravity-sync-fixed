/**
 * SidePanelProvider - WebviewViewProvider for the side panel
 */
import * as vscode from 'vscode';
import { SyncService } from '../services/SyncService';
import { ConfigService } from '../services/ConfigService';
import { NotificationService } from '../services/NotificationService';
import { GitService } from '../services/GitService';
import { AutoRetryService } from '../services/AutoRetryService';
import { WatcherService } from '../services/WatcherService';
import { checkIsPublicRepo, isUpstreamRepo, validateGitRepoUrl } from '../services/RepoValidationService';

export class SidePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravitySync.mainPanel';

  private _view?: vscode.WebviewView;
  private readonly _extensionUri: vscode.Uri;
  private readonly _syncService: SyncService;
  private readonly _configService: ConfigService;
  private readonly _autoRetryService: AutoRetryService;
  private readonly _watcherService: WatcherService;

  constructor(
    extensionUri: vscode.Uri,
    syncService: SyncService,
    configService: ConfigService,
    watcherService: WatcherService
  ) {
    this._extensionUri = extensionUri;
    this._syncService = syncService;
    this._configService = configService;
    this._autoRetryService = new AutoRetryService();
    this._watcherService = watcherService;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this._extensionUri, 'webview', 'media')
      ]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'checkConfig':
          await this.sendConfigState();
          break;
        case 'saveConfig':
          await this.handleSaveConfig(message.repoUrl, message.pat, message.syncPassword, message.syncPasswordConfirm);
          break;
        case 'syncNow':
          await this.handleSync();
          break;
        case 'push':
          await this.handlePush();
          break;
        case 'pull':
          await this.handlePull();
          break;
        case 'disconnect':
          await this.handleDisconnect();
          break;
        case 'toggleFolder':
          await this.handleFolderToggle(message.folder, message.enabled);
          break;
        case 'toggleSyncEnabled':
          await this.handleToggleSyncEnabled(message.enabled);
          break;
        case 'openExternal':
          vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case 'getGitStatus':
          // Just refresh status (git fetch + check) - no file copy needed
          await this.sendGitStatus();
          break;
        case 'startAutoRetry':
          await this.handleStartAutoRetry();
          break;
        case 'stopAutoRetry':
          await this.handleStopAutoRetry();
          break;
        case 'setAutoStart':
          await this.handleSetAutoStart(message.data?.enabled ?? false);
          break;
        case 'getAutoRetryStatus':
          this.sendAutoRetryStatus();
          this.sendAutoStartSetting();
          break;
      }
    });
  }

  /**
   * Send current config state to webview
   */
  private async sendConfigState(): Promise<void> {
    if (!this._view) return;

    const isConfigured = await this._configService.isConfigured();
    const config = this._configService.getConfig();
    const vsConfig = vscode.workspace.getConfiguration('antigravitySync');
    const syncFolders = vsConfig.get<string[]>(
      'syncFolders',
      ['knowledge', 'brain', 'conversations', 'skills', 'annotations']
    );
    const syncEnabled = vsConfig.get<boolean>('enabled', true);

    this._view.webview.postMessage({
      type: 'configured',
      data: {
        configured: isConfigured,
        repoUrl: config.repositoryUrl,
        syncFolders: syncFolders,
        syncEnabled: syncEnabled
      }
    });

    if (isConfigured) {
      await this.updateStatus();

      // Wire git logger to UI panel (for when extension is already configured)
      this._syncService.setGitLogger((msg, type) => this.sendLog(msg, type));

      // Start auto-sync timer if not already running
      this._syncService.setCountdownCallback((seconds) => {
        if (this._view) {
          this._view.webview.postMessage({
            type: 'countdown',
            data: { seconds }
          });
        }
      });
      this._syncService.startAutoSync();
    }
  }

  /**
   * Handle save config from webview inline form
   */
  private async handleSaveConfig(repoUrl: string, pat: string, syncPassword: string, syncPasswordConfirm: string): Promise<void> {
    if (!this._view) return;

    if (!repoUrl || !pat || !syncPassword || !syncPasswordConfirm) {
      this._view.webview.postMessage({
        type: 'configError',
        data: { message: '请填写仓库地址、访问令牌和同步密码（含确认）' }
      });
      return;
    }

    try {
      this.sendLog('正在连接...', 'info');

      // Validate URL is a Git repository URL
      this.sendLog('校验仓库地址...', 'info');
      const validationResult = validateGitRepoUrl(repoUrl);
      if (!validationResult.valid) {
        throw new Error(validationResult.error);
      }

      if (pat.length < 5) {
        throw new Error('访问令牌长度看起来不正确');
      }

      if (syncPassword.length < 6) {
        throw new Error('同步密码长度至少 6 位');
      }
      if (syncPassword !== syncPasswordConfirm) {
        throw new Error('两次输入的同步密码不一致');
      }

      // CRITICAL: Check if repo is PUBLIC (reject if accessible without auth)
      this.sendLog('检查仓库是否为私有...', 'info');
      const isPublic = await checkIsPublicRepo(repoUrl);
      if (isPublic) {
        throw new Error('检测到仓库为公开仓库！请使用私有仓库以保护敏感数据。');
      }

      if (isUpstreamRepo(repoUrl)) {
        const choice = await vscode.window.showWarningMessage(
          '你正在使用原作者仓库地址。这会把数据推送到他人仓库，存在安全风险。是否仍然继续？',
          { modal: true },
          '仍然继续'
        );
        if (choice !== '仍然继续') {
          this.sendLog('已取消配置', 'info');
          return;
        }
      }

      // Verify token has access to the repository FIRST (before saving)
      this.sendLog('验证访问权限...', 'info');
      const tempGitService = new GitService(this._configService.getSyncRepoPath());
      await tempGitService.verifyAccess(repoUrl, pat);

      // Save URL first (credentials storage depends on URL)
      this.sendLog('保存凭据...', 'info');
      await this._configService.setRepositoryUrl(repoUrl);
      // Now save credentials (uses Git credential manager - persists across workspaces)
      await this._configService.saveCredentials(pat);
      await this._configService.saveSyncPassword(syncPassword);

      // Initialize sync
      this.sendLog('准备同步目录（仓库内 .antigravity-sync）...', 'info');
      await this._syncService.initialize();

      // Wire git logger to UI panel
      this._syncService.setGitLogger((msg, type) => this.sendLog(msg, type));

      this.sendLog('连接成功！', 'success');

      // Setup auto-sync timer with countdown callback
      this._syncService.setCountdownCallback((seconds) => {
        if (this._view) {
          this._view.webview.postMessage({
            type: 'countdown',
            data: { seconds }
          });
        }
      });
      this._syncService.startAutoSync();

      // Update webview and check git status
      await this.sendConfigState();
      await this.sendGitStatus();

    } catch (error) {
      const message = error instanceof Error ? error.message : '配置失败';
      this.sendLog(`连接失败：${message}`, 'error');
      await this._configService.deleteSyncPassword();
      await this._configService.deleteCredentials();
      await vscode.workspace.getConfiguration('antigravitySync')
        .update('repositoryUrl', '', vscode.ConfigurationTarget.Global);
      this._view.webview.postMessage({
        type: 'configError',
        data: { message }
      });
    }
  }

  /**
   * Handle sync action
   */
  private async handleSync(): Promise<void> {
    this.updateStatus('syncing');
    this.sendLog('正在同步...', 'info');
    try {
      await this._syncService.sync();
      this.updateStatus('synced');
      this.sendLog('同步完成', 'success');
      await this.sendGitStatus();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误';
      this.updateStatus('error');
      this.sendLog(`同步失败：${errorMsg}`, 'error');
      NotificationService.handleSyncError(error as Error);
    }
  }

  /**
   * Handle push action
   */
  private async handlePush(): Promise<void> {
    this.updateStatus('syncing');
    this.sendLog('正在推送...', 'info');
    try {
      await this._syncService.push();
      this.updateStatus('synced');
      this.sendLog('推送完成', 'success');
      await this.sendGitStatus();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误';
      this.updateStatus('error');
      this.sendLog(`推送失败：${errorMsg}`, 'error');
      NotificationService.handleSyncError(error as Error);
    }
  }

  /**
   * Handle pull action
   */
  private async handlePull(): Promise<void> {
    this.updateStatus('syncing');
    this.sendLog('正在拉取...', 'info');
    try {
      await this._syncService.pull();
      this.updateStatus('synced');
      this.sendLog('拉取完成', 'success');
      await this.sendGitStatus();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误';
      this.updateStatus('error');
      this.sendLog(`拉取失败：${errorMsg}`, 'error');
      NotificationService.handleSyncError(error as Error);
    }
  }

  /**
   * Handle disconnect
   */
  private async handleDisconnect(): Promise<void> {
    // Delete credentials and clear URL
    await this._configService.deleteCredentials();
    await vscode.workspace.getConfiguration('antigravitySync')
      .update('repositoryUrl', '', vscode.ConfigurationTarget.Global);

    // Delete .git folder to allow connecting to different repo
    const syncRepoPath = this._configService.getSyncRepoPath();
    const gitPath = require('path').join(syncRepoPath, '.git');
    if (require('fs').existsSync(gitPath)) {
      require('fs').rmSync(gitPath, { recursive: true, force: true });
    }

    this._watcherService.stop();
    this._syncService.stopAutoSync();

    await this.sendConfigState();
  }

  /**
   * Update status in webview
   */
  private async updateStatus(status?: 'synced' | 'syncing' | 'error' | 'pending'): Promise<void> {
    if (!this._view) return;

    let lastSync: string | undefined;
    if (!status) {
      // Get actual status from service
      try {
        const syncStatus = await this._syncService.getStatus();
        status = syncStatus.syncStatus === '就绪' ? 'synced' : 'pending';
        lastSync = syncStatus.lastSync || undefined;
      } catch {
        status = 'synced';
      }
    }

    this._view.webview.postMessage({
      type: 'updateStatus',
      data: { status, lastSync }
    });
  }

  /**
   * Handle folder toggle from webview
   */
  private async handleFolderToggle(folder: string, enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('antigravitySync');
    const syncFolders = config.get<string[]>(
      'syncFolders',
      ['knowledge', 'brain', 'conversations', 'skills', 'annotations']
    );

    let newFolders: string[];
    if (enabled) {
      newFolders = [...new Set([...syncFolders, folder])];
    } else {
      newFolders = syncFolders.filter(f => f !== folder);
    }

    await config.update('syncFolders', newFolders, vscode.ConfigurationTarget.Global);
  }

  /**
   * Handle enable/disable sync toggle
   */
  private async handleToggleSyncEnabled(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('antigravitySync');
    await config.update('enabled', enabled, vscode.ConfigurationTarget.Global);

    // Notify user
    if (enabled) {
      this._watcherService.start();
      this._syncService.startAutoSync();
      NotificationService.info('已启用自动同步');
    } else {
      this._watcherService.stop();
      this._syncService.stopAutoSync();
      NotificationService.info('已暂停自动同步');
    }
  }

  /**
   * Send log message to webview
   */
  private sendLog(message: string, logType: 'success' | 'error' | 'info'): void {
    if (!this._view) return;
    this._view.webview.postMessage({
      type: 'log',
      data: { message, logType }
    });
  }

  /**
   * Send git status to webview
   */
  private async sendGitStatus(): Promise<void> {
    if (!this._view) return;

    try {
      const status = await this._syncService.getDetailedStatus();
      this._view.webview.postMessage({
        type: 'gitStatus',
        data: {
          ahead: status.ahead,
          behind: status.behind,
          files: status.files,
          totalFiles: status.totalFiles,
          syncRepoPath: this._configService.getSyncRepoPath()
        }
      });
    } catch {
      // Ignore errors
    }
  }

  /**
   * Show error in webview
   */
  public showError(message: string): void {
    if (!this._view) return;
    this._view.webview.postMessage({
      type: 'showError',
      data: { message }
    });
  }

  /**
   * Update panel data (for external calls)
   */
  public async updatePanelData(): Promise<void> {
    await this.sendConfigState();
  }

  /**
   * Try to auto-start Auto Retry (called from extension activation)
   * Only starts if CDP is available, otherwise logs error silently
   */
  public async tryAutoStartRetry(): Promise<void> {
    // Set up log callback
    this._autoRetryService.setLogCallback((msg, type) => {
      this.sendAutoRetryLog(msg, type === 'warning' ? 'info' : type);
    });

    // Check CDP status
    const cdpAvailable = await this._autoRetryService.isCDPAvailable();

    if (!cdpAvailable) {
      this.sendAutoRetryLog('自动启动失败：未检测到 CDP，请按提示重启 IDE。', 'error');
      this.sendAutoRetryStatus();
      return;
    }

    // CDP available - start
    this.sendAutoRetryLog('正在自动启动自动重试...', 'info');
    const started = await this._autoRetryService.start();

    if (started) {
      this.sendAutoRetryStatus();
      this.sendAutoRetryLog('✅ 自动重试已自动启动！', 'success');
    } else {
      this.sendAutoRetryLog('自动启动失败', 'error');
      this.sendAutoRetryStatus();
    }
  }

  /**
   * Handle start auto-retry from webview
   * Single button flow: check CDP -> if OK, start; if not, auto-setup
   */
  private async handleStartAutoRetry(): Promise<void> {
    this.sendAutoRetryLog('正在检查 CDP...', 'info');

    // Set up log callback
    this._autoRetryService.setLogCallback((msg, type) => {
      this.sendAutoRetryLog(msg, type === 'warning' ? 'info' : type);
    });

    // Check CDP status first
    const cdpAvailable = await this._autoRetryService.isCDPAvailable();

    if (!cdpAvailable) {
      // CDP not available - auto setup
      this.sendAutoRetryLog('未启用 CDP，正在设置...', 'info');
      const setupSuccess = await this._autoRetryService.setupCDP();

      if (setupSuccess) {
        // Setup done, user needs to restart - dialog already shown by Relauncher
        this.sendAutoRetryLog('请重启 IDE 以启用自动重试', 'info');
      } else {
        this.sendAutoRetryLog('设置失败，请查看上方说明。', 'error');
      }
      this.sendAutoRetryStatus();
      return;
    }

    // CDP available - start immediately
    this.sendAutoRetryLog('检测到 CDP，开始启动...', 'success');
    const started = await this._autoRetryService.start();

    if (started) {
      this.sendAutoRetryStatus();
      NotificationService.info('自动重试已启动，将自动点击 Retry 按钮');
    } else {
      this.sendAutoRetryStatus();
    }
  }

  /**
   * Handle stop auto-retry from webview
   */
  private async handleStopAutoRetry(): Promise<void> {
    await this._autoRetryService.stop();
    this.sendAutoRetryStatus();
    this.sendAutoRetryLog('自动重试已停止', 'info');
  }

  /**
   * Send auto-retry status to webview
   */
  private sendAutoRetryStatus(): void {
    if (!this._view) return;
    const status = this._autoRetryService.getStatus();
    this._view.webview.postMessage({
      type: 'autoRetryStatus',
      data: {
        running: status.running,
        retryCount: status.retryCount,
        connectionCount: status.connectionCount
      }
    });
  }

  /**
   * Send auto-retry log message to webview
   */
  private sendAutoRetryLog(message: string, logType: 'success' | 'error' | 'info'): void {
    if (!this._view) return;
    this._view.webview.postMessage({
      type: 'autoRetryLog',
      data: { message, logType }
    });
  }

  /**
   * Handle set auto-start setting from webview
   */
  private async handleSetAutoStart(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('antigravitySync');
    await config.update('autoStartRetry', enabled, vscode.ConfigurationTarget.Global);
    this.sendAutoRetryLog(enabled ? '已开启自动启动' : '已关闭自动启动', 'info');
  }

  /**
   * Send auto-start setting to webview
   */
  private sendAutoStartSetting(): void {
    if (!this._view) return;
    const config = vscode.workspace.getConfiguration('antigravitySync');
    const enabled = config.get('autoStartRetry', false);
    this._view.webview.postMessage({
      type: 'autoStartSetting',
      data: { enabled }
    });
  }

  /**
   * Generate HTML for the webview
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'media', 'styles.css')
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src https://microsoft.github.io; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link href="${styleUri}" rel="stylesheet">
    <title>Antigravity 同步</title>
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
