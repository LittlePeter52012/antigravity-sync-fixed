/**
 * ConfigService - Manages extension configuration and credentials
 */
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export interface SyncConfig {
  repositoryUrl: string;
  autoSync: boolean;
  syncIntervalMinutes: number;
  excludePatterns: string[];
  geminiPath: string;
}

export class ConfigService {
  private static readonly SECRETS_KEY = 'antigravitySync.gitToken';
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Get the full configuration
   */
  getConfig(): SyncConfig {
    const config = vscode.workspace.getConfiguration('antigravitySync');
    return {
      repositoryUrl: config.get<string>('repositoryUrl', ''),
      autoSync: config.get<boolean>('autoSync', true),
      syncIntervalMinutes: config.get<number>('syncIntervalMinutes', 5),
      excludePatterns: config.get<string[]>('excludePatterns', []),
      geminiPath: config.get<string>('geminiPath', '') || this.getDefaultGeminiPath()
    };
  }

  /**
   * Check if extension is configured
   */
  async isConfigured(): Promise<boolean> {
    const config = this.getConfig();
    const pat = await this.getCredentials();
    return !!(config.repositoryUrl && pat);
  }

  /**
   * Get default .gemini/antigravity path (the actual context folder)
   */
  getDefaultGeminiPath(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity');
  }

  /**
   * Get the sync repository local path
   */
  getSyncRepoPath(): string {
    return path.join(os.homedir(), '.gemini-sync-repo');
  }


  /**
   * Save Git access token securely
   */
  async saveCredentials(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.SECRETS_KEY, token);
  }

  /**
   * Get Git access token
   */
  async getCredentials(): Promise<string | undefined> {
    return await this.context.secrets.get(ConfigService.SECRETS_KEY);
  }

  /**
   * Delete credentials
   */
  async deleteCredentials(): Promise<void> {
    await this.context.secrets.delete(ConfigService.SECRETS_KEY);
  }

  /**
   * Set repository URL
   */
  async setRepositoryUrl(url: string): Promise<void> {
    await vscode.workspace.getConfiguration('antigravitySync')
      .update('repositoryUrl', url, vscode.ConfigurationTarget.Global);
  }

  /**
   * Parse repository URL to get owner and repo name
   */
  parseRepositoryUrl(url: string): { owner: string; repo: string } | null {
    // Handle various URL formats
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git

    const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    return null;
  }
}
