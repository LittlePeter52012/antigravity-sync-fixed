/**
 * SyncService - Core sync orchestration
 * Provider-agnostic: works with any Git remote (GitHub, GitLab, Bitbucket, etc.)
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigService, SyncConfig } from './ConfigService';
import { GitService } from './GitService';
import { FilterService } from './FilterService';
import { StatusBarService, SyncState } from './StatusBarService';

export interface SyncStatus {
  syncStatus: string;
  lastSync: string | null;
  pendingChanges: number;
  repository: string | null;
}

export interface PullStats {
  copied: number;
  skippedLocalNewer: number;
  conflictCopies: number;
  skippedConflictArtifacts: number;
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

    // Ensure sync subdir exists and validate sync password
    const syncDataRoot = this.getSyncDataRoot(config);
    if (!fs.existsSync(syncDataRoot)) {
      fs.mkdirSync(syncDataRoot, { recursive: true });
    }
    await this.ensureSyncPassword(syncDataRoot, config);

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
      const pullStats = await this.pull();
      if (pullStats.skippedLocalNewer > 0) {
        console.log(
          ts() +
          ` [SyncService.sync] 检测到 ${pullStats.skippedLocalNewer} 个本地较新文件，已保留本地并生成 ${pullStats.conflictCopies} 个远端冲突副本`
        );
      }

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
      await this.gitService.pull('推送前拉取');

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
  async pull(): Promise<PullStats> {
    if (!this.gitService) {
      throw new Error('同步尚未初始化');
    }

    this.statusBar.update(SyncState.Pulling);
    console.log('[SyncService.pull] === 开始拉取 ===');

    try {
      await this.gitService.pull();

      console.log('[SyncService.pull] 正在从同步仓库复制文件到 Gemini 目录...');
      const pullStats = await this.copyFilesFromSyncRepo();
      console.log(
        `[SyncService.pull] 已复制 ${pullStats.copied} 个文件，` +
        `本地较新保留 ${pullStats.skippedLocalNewer} 个，` +
        `冲突副本 ${pullStats.conflictCopies} 个，` +
        `已跳过冲突工件 ${pullStats.skippedConflictArtifacts} 个`
      );

      console.log('[SyncService.pull] === 拉取完成 ===');
      this.statusBar.update(SyncState.Synced);
      return pullStats;
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
      const changedFiles = await this.gitService.getStatusFiles();
      const prefix = this.getSyncRepoPrefix(config);
      pendingChanges = this.filterByPrefix(changedFiles, prefix).length;
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
    const allChanged = await this.gitService.getStatusFiles();
    const prefix = this.getSyncRepoPrefix(this.configService.getConfig());
    const filtered = this.filterByPrefix(allChanged, prefix);
    const files = filtered.slice(0, 10).map(file => this.stripPrefix(file, prefix));

    return {
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      files,
      totalFiles: filtered.length
    };
  }

  /**
   * Copy filtered files from gemini folder to sync repo
   * @returns number of files copied
   */
  private async copyFilesToSyncRepo(): Promise<number> {
    const config = this.configService.getConfig();
    const syncDataRoot = this.getSyncDataRoot(config);
    const legacyRoot = this.configService.getSyncRepoPath();

    if (!this.filterService) {
      return 0;
    }

    const filesToSync = await this.filterService.getFilesToSync();
    let copiedCount = 0;

    for (const relativePath of filesToSync) {
      const sourcePath = path.join(config.geminiPath, relativePath);
      const destPath = path.join(syncDataRoot, relativePath);

      // Ensure directory exists
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // Copy file (skip if unchanged)
      if (fs.existsSync(sourcePath)) {
        const sourceStat = fs.statSync(sourcePath);
        let shouldCopy = true;
        if (fs.existsSync(destPath)) {
          const destStat = fs.statSync(destPath);
          if (destStat.size === sourceStat.size && destStat.mtimeMs === sourceStat.mtimeMs) {
            shouldCopy = false;
          }
        }

        if (shouldCopy) {
          fs.copyFileSync(sourcePath, destPath);
          fs.utimesSync(destPath, sourceStat.atime, sourceStat.mtime);
          copiedCount++;
        }
      }
    }

    return copiedCount;
  }

  /**
   * Copy files from sync repo back to gemini folder
   * Cloud-style restore policy:
   * - copy missing/older files from repo to local
   * - keep local file when it is newer, and save remote version as conflict snapshot
   * - never copy `.conflict-*` artifacts into runtime folders
   */
  private async copyFilesFromSyncRepo(): Promise<PullStats> {
    const config = this.configService.getConfig();
    const syncDataRoot = this.getSyncDataRoot(config);
    const legacyRoot = this.configService.getSyncRepoPath();
    const stats: PullStats = {
      copied: 0,
      skippedLocalNewer: 0,
      conflictCopies: 0,
      skippedConflictArtifacts: 0
    };

    const configuredFolders = config.syncFolders.length > 0
      ? config.syncFolders
      : ['knowledge', 'brain', 'conversations', 'skills', 'annotations'];

    const hasDataInSubdir = configuredFolders.some(folder => fs.existsSync(path.join(syncDataRoot, folder)));
    const hasDataInLegacyRoot = configuredFolders.some(folder => fs.existsSync(path.join(legacyRoot, folder)));
    const sourceRoot = hasDataInSubdir ? syncDataRoot : (hasDataInLegacyRoot ? legacyRoot : syncDataRoot);
    if (sourceRoot === legacyRoot && sourceRoot !== syncDataRoot) {
      console.log('[SyncService.pull] 检测到旧版仓库结构，正在从仓库根目录恢复数据');
    }

    for (const folder of configuredFolders) {
      const sourcePath = path.join(sourceRoot, folder);
      const destPath = path.join(config.geminiPath, folder);
      await this.copyFolderFromRepo(sourcePath, destPath, folder, config, stats);
    }

    return stats;
  }

  /**
   * Recursively copy one synced folder from repo to local path with conflict-safe policy
   */
  private async copyFolderFromRepo(
    source: string,
    dest: string,
    relativeRoot: string,
    config: SyncConfig,
    stats: PullStats
  ): Promise<void> {
    if (!fs.existsSync(source)) {
      return;
    }

    const entries = fs.readdirSync(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const destPath = path.join(dest, entry.name);
      const relativePath = path.posix.join(relativeRoot.replace(/\\/g, '/'), entry.name);

      if (entry.isDirectory()) {
        if (entry.name === '.sync') {
          continue;
        }
        await this.copyFolderFromRepo(sourcePath, destPath, relativePath, config, stats);
      } else {
        if (this.filterService?.shouldIgnore(relativePath)) {
          continue;
        }
        if (entry.name.includes('.conflict-')) {
          stats.skippedConflictArtifacts++;
          continue;
        }

        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        const sourceStat = fs.statSync(sourcePath);
        if (fs.existsSync(destPath)) {
          const destStat = fs.statSync(destPath);
          const equal = this.areFilesEqual(sourcePath, destPath, sourceStat, destStat);
          if (equal) {
            continue;
          }

          // Keep local newer file and archive pulled version for manual review.
          if (destStat.mtimeMs > sourceStat.mtimeMs + 1000) {
            stats.skippedLocalNewer++;
            if (this.writePulledConflictSnapshot(config.geminiPath, relativePath, sourcePath, sourceStat.mtimeMs)) {
              stats.conflictCopies++;
            }
            continue;
          }
        }

        fs.copyFileSync(sourcePath, destPath);
        fs.utimesSync(destPath, sourceStat.atime, sourceStat.mtime);
        stats.copied++;
      }
    }
  }

  private areFilesEqual(
    sourcePath: string,
    destPath: string,
    sourceStat: fs.Stats,
    destStat: fs.Stats
  ): boolean {
    if (sourceStat.size !== destStat.size) {
      return false;
    }
    if (Math.abs(sourceStat.mtimeMs - destStat.mtimeMs) < 1) {
      return true;
    }
    try {
      const sourceBuffer = fs.readFileSync(sourcePath);
      const destBuffer = fs.readFileSync(destPath);
      return sourceBuffer.equals(destBuffer);
    } catch {
      return false;
    }
  }

  private writePulledConflictSnapshot(
    geminiPath: string,
    relativePath: string,
    sourcePath: string,
    sourceMtimeMs: number
  ): boolean {
    const stamp = this.formatStamp(sourceMtimeMs);
    const parsed = path.parse(relativePath);
    const conflictName = `${parsed.name}.remote-${stamp}${parsed.ext}`;
    const conflictPath = path.join(geminiPath, '.sync-conflicts', parsed.dir, conflictName);
    const conflictDir = path.dirname(conflictPath);
    if (!fs.existsSync(conflictDir)) {
      fs.mkdirSync(conflictDir, { recursive: true });
    }
    try {
      fs.copyFileSync(sourcePath, conflictPath);
      return true;
    } catch {
      return false;
    }
  }

  private formatStamp(ms: number): string {
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
  }

  private getSyncRepoSubdir(config: SyncConfig): string {
    let subdir = (config.syncRepoSubdir || '.antigravity-sync').trim();
    if (!subdir || subdir === '.' || subdir === '/' || path.isAbsolute(subdir)) {
      return '.antigravity-sync';
    }
    subdir = subdir.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    if (subdir.includes('..')) {
      return '.antigravity-sync';
    }
    return subdir;
  }

  private getSyncDataRoot(config: SyncConfig): string {
    const subdir = this.getSyncRepoSubdir(config);
    return path.join(this.configService.getSyncRepoPath(), subdir);
  }

  private getSyncRepoPrefix(config: SyncConfig): string {
    const subdir = this.getSyncRepoSubdir(config).replace(/\\/g, '/').replace(/\/+$/, '');
    return subdir ? `${subdir}/` : '';
  }

  private filterByPrefix(files: string[], prefix: string): string[] {
    if (!prefix) return files;
    return files.filter(file => file.replace(/\\/g, '/').startsWith(prefix));
  }

  private stripPrefix(file: string, prefix: string): string {
    if (!prefix) return file;
    const normalized = file.replace(/\\/g, '/');
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : file;
  }

  private async ensureSyncPassword(syncDataRoot: string, config: SyncConfig): Promise<void> {
    if (!config.syncPasswordEnabled) {
      return;
    }

    const password = await this.configService.getSyncPassword();
    if (!password) {
      throw new Error('同步密码未设置');
    }

    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const metaDir = path.join(syncDataRoot, '.sync');
    const passwordFile = path.join(metaDir, 'password.sha256');

    if (!fs.existsSync(metaDir)) {
      fs.mkdirSync(metaDir, { recursive: true });
    }

    if (fs.existsSync(passwordFile)) {
      const existing = fs.readFileSync(passwordFile, 'utf8').trim();
      if (existing !== hash) {
        throw new Error('同步密码不匹配');
      }
      return;
    }

    fs.writeFileSync(passwordFile, `${hash}\n`, { mode: 0o600 });
  }

  /**
   * Reset sync password (write new hash to repo and push)
   */
  async resetSyncPassword(newPassword: string, token: string): Promise<void> {
    const config = this.configService.getConfig();
    if (!config.repositoryUrl) {
      throw new Error('仓库地址未配置');
    }
    if (!newPassword || newPassword.length < 6) {
      throw new Error('同步密码长度至少 6 位');
    }
    if (!token) {
      throw new Error('访问令牌未提供');
    }

    const syncRepoPath = this.configService.getSyncRepoPath();
    if (!this.gitService) {
      this.gitService = new GitService(syncRepoPath);
    }
    await this.gitService.initializeRepository(config.repositoryUrl, token);

    const syncDataRoot = this.getSyncDataRoot(config);
    const metaDir = path.join(syncDataRoot, '.sync');
    if (!fs.existsSync(metaDir)) {
      fs.mkdirSync(metaDir, { recursive: true });
    }

    const hash = crypto.createHash('sha256').update(newPassword).digest('hex');
    const passwordFile = path.join(metaDir, 'password.sha256');
    fs.writeFileSync(passwordFile, `${hash}\n`, { mode: 0o600 });

    const relativePath = path.relative(syncRepoPath, passwordFile).replace(/\\/g, '/');
    await this.gitService.stagePaths([relativePath]);
    const commitId = await this.gitService.commitPaths('重置同步密码', [relativePath]);
    if (commitId) {
      await this.gitService.push();
    }
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
