/**
 * WatcherService - File system watcher for auto-sync
 *
 * Enhanced with:
 * - Fast debounce (15s idle) for responsive push after conversation ends
 * - Rate limiter (min 2 minutes between syncs) to prevent GitHub API abuse/banning
 * - Full sync (pull + push) instead of push-only for bidirectional freshness
 */
import * as chokidar from 'chokidar';
import { ConfigService } from './ConfigService';
import { SyncService } from './SyncService';

/** Minimum interval between consecutive syncs (milliseconds) - protects against GitHub rate limits */
const MIN_SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
/** Default debounce delay when file changes stop (milliseconds) */
const DEFAULT_DEBOUNCE_MS = 15 * 1000; // 15 seconds

export class WatcherService {
  private configService: ConfigService;
  private syncService: SyncService;
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingChanges: Set<string> = new Set();
  private lastSyncTime: number = 0;
  private rateLimitTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;

  constructor(configService: ConfigService, syncService: SyncService) {
    this.configService = configService;
    this.syncService = syncService;
  }

  /**
   * Start watching for file changes
   */
  start(): void {
    const config = this.configService.getConfig();

    if (!config.enabled || !config.autoSync) {
      return;
    }

    if (this.watcher) {
      return;
    }

    // Ignored patterns for chokidar (don't even watch these)
    const ignored = [
      '**/browser_recordings/**',
      '**/user_settings.pb',
      '**/node_modules/**',
      '**/.git/**',
      '**/google_accounts.json',
      '**/oauth_creds.json',
      '**/.sync-conflicts/**',
      '**/*.conflict-*'
    ];

    this.watcher = chokidar.watch(config.geminiPath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      depth: 10,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', path => this.handleChange('add', path))
      .on('change', path => this.handleChange('change', path))
      .on('unlink', path => this.handleChange('unlink', path))
      .on('error', error => console.error('监听器错误：', error));

    console.log(`[WatcherService] 正在监听目录变更：${config.geminiPath}`);
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.rateLimitTimer) {
      clearTimeout(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }

    this.pendingChanges.clear();
    this.consecutiveFailures = 0;
  }

  /**
   * Handle file change with fast debounce (15s idle)
   */
  private handleChange(event: string, filePath: string): void {
    const eventLabel = event === 'add'
      ? '新增'
      : event === 'change'
        ? '修改'
        : event === 'unlink'
          ? '删除'
          : event;
    console.log(`[WatcherService] 文件${eventLabel}：${filePath}`);
    this.pendingChanges.add(filePath);

    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Fast debounce: trigger sync after 15s of no file changes
    this.debounceTimer = setTimeout(() => {
      this.scheduleSync();
    }, DEFAULT_DEBOUNCE_MS);
  }

  /**
   * Schedule sync with rate limiting (exponential backoff on failures)
   */
  private scheduleSync(): void {
    if (this.pendingChanges.size === 0) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastSyncTime;

    // Calculate effective cooldown with exponential backoff on failures
    const backoffMultiplier = Math.min(Math.pow(2, this.consecutiveFailures), 16);
    const effectiveCooldown = MIN_SYNC_INTERVAL_MS * backoffMultiplier;

    if (elapsed < effectiveCooldown) {
      // Too soon - schedule for after the cooldown period
      const delay = effectiveCooldown - elapsed;
      console.log(`[WatcherService] 限流保护：距上次同步仅 ${Math.round(elapsed / 1000)}s，${Math.round(delay / 1000)}s 后重试`);

      if (this.rateLimitTimer) {
        clearTimeout(this.rateLimitTimer);
      }
      this.rateLimitTimer = setTimeout(() => {
        this.triggerSync();
      }, delay);
      return;
    }

    this.triggerSync();
  }

  /**
   * Trigger full sync (pull + push) after debounce + rate limit
   */
  private async triggerSync(): Promise<void> {
    if (this.pendingChanges.size === 0) {
      return;
    }

    const config = this.configService.getConfig();
    if (!config.enabled || !config.autoSync) {
      this.pendingChanges.clear();
      return;
    }

    const changeCount = this.pendingChanges.size;
    console.log(`[WatcherService] 检测到 ${changeCount} 个待同步变更，正在同步...`);
    this.pendingChanges.clear();
    this.lastSyncTime = Date.now();

    try {
      // Full sync (pull + push) to ensure bidirectional freshness
      await this.syncService.sync();
      this.consecutiveFailures = 0; // Reset backoff on success
      console.log('[WatcherService] 自动同步成功');
    } catch (error) {
      this.consecutiveFailures++;
      const backoff = Math.min(Math.pow(2, this.consecutiveFailures), 16);
      console.error(
        `[WatcherService] 自动同步失败（连续第 ${this.consecutiveFailures} 次，` +
        `下次退避 ${backoff}x）：`,
        error
      );
    }
  }
}
