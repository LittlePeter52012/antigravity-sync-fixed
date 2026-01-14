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

export class SyncService {
  private context: vscode.ExtensionContext;
  private configService: ConfigService;
  private statusBar: StatusBarService;
  private gitService: GitService | null = null;
  private filterService: FilterService | null = null;
  private isSyncing = false;

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
      throw new Error('Repository or access token not configured');
    }

    // Initialize Git service
    const syncRepoPath = this.configService.getSyncRepoPath();
    this.gitService = new GitService(syncRepoPath);
    await this.gitService.initializeRepository(config.repositoryUrl, token);

    // Initialize filter service
    this.filterService = new FilterService(
      config.geminiPath,
      config.excludePatterns
    );

    // Copy initial files
    await this.copyFilesToSyncRepo();

    // Status is Pending until first push
    this.statusBar.update(SyncState.Pending);
  }

  /**
   * Full sync (push + pull)
   */
  async sync(): Promise<void> {
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;
    this.statusBar.update(SyncState.Syncing);

    try {
      await this.pull();
      await this.push();
      this.statusBar.update(SyncState.Synced);
    } catch (error) {
      this.statusBar.update(SyncState.Error);
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Push local changes to remote
   */
  async push(): Promise<void> {
    if (!this.gitService) {
      throw new Error('Sync not initialized');
    }

    this.statusBar.update(SyncState.Pushing);

    try {
      // Pull first to avoid divergent branches
      await this.gitService.pull();

      // Copy filtered files to sync repo
      await this.copyFilesToSyncRepo();

      // Stage and commit
      await this.gitService.stageAll();
      const commitHash = await this.gitService.commit(
        `Sync: ${new Date().toISOString()}`
      );

      if (commitHash) {
        await this.gitService.push();
      }

      this.statusBar.update(SyncState.Synced);
    } catch (error) {
      this.statusBar.update(SyncState.Error);
      throw error;
    }
  }

  /**
   * Pull remote changes to local
   */
  async pull(): Promise<void> {
    if (!this.gitService) {
      throw new Error('Sync not initialized');
    }

    this.statusBar.update(SyncState.Pulling);

    try {
      await this.gitService.pull();
      await this.copyFilesFromSyncRepo();
      this.statusBar.update(SyncState.Synced);
    } catch (error) {
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
      syncStatus: this.isSyncing ? 'Syncing...' : 'Ready',
      lastSync,
      pendingChanges,
      repository: config.repositoryUrl || null
    };
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
   */
  private async copyFilesToSyncRepo(): Promise<void> {
    const config = this.configService.getConfig();
    const syncRepoPath = this.configService.getSyncRepoPath();

    if (!this.filterService) {
      return;
    }

    const filesToSync = await this.filterService.getFilesToSync();

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
      }
    }
  }

  /**
   * Copy files from sync repo back to gemini folder
   */
  private async copyFilesFromSyncRepo(): Promise<void> {
    const config = this.configService.getConfig();
    const syncRepoPath = this.configService.getSyncRepoPath();

    // Walk sync repo and copy back (excluding .git)
    await this.copyDirectoryContents(syncRepoPath, config.geminiPath, ['.git']);
  }

  /**
   * Recursively copy directory contents
   */
  private async copyDirectoryContents(
    source: string,
    dest: string,
    excludeDirs: string[] = []
  ): Promise<void> {
    if (!fs.existsSync(source)) {
      return;
    }

    const entries = fs.readdirSync(source, { withFileTypes: true });

    for (const entry of entries) {
      if (excludeDirs.includes(entry.name)) {
        continue;
      }

      const sourcePath = path.join(source, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        await this.copyDirectoryContents(sourcePath, destPath, excludeDirs);
      } else {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(sourcePath, destPath);
      }
    }
  }
}
