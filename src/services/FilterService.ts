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
    // 1. Ignore EVERYTHING at the root level by default for safety
    '/*',

    // 2. EXPLICITLY ALLOW (un-ignore) core Antigravity directories
    // We un-ignore both the folder name and its entire contents
    '!/annotations',
    '!/annotations/**',
    '!/brain',
    '!/brain/**',
    '!/conversations',
    '!/conversations/**',
    '!/global_skills',
    '!/global_skills/**',
    '!/knowledge',
    '!/knowledge/**',
    '!/skills',
    '!/skills/**',
    // Also allow mcp_config.json (field-level smart merge handles path safety)
    '!/mcp_config.json',

    // 3. EXPLICITLY IGNORE dangerous/machine-specific things deeply (even inside allowed folders)
    
    // Temp and system files
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/*.tmp',
    '**/*.bak',
    '**/__pycache__/**',
    '**/.sync.lock',

    // Antigravity internal/machine-specific state
    '**/browser_recordings/**',
    '**/code_tracker/**',
    '**/context_state/**',
    '**/implicit/**',
    '**/playground/**',
    '**/html_artifacts/**',

    // Config files that are machine-specific
    '**/browserAllowlist.txt',
    '**/browserOnboardingStatus.txt',
    '**/installation_id',
    '**/user_settings.pb',
    '**/onboarding.json',
    '**/onboarding.json.lock',

    // OAuth and credentials
    '**/google_accounts.json',
    '**/oauth_creds.json',
    '**/credentials.json',
    '**/secrets.json',
    '**/*.key',
    '**/*.pem',

    // Large binary files
    '**/*.webm',
    '**/*.mp4',
    '**/*.mov',
    '**/*.webp',

    // Log & module files
    '**/*.log',
    '**/node_modules/**',

    // Git internals (handled by git itself, but added for completeness here)
    '**/.git/**'
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
   * Recursively walk directory and collect non-ignored files.
   * Handles symlinks correctly: follows symlinks to determine real type,
   * skips dangling/broken symlinks and non-regular files (sockets, FIFOs, etc.)
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

      const fullPath = path.join(currentPath, entry.name);

      // For symlinks, resolve to real type via fs.statSync (follows symlinks)
      // Also handles edge cases: dangling symlinks, sockets, FIFOs, etc.
      if (entry.isSymbolicLink()) {
        try {
          const realStat = fs.statSync(fullPath); // follows symlink
          if (realStat.isDirectory()) {
            await this.walkDirectory(basePath, entryRelativePath, files);
          } else if (realStat.isFile()) {
            files.push(entryRelativePath);
          }
          // Skip sockets, FIFOs, block/char devices, etc.
        } catch {
          // Dangling symlink or permission error - skip silently
          continue;
        }
      } else if (entry.isDirectory()) {
        await this.walkDirectory(basePath, entryRelativePath, files);
      } else if (entry.isFile()) {
        files.push(entryRelativePath);
      }
      // Skip non-regular, non-directory, non-symlink entries (sockets, FIFOs, etc.)
    }
  }

  /**
   * Get the default exclude patterns (for documentation/display)
   */
  static getDefaultExcludes(): string[] {
    return [...FilterService.DEFAULT_EXCLUDES];
  }
}
