/**
 * WatcherService - File system watcher for auto-sync
 */
import * as chokidar from 'chokidar';
import { ConfigService } from './ConfigService';
import { SyncService } from './SyncService';

export class WatcherService {
  private configService: ConfigService;
  private syncService: SyncService;
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingChanges: Set<string> = new Set();

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
      '**/oauth_creds.json'
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

    console.log(`正在监听目录变更：${config.geminiPath}`);
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

    this.pendingChanges.clear();
  }

  /**
   * Handle file change with debouncing
   */
  private handleChange(event: string, filePath: string): void {
    const eventLabel = event === 'add'
      ? '新增'
      : event === 'change'
        ? '修改'
        : event === 'unlink'
          ? '删除'
          : event;
    console.log(`文件${eventLabel}：${filePath}`);
    this.pendingChanges.add(filePath);

    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set new timer - sync after X minutes of inactivity
    const config = this.configService.getConfig();
    const delayMs = config.syncIntervalMinutes * 60 * 1000;

    this.debounceTimer = setTimeout(() => {
      this.triggerSync();
    }, delayMs);
  }

  /**
   * Trigger sync after debounce period
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

    console.log(`检测到 ${this.pendingChanges.size} 个待同步变更，正在同步...`);
    this.pendingChanges.clear();

    try {
      await this.syncService.push();
    } catch (error) {
      console.error('自动同步失败：', error);
    }
  }
}
