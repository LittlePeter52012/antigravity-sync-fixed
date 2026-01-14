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

    if (!config.autoSync) {
      return;
    }

    // Ignored patterns for chokidar (don't even watch these)
    const ignored = [
      '**/browser_recordings/**',
      '**/*.pb',
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
      .on('error', error => console.error('Watcher error:', error));

    console.log(`Watching for changes in: ${config.geminiPath}`);
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
    console.log(`File ${event}: ${filePath}`);
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

    console.log(`Syncing ${this.pendingChanges.size} pending changes...`);
    this.pendingChanges.clear();

    try {
      await this.syncService.push();
    } catch (error) {
      console.error('Auto-sync failed:', error);
    }
  }
}
