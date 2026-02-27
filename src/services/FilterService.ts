/**
 * FilterService - Handles file filtering for sensitive data protection
 */
import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

export class FilterService {
  private ig: Ignore;
  private geminiPath: string;
  private syncFolders: string[];

  // Default patterns that MUST always be excluded
  private static readonly DEFAULT_EXCLUDES = [
    // Antigravity internal - NOT needed for sync (both root and nested)
    'antigravity-browser-profile/**',
    '**/browser_recordings/**',
    '**/code_tracker/**',
    '**/context_state/**',
    '**/implicit/**',
    '**/playground/**',

    // Config files that are machine-specific
    '**/browserAllowlist.txt',
    '**/browserOnboardingStatus.txt',
    '**/installation_id',
    '**/user_settings.pb',

    // OAuth and credentials
    'google_accounts.json',
    'oauth_creds.json',
    '**/credentials.json',
    '**/secrets.json',
    '**/*.key',
    '**/*.pem',

    // Large binary files
    '**/*.webm',
    '**/*.mp4',
    '**/*.mov',
    '**/*.webp',

    // Temp/log files (NOT *.pb - conversations are .pb files!)
    '**/*.log',
    '**/node_modules/',

    // System files
    '.DS_Store',
    'Thumbs.db',

    // Git internals (handled by git itself, but just in case)
    '.git/'
  ];

  constructor(geminiPath: string, customPatterns: string[] = [], syncFolders: string[] = []) {
    this.geminiPath = geminiPath;
    this.syncFolders = syncFolders;
    this.ig = ignore();

    // Add default excludes
    this.ig.add(FilterService.DEFAULT_EXCLUDES);

    // Add custom patterns from settings
    if (customPatterns.length > 0) {
      this.ig.add(customPatterns);
    }

    // Load .antigravityignore if exists
    this.loadIgnoreFile();
  }

  /**
   * Load custom ignore patterns from .antigravityignore
   */
  private loadIgnoreFile(): void {
    const ignoreFilePath = path.join(this.geminiPath, '.antigravityignore');

    if (fs.existsSync(ignoreFilePath)) {
      const content = fs.readFileSync(ignoreFilePath, 'utf-8');
      const patterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      if (patterns.length > 0) {
        this.ig.add(patterns);
      }
    }
  }

  /**
   * Check if a file should be ignored
   */
  shouldIgnore(relativePath: string): boolean {
    return this.ig.ignores(relativePath);
  }

  /**
   * Filter a list of files, returning only those that should be synced
   */
  filterFiles(files: string[]): string[] {
    return files.filter(file => !this.shouldIgnore(file));
  }

  /**
   * Get all files that should be synced from the gemini directory
   */
  async getFilesToSync(): Promise<string[]> {
    const files: string[] = [];

    if (this.syncFolders.length > 0) {
      // Only walk specified sync folders
      for (const folder of this.syncFolders) {
        const folderPath = path.join(this.geminiPath, folder);
        if (fs.existsSync(folderPath)) {
          await this.walkDirectory(this.geminiPath, folder, files);
        }
      }
    } else {
      // Fallback: walk entire geminiPath (backward compatible)
      await this.walkDirectory(this.geminiPath, '', files);
    }

    return files;
  }

  /**
   * Recursively walk directory and collect non-ignored files
   */
  private async walkDirectory(basePath: string, relativePath: string, files: string[]): Promise<void> {
    const currentPath = path.join(basePath, relativePath);

    if (!fs.existsSync(currentPath)) {
      return;
    }

    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

      // Check if should be ignored
      if (this.shouldIgnore(entryRelativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.walkDirectory(basePath, entryRelativePath, files);
      } else {
        files.push(entryRelativePath);
      }
    }
  }

  /**
   * Get the default exclude patterns (for documentation/display)
   */
  static getDefaultExcludes(): string[] {
    return [...FilterService.DEFAULT_EXCLUDES];
  }
}
