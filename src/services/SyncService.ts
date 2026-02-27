/**
 * SyncService - Core sync orchestration
 * Provider-agnostic: works with any Git remote (GitHub, GitLab, Bitbucket, etc.)
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from './ConfigService';
import { GitService } from './GitService';
import { FilterService } from './FilterService';
import { StatusBarService, SyncState } from './StatusBarService';

export interface SyncStatus {
  syncStatus: string;
  lastSync: string | null;
  pendingChanges: number;
  repository: string | null;
}

// Helper to format timestamp
function ts(): string {
  const now = new Date();
  return `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}]`;
}

// Lock file settings - prevent multiple VS Code windows from syncing simultaneously
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes - stale lock timeout

export class SyncService {
  private context: vscode.ExtensionContext;
  private configService: ConfigService;
  private statusBar: StatusBarService;
  private gitService: GitService | null = null;
  private filterService: FilterService | null = null;
  private isSyncing = false;

  // Auto-sync timer
  private autoSyncTimer: NodeJS.Timeout | null = null;
  private nextSyncTime: number = 0;
  private countdownCallback: ((seconds: number) => void) | null = null;
  private countdownInterval: NodeJS.Timeout | null = null;

  constructor(
    context: vscode.ExtensionContext,
    configService: ConfigService,
    statusBar: StatusBarService
  ) {
    this.context = context;
    this.configService = configService;
    this.statusBar = statusBar;
  }

  /**
   * Initialize sync - setup git and filter services
   * Works with any Git provider (GitHub, GitLab, Bitbucket, etc.)
   */
  async initialize(): Promise<void> {
    const config = this.configService.getConfig();
    const token = await this.configService.getCredentials();

    if (!config.repositoryUrl || !token) {
      throw new Error('仓库地址或访问令牌未配置');
    }

    // Initialize Git service
    const syncRepoPath = this.configService.getSyncRepoPath();
    this.gitService = new GitService(syncRepoPath);
    await this.gitService.initializeRepository(config.repositoryUrl, token);

    // Initialize filter service
    this.filterService = new FilterService(
      config.geminiPath,
      config.excludePatterns,
      config.syncFolders
    );

    // Copy initial files
    await this.copyFilesToSyncRepo();

    // Status is Pending until first push
    this.statusBar.update(SyncState.Pending);
  }

  /**
   * Get lock file path
   */
  private getLockFilePath(): string {
    return path.join(this.configService.getSyncRepoPath(), '.sync.lock');
  }

  /**
   * Acquire sync lock - prevents multiple VS Code windows from syncing simultaneously
   * Uses atomic file creation with timeout for stale locks
   */
  private acquireLock(): boolean {
    const lockFile = this.getLockFilePath();

    // Check for existing lock
    if (fs.existsSync(lockFile)) {
      try {
        const lockTime = parseInt(fs.readFileSync(lockFile, 'utf-8'));
        if (Date.now() - lockTime > LOCK_TIMEOUT_MS) {
          // Lock is stale (> 5 min), remove it
          console.log(ts() + ' [SyncService] 检测到过期锁，正在清理...');
          fs.unlinkSync(lockFile);
        } else {
          // Lock is still valid
          console.log(ts() + ' [SyncService] 另一个同步正在进行，已跳过');
          return false;
        }
      } catch {
        // Error reading lock, try to remove it
        fs.unlinkSync(lockFile);
      }
    }

    // Try to create lock atomically
    try {
      fs.writeFileSync(lockFile, Date.now().toString(), { flag: 'wx' });
      console.log(ts() + ' [SyncService] 已获取同步锁');
      return true;
    } catch {
      // Another process got the lock first
      console.log(ts() + ' [SyncService] 获取同步锁失败，另一个同步已启动');
      return false;
    }
  }

  /**
   * Release sync lock
   */
  private releaseLock(): void {
    const lockFile = this.getLockFilePath();
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        console.log(ts() + ' [SyncService] 已释放同步锁');
      }
    } catch {
      // Ignore errors when releasing lock
    }
  }

  /**
   * Full sync (push + pull)
   */
  async sync(): Promise<void> {
    if (this.isSyncing) {
      console.log(ts() + ' [SyncService.sync] 当前窗口正在同步，已跳过');
      return;
    }

    // Try to acquire cross-window lock
    if (!this.acquireLock()) {
      return;
    }

    this.isSyncing = true;
    this.statusBar.update(SyncState.Syncing);
    console.log(ts() + ' [SyncService.sync] === 开始同步 ===');

    try {
      // Pull remote changes first
      console.log(ts() + ' [SyncService.sync] 步骤 1：拉取远端更改...');
      await this.pull();

      // Push local changes (no need to pull again, already done)
      console.log(ts() + ' [SyncService.sync] 步骤 2：推送本地更改...');
      await this.pushWithoutPull();

      console.log(ts() + ' [SyncService.sync] === 同步完成 ===');
      this.statusBar.update(SyncState.Synced);
    } catch (error) {
      console.log(ts() + ` [SyncService.sync] 同步失败：${(error as Error).message}`);
      this.statusBar.update(SyncState.Error);
      throw error;
    } finally {
      this.isSyncing = false;
      this.releaseLock();
    }
  }

  /**
   * Push local changes to remote
   */
  async push(): Promise<void> {
    if (!this.gitService) {
      throw new Error('同步尚未初始化');
    }

    this.statusBar.update(SyncState.Pushing);
    console.log('[SyncService.push] === 开始推送 ===');

    try {
      // Pull first to avoid divergent branches (when called standalone)
      console.log('[SyncService.push] 步骤 1：先拉取以避免分支分叉...');
      await this.gitService.pull();

      // Copy filtered files to sync repo
      console.log('[SyncService.push] 步骤 2：复制本地文件到同步仓库...');
      const filesCopied = await this.copyFilesToSyncRepo();
      console.log(`[SyncService.push] 已复制 ${filesCopied} 个文件到同步仓库`);

      // Stage and commit
      console.log('[SyncService.push] 步骤 3：暂存并提交...');
      await this.gitService.stageAll();
      const commitHash = await this.gitService.commit(
        `同步：${new Date().toISOString()}`
      );

      if (commitHash) {
        console.log(`[SyncService.push] 步骤 4：推送提交 ${commitHash.substring(0, 7)}...`);
        await this.gitService.push();
        console.log('[SyncService.push] 推送成功！');
      } else {
        console.log('[SyncService.push] 没有需要提交的更改');
      }

      console.log('[SyncService.push] === 推送完成 ===');
      this.statusBar.update(SyncState.Synced);
    } catch (error) {
      console.log(`[SyncService.push] 推送失败：${(error as Error).message}`);
      this.statusBar.update(SyncState.Error);
      throw error;
    }
  }

  /**
   * Push without initial pull (used by sync() to avoid double pull)
   */
  private async pushWithoutPull(): Promise<void> {
    if (!this.gitService) {
      throw new Error('同步尚未初始化');
    }

    // Copy filtered files to sync repo
    console.log('[SyncService.pushWithoutPull] 复制本地文件到同步仓库...');
    const filesCopied = await this.copyFilesToSyncRepo();
    console.log(`[SyncService.pushWithoutPull] 已复制 ${filesCopied} 个文件`);

    // Stage and commit
    console.log('[SyncService.pushWithoutPull] 暂存并提交...');
    await this.gitService.stageAll();
    const commitHash = await this.gitService.commit(
      `同步：${new Date().toISOString()}`
    );

    if (commitHash) {
      console.log(`[SyncService.pushWithoutPull] 推送提交 ${commitHash.substring(0, 7)}...`);
      await this.gitService.push();
      console.log('[SyncService.pushWithoutPull] 推送成功！');
    } else {
      console.log('[SyncService.pushWithoutPull] 没有需要提交的更改');
    }
  }

  /**
   * Pull remote changes to local
   */
  async pull(): Promise<void> {
    if (!this.gitService) {
      throw new Error('同步尚未初始化');
    }

    this.statusBar.update(SyncState.Pulling);
    console.log('[SyncService.pull] === 开始拉取 ===');

    try {
      await this.gitService.pull();

      console.log('[SyncService.pull] 正在从同步仓库复制文件到 Gemini 目录...');
      const filesCopied = await this.copyFilesFromSyncRepo();
      console.log(`[SyncService.pull] 已复制 ${filesCopied} 个文件到 Gemini 目录`);

      console.log('[SyncService.pull] === 拉取完成 ===');
      this.statusBar.update(SyncState.Synced);
    } catch (error) {
      console.log(`[SyncService.pull] 拉取失败：${(error as Error).message}`);
      this.statusBar.update(SyncState.Error);
      throw error;
    }
  }

  /**
   * Get current sync status
   */
  async getStatus(): Promise<SyncStatus> {
    const config = this.configService.getConfig();
    let pendingChanges = 0;
    let lastSync: string | null = null;

    if (this.gitService) {
      pendingChanges = await this.gitService.getPendingChangesCount();
      lastSync = await this.gitService.getLastCommitDate();
    }

    return {
      syncStatus: this.isSyncing ? '同步中...' : '就绪',
      lastSync,
      pendingChanges,
      repository: config.repositoryUrl || null
    };
  }

  /**
   * Copy files only (for refresh status without push)
   */
  async copyFilesOnly(): Promise<void> {
    if (!this.filterService) {
      return;
    }
    await this.copyFilesToSyncRepo();
  }

  /**
   * Get detailed git status for UI
   */
  async getDetailedStatus(): Promise<{
    ahead: number;
    behind: number;
    files: string[];
    totalFiles: number;
  }> {
    if (!this.gitService) {
      return { ahead: 0, behind: 0, files: [], totalFiles: 0 };
    }

    // Fetch from remote first to get accurate behind count
    try {
      await this.gitService.fetch();
    } catch {
      // Ignore fetch errors (offline, etc.)
    }

    const aheadBehind = await this.gitService.getAheadBehind();
    const changedFiles = await this.gitService.getChangedFiles(10);

    return {
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      files: changedFiles.files,
      totalFiles: changedFiles.total
    };
  }

  /**
   * Copy filtered files from gemini folder to sync repo
   * @returns number of files copied
   */
  private async copyFilesToSyncRepo(): Promise<number> {
    const config = this.configService.getConfig();
    const syncRepoPath = this.configService.getSyncRepoPath();

    if (!this.filterService) {
      return 0;
    }

    const filesToSync = await this.filterService.getFilesToSync();
    let copiedCount = 0;

    for (const relativePath of filesToSync) {
      const sourcePath = path.join(config.geminiPath, relativePath);
      const destPath = path.join(syncRepoPath, relativePath);

      // Ensure directory exists
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // Copy file
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        copiedCount++;
      }
    }

    return copiedCount;
  }

  /**
   * Copy files from sync repo back to gemini folder
   * @returns number of files copied
   */
  private async copyFilesFromSyncRepo(): Promise<number> {
    const config = this.configService.getConfig();
    const syncRepoPath = this.configService.getSyncRepoPath();

    // Walk sync repo and copy back (excluding .git)
    return await this.copyDirectoryContents(syncRepoPath, config.geminiPath, ['.git']);
  }

  /**
   * Recursively copy directory contents
   * @returns number of files copied
   */
  private async copyDirectoryContents(
    source: string,
    dest: string,
    excludeDirs: string[] = []
  ): Promise<number> {
    if (!fs.existsSync(source)) {
      return 0;
    }

    let count = 0;
    const entries = fs.readdirSync(source, { withFileTypes: true });

    for (const entry of entries) {
      if (excludeDirs.includes(entry.name)) {
        continue;
      }

      const sourcePath = path.join(source, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        count += await this.copyDirectoryContents(sourcePath, destPath, excludeDirs);
      } else {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(sourcePath, destPath);
        count++;
      }
    }

    return count;
  }

  /**
   * Set callback for countdown updates
   */
  setCountdownCallback(callback: (seconds: number) => void): void {
    this.countdownCallback = callback;
  }

  /**
   * Set logger callback for GitService to send logs to UI
   */
  setGitLogger(logger: (message: string, type: 'info' | 'success' | 'error') => void): void {
    if (this.gitService) {
      this.gitService.setLogger(logger);
    }
  }

  /**
   * Start auto-sync timer
   */
  startAutoSync(): void {
    this.stopAutoSync(); // Clear any existing timer

    const config = this.configService.getConfig();
    if (!config.enabled || !config.autoSync) {
      return;
    }

    const intervalMs = Math.max(1, config.syncIntervalMinutes) * 60 * 1000;
    this.nextSyncTime = Date.now() + intervalMs;

    // Start countdown interval (every second)
    this.countdownInterval = setInterval(() => {
      const secondsLeft = Math.max(0, Math.ceil((this.nextSyncTime - Date.now()) / 1000));
      if (this.countdownCallback) {
        this.countdownCallback(secondsLeft);
      }
    }, 1000);

    // Start sync timer
    this.autoSyncTimer = setInterval(async () => {
      try {
        await this.sync();
        this.nextSyncTime = Date.now() + intervalMs;
      } catch (error) {
        console.error('自动同步失败：', error);
      }
    }, intervalMs);
  }

  /**
   * Stop auto-sync timer
   */
  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.nextSyncTime = 0;
    if (this.countdownCallback) {
      this.countdownCallback(0);
    }
  }

  /**
   * Get next sync time in seconds
   */
  getSecondsUntilNextSync(): number {
    if (!this.nextSyncTime) return 0;
    return Math.max(0, Math.ceil((this.nextSyncTime - Date.now()) / 1000));
  }
}
