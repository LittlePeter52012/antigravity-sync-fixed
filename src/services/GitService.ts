/**
 * GitService - Local Git operations wrapper
 */
import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getCleanRemoteUrl, normalizeRepoIdentity } from './RepoValidationService';

const execAsync = promisify(exec);

export type LogType = 'info' | 'success' | 'error';
export type LoggerCallback = (message: string, type: LogType) => void;

export class GitService {
  private git: SimpleGit;
  private repoPath: string;
  private logger?: LoggerCallback;

  constructor(repoPath: string) {
    this.repoPath = repoPath;

    // CRITICAL: Ensure directory exists before simpleGit init
    if (!fs.existsSync(repoPath)) {
      fs.mkdirSync(repoPath, { recursive: true });
    }

    const options: Partial<SimpleGitOptions> = {
      baseDir: repoPath,
      binary: 'git',
      maxConcurrentProcesses: 1,
      trimmed: true
    };

    this.git = simpleGit(options);
  }

  /**
   * Set logger callback for sending logs to UI
   */
  setLogger(logger: LoggerCallback): void {
    this.logger = logger;
  }

  /**
   * Log message to both console and UI (if logger is set)
   */
  private log(message: string, type: LogType = 'info'): void {
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const formattedMessage = `[${timestamp}] ${message}`;
    console.log(formattedMessage);
    if (this.logger) {
      this.logger(formattedMessage, type);
    }
  }

  /**
   * Store credentials in Git credential manager
   * This stores credentials in the system's secure credential store
   */
  async storeCredentials(url: string, token: string): Promise<void> {
    const parsed = this.parseGitUrl(url);
    if (!parsed) {
      throw new Error('无效的 Git 仓库地址');
    }

    // Format for git credential store:
    // protocol=https
    // host=github.com
    // username=token (or oauth2 for GitLab)
    // password=<the actual token>
    const isGitLab = url.includes('gitlab');
    const username = isGitLab ? 'oauth2' : 'token';

    const credentialInput = `protocol=${parsed.protocol}\nhost=${parsed.host}\nusername=${username}\npassword=${token}\n`;

    try {
      // First, configure credential helper if not set
      await this.configureCredentialHelper();

      // Store the credential using git credential approve
      await new Promise<void>((resolve, reject) => {
        const child = exec('git credential approve', { cwd: this.repoPath }, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        child.stdin?.write(credentialInput);
        child.stdin?.end();
      });
    } catch (error) {
      // Fallback: try git credential-store directly
      const credentialStorePath = path.join(require('os').homedir(), '.git-credentials');
      const credentialLine = `${parsed.protocol}://${username}:${token}@${parsed.host}\n`;

      // Read existing credentials and check if this host already exists
      let existingContent = '';
      if (fs.existsSync(credentialStorePath)) {
        existingContent = fs.readFileSync(credentialStorePath, 'utf8');
        // Remove any existing credential for this host
        const lines = existingContent.split('\n').filter(line => !line.includes(`@${parsed.host}`));
        existingContent = lines.join('\n');
        if (existingContent && !existingContent.endsWith('\n')) {
          existingContent += '\n';
        }
      }

      fs.writeFileSync(credentialStorePath, existingContent + credentialLine, { mode: 0o600 });
    }
  }

  /**
   * Retrieve credentials from Git credential manager
   */
  async getCredentials(url: string): Promise<string | undefined> {
    const parsed = this.parseGitUrl(url);
    if (!parsed) {
      return undefined;
    }

    const credentialInput = `protocol=${parsed.protocol}\nhost=${parsed.host}\n`;

    try {
      const result = await new Promise<string>((resolve, reject) => {
        let output = '';
        const child = exec('git credential fill', { cwd: this.repoPath }, (error, stdout) => {
          if (error) {
            reject(error);
          } else {
            resolve(stdout);
          }
        });
        child.stdin?.write(credentialInput);
        child.stdin?.end();
      });

      // Parse the output to extract password
      const passwordMatch = result.match(/password=(.+)/);
      if (passwordMatch) {
        return passwordMatch[1].trim();
      }
    } catch {
      // Fallback: try reading from .git-credentials directly
      const credentialStorePath = path.join(require('os').homedir(), '.git-credentials');
      if (fs.existsSync(credentialStorePath)) {
        const content = fs.readFileSync(credentialStorePath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.includes(`@${parsed.host}`)) {
            // Extract password from URL format: protocol://username:password@host
            const match = line.match(/:([^:@]+)@/);
            if (match) {
              return match[1];
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Delete credentials from Git credential manager
   */
  async deleteCredentials(url: string): Promise<void> {
    const parsed = this.parseGitUrl(url);
    if (!parsed) {
      return;
    }

    const credentialInput = `protocol=${parsed.protocol}\nhost=${parsed.host}\n`;

    try {
      await new Promise<void>((resolve, reject) => {
        const child = exec('git credential reject', { cwd: this.repoPath }, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        child.stdin?.write(credentialInput);
        child.stdin?.end();
      });
    } catch {
      // Fallback: remove from .git-credentials file
      const credentialStorePath = path.join(require('os').homedir(), '.git-credentials');
      if (fs.existsSync(credentialStorePath)) {
        const content = fs.readFileSync(credentialStorePath, 'utf8');
        const lines = content.split('\n').filter(line => !line.includes(`@${parsed.host}`));
        fs.writeFileSync(credentialStorePath, lines.join('\n'), { mode: 0o600 });
      }
    }
  }

  /**
   * Configure Git credential helper to use system store
   */
  private async configureCredentialHelper(): Promise<void> {
    try {
      // Check if credential helper is already configured globally
      const { stdout } = await execAsync('git config --global credential.helper');
      if (stdout.trim()) {
        return; // Already configured
      }
    } catch {
      // Not configured, set it up
    }

    // Configure credential helper based on platform
    const platform = process.platform;
    let helper: string;

    if (platform === 'darwin') {
      helper = 'osxkeychain';
    } else if (platform === 'win32') {
      helper = 'manager';
    } else {
      // Linux - use store (file-based) or libsecret if available
      try {
        await execAsync('which git-credential-libsecret');
        helper = 'libsecret';
      } catch {
        helper = 'store';
      }
    }

    await execAsync(`git config --global credential.helper ${helper}`);
  }

  /**
   * Parse Git URL to extract protocol and host
   */
  private parseGitUrl(url: string): { protocol: string; host: string; path: string } | null {
    // Handle https://host/path format
    if (url.startsWith('https://')) {
      const match = url.match(/https:\/\/([^/]+)(\/.*)?/);
      if (match) {
        return { protocol: 'https', host: match[1], path: match[2] || '' };
      }
    }
    // Handle http://host/path format
    if (url.startsWith('http://')) {
      const match = url.match(/http:\/\/([^/]+)(\/.*)?/);
      if (match) {
        return { protocol: 'http', host: match[1], path: match[2] || '' };
      }
    }
    // Handle git@host:path format
    if (url.startsWith('git@')) {
      const match = url.match(/git@([^:]+):(.+)/);
      if (match) {
        return { protocol: 'https', host: match[1], path: '/' + match[2] };
      }
    }
    return null;
  }

  /**
   * Initialize or clone the repository
   */
  async initializeRepository(remoteUrl: string, pat: string): Promise<void> {
    // Create directory if not exists
    if (!fs.existsSync(this.repoPath)) {
      fs.mkdirSync(this.repoPath, { recursive: true });
    }

    // Check if already a git repo
    const isRepo = await this.isGitRepository();

    if (!isRepo) {
      // Build authenticated URL
      const authUrl = this.buildAuthenticatedUrl(remoteUrl, pat);

      // Check if directory has files (after disconnect)
      const hasFiles = fs.readdirSync(this.repoPath).length > 0;

      if (hasFiles) {
        // Directory has files but no .git - init and add remote
        await this.git.init(['--initial-branch=main']);
        await this.git.addRemote('origin', authUrl);

        // Pull remote content (will merge with existing files)
        try {
          await this.git.fetch('origin');
          // Checkout remote branch without destroying local files
          await this.git.checkout(['origin/main', '-B', 'main']);
        } catch {
          // Remote might be empty, that's OK
        }
      } else {
        // Empty directory - try to clone
        try {
          await simpleGit().clone(authUrl, this.repoPath);
        } catch (error: unknown) {
          // If clone fails (empty repo), init locally
          const gitError = error as { message?: string };
          if (gitError.message?.includes('empty repository')) {
            // Init with initial branch name
            await this.git.init(['--initial-branch=main']);
            await this.git.addRemote('origin', authUrl);

            // Create initial commit immediately to establish HEAD
            const readmePath = path.join(this.repoPath, 'README.md');
            fs.writeFileSync(readmePath, '# Antigravity 同步与自动重试\n\n用于同步 Gemini/Antigravity 上下文数据。\n');
            await this.git.add('README.md');
            await this.git.commit('初始提交');
          } else {
            throw error;
          }
        }
      }
    }

    // Configure git
    await this.git.addConfig('user.name', 'Antigravity Sync Fixed', false, 'local');
    await this.git.addConfig('user.email', 'sync@antigravity.local', false, 'local');

    // Ensure origin matches the configured repo (no token stored in remote URL)
    await this.ensureOriginMatches(remoteUrl);
  }

  /**
   * Check if directory is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify token has access to the repository
   * Returns true if token can access repo, throws error otherwise
   */
  async verifyAccess(remoteUrl: string, token: string): Promise<void> {
    const authUrl = this.buildAuthenticatedUrl(remoteUrl, token);
    try {
      // Use ls-remote to verify access without cloning
      await simpleGit().listRemote([authUrl]);
    } catch (error) {
      const gitError = error as { message?: string };
      if (gitError.message?.includes('401') || gitError.message?.includes('403')) {
        throw new Error('401 访问令牌无效或无权限访问该仓库');
      }
      if (gitError.message?.includes('could not read')) {
        throw new Error('404 仓库不存在或无权限访问');
      }
      throw new Error(`无法访问仓库：${gitError.message || '未知错误'}`);
    }
  }

  /**
   * Ensure origin remote matches configured repository URL (and strip credentials)
   */
  private async ensureOriginMatches(remoteUrl: string): Promise<void> {
    const desiredKey = this.getRepoKey(remoteUrl);
    if (!desiredKey) return;

    const originUrl = await this.getOriginUrl();
    const cleanUrl = getCleanRemoteUrl(remoteUrl);

    if (!originUrl) {
      await this.git.addRemote('origin', cleanUrl);
      return;
    }

    const originKey = this.getRepoKey(originUrl);
    if (!originKey) {
      await this.git.remote(['set-url', 'origin', cleanUrl]);
      return;
    }

    if (originKey !== desiredKey || originUrl !== cleanUrl) {
      await this.git.remote(['set-url', 'origin', cleanUrl]);
    }
  }

  private getRepoKey(url: string): string | null {
    const identity = normalizeRepoIdentity(url);
    if (!identity) return null;
    return `${identity.host}/${identity.path}`;
  }

  private async getOriginUrl(): Promise<string | null> {
    try {
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find(remote => remote.name === 'origin');
      return origin?.refs?.fetch || origin?.refs?.push || null;
    } catch {
      return null;
    }
  }

  /**
   * Stage all changes
   */
  async stageAll(): Promise<void> {
    await this.git.add('-A');
  }

  /**
   * Stage specific paths
   */
  async stagePaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.git.add(paths);
  }

  /**
   * Commit changes
   */
  async commit(message: string): Promise<string | null> {
    const status = await this.git.status();

    if (status.isClean()) {
      return null;
    }

    const result = await this.git.commit(message);
    return result.commit;
  }

  /**
   * Commit specific paths only
   */
  async commitPaths(message: string, paths: string[]): Promise<string | null> {
    if (!paths.length) return null;
    const status = await this.git.status();
    if (status.isClean()) {
      return null;
    }
    const result = await this.git.commit(message, paths);
    return result.commit;
  }

  /**
   * Push to remote
   */
  async push(): Promise<void> {
    // Push to main
    await this.git.push('origin', 'main', ['--set-upstream']);
  }

  /**
   * Fetch from remote (to update tracking info)
   */
  async fetch(): Promise<void> {
    await this.git.fetch('origin');
  }

  /**
   * Resolve binary file conflict using Smart Resolution:
   * - If size difference > 20%: keep larger (more content)
   * - Else: keep newer (more recent)
   * @returns 'local' or 'remote' indicating which version was kept
   */
  private async resolveBinaryConflict(relativePath: string): Promise<'local' | 'remote'> {
    const SIZE_DIFF_THRESHOLD = 0.2; // 20%

    // Get local file info from working directory
    const localFilePath = path.join(this.repoPath, relativePath);
    const localExists = fs.existsSync(localFilePath);
    const localStats = localExists ? fs.statSync(localFilePath) : null;
    const localSize = localStats?.size || 0;
    const localMtime = localStats?.mtime || new Date(0);

    // Get remote file info from git
    let remoteSize = 0;
    let remoteMtime = new Date(0);
    try {
      // Get remote file content to determine size
      const content = await this.git.show([`origin/main:${relativePath}`]);
      remoteSize = Buffer.byteLength(content, 'binary');

      // Get remote commit time for this file
      const log = await this.git.log({ file: relativePath, maxCount: 1 });
      if (log.latest?.date) {
        remoteMtime = new Date(log.latest.date);
      }
    } catch {
      // File might not exist in remote, that's OK
    }

    // Calculate size difference ratio
    const maxSize = Math.max(localSize, remoteSize);
    const sizeDiffRatio = maxSize > 0 ? Math.abs(localSize - remoteSize) / maxSize : 0;

    let keepLocal: boolean;

    if (sizeDiffRatio > SIZE_DIFF_THRESHOLD) {
      // Large size difference → keep larger file (more content = more important)
      keepLocal = localSize >= remoteSize;
      this.log(`[冲突] ${relativePath}: 大小差 ${(sizeDiffRatio * 100).toFixed(0)}%（本地: ${localSize}, 远端: ${remoteSize}）→ 保留${keepLocal ? '本地' : '远端'}（更大）`);
    } else {
      // Similar size → keep newer file
      keepLocal = localMtime >= remoteMtime;
      this.log(`[冲突] ${relativePath}: 大小接近 → 保留${keepLocal ? '本地' : '远端'}（更新: ${keepLocal ? localMtime.toISOString() : remoteMtime.toISOString()}）`);
    }

    // Resolve conflict by checking out the chosen version
    if (keepLocal) {
      await this.git.raw(['checkout', '--ours', relativePath]);
    } else {
      await this.git.raw(['checkout', '--theirs', relativePath]);
    }
    await this.git.add(relativePath);

    return keepLocal ? 'local' : 'remote';
  }

  /**
   * Handle Smart Merge - resolve conflicts using larger/newer wins strategy
   * @param hasStash - whether there's a stash to pop
   */
  private async handleSmartMerge(hasStash: boolean): Promise<void> {
    this.log('[智能合并] === 开始智能合并 ===');

    // Step 1: Cleanup stale git state
    this.log('[智能合并] 步骤 1：清理过期的 git 状态...');
    const rebaseAbortResult = await this.git.rebase({ '--abort': null }).catch(e => `rebase 终止失败：${e.message}`);
    this.log(`[智能合并] Rebase 终止结果：${rebaseAbortResult}`);
    const mergeAbortResult = await this.git.raw(['merge', '--abort']).catch(e => `merge 终止失败：${e.message}`);
    this.log(`[智能合并] Merge 终止结果：${mergeAbortResult}`);
    this.cleanupIndexLock();
    this.log('[智能合并] 已清理 index.lock');

    // Step 2: Pop stash if any
    if (hasStash) {
      this.log('[智能合并] 步骤 2：恢复暂存改动（stash pop）...');
      const stashPopResult = await this.git.stash(['pop']).catch(e => `stash pop 失败：${e.message}`);
      this.log(`[智能合并] Stash pop 结果：${stashPopResult}`);
    }

    // Step 3: Soft reset to unstage but KEEP working directory files
    this.log('[智能合并] 步骤 3：软重置到 HEAD（保留本地文件）...');
    await this.git.reset(['HEAD']).catch(e => this.log(`[智能合并] Reset 失败：${e.message}`));

    // Step 4: Fetch latest remote
    this.log('[智能合并] 步骤 4：拉取远端信息（fetch）...');
    await this.git.fetch('origin');
    this.log('[智能合并] Fetch 完成');

    // Step 5: Get files that differ between local and remote
    this.log('[智能合并] 步骤 5：获取有差异的文件...');
    let differingFiles: string[] = [];
    try {
      const diffOutput = await this.git.raw(['diff', '--name-only', 'HEAD', 'origin/main']);
      differingFiles = diffOutput.split('\n').filter(f => f.trim().length > 0);
      this.log(`[智能合并] Diff 输出（${differingFiles.length} 个文件）：${differingFiles.slice(0, 10).join(', ')}${differingFiles.length > 10 ? '...' : ''}`);
    } catch (diffError) {
      this.log(`[智能合并] Diff 失败：${(diffError as Error).message}`);
      differingFiles = [];
    }

    const binaryLikeExtensions = ['.pb', '.pbtxt', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.bin', '.sqlite'];
    this.log('[智能合并] 步骤 6：对差异文件应用智能策略（更新优先）...');
    const deviceTag = this.getDeviceTag();
    const conflictStamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', '');
    const buildConflictPath = (relativePath: string): string => {
      const parsed = path.parse(relativePath);
      const suffix = `.conflict-${deviceTag}-${conflictStamp}`;
      return path.join(this.repoPath, parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
    };

    const ensureDir = (filePath: string): void => {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    };

    const areContentsEqual = (localPath: string, remoteContent: string): boolean => {
      try {
        const localBuffer = fs.readFileSync(localPath);
        const remoteBuffer = Buffer.from(remoteContent, 'binary');
        if (localBuffer.length !== remoteBuffer.length) return false;
        return localBuffer.equals(remoteBuffer);
      } catch {
        return false;
      }
    };

    const writeConflictCopyFromLocal = (relativePath: string, localPath: string): void => {
      const conflictPath = buildConflictPath(relativePath);
      ensureDir(conflictPath);
      fs.copyFileSync(localPath, conflictPath);
      this.log(`[智能合并] 已生成冲突副本（本地）：${relativePath}`);
    };

    const writeConflictCopyFromRemote = (relativePath: string, remoteContent: string): void => {
      const conflictPath = buildConflictPath(relativePath);
      ensureDir(conflictPath);
      fs.writeFileSync(conflictPath, Buffer.from(remoteContent, 'binary'));
      this.log(`[智能合并] 已生成冲突副本（远端）：${relativePath}`);
    };

    const getRemoteDeletionTime = async (relativePath: string): Promise<Date | null> => {
      try {
        const result = await this.git.raw([
          'log',
          '-1',
          '--format=%ct',
          '--diff-filter=D',
          'origin/main',
          '--',
          relativePath
        ]);
        const trimmed = result.trim();
        if (!trimmed) return null;
        const seconds = parseInt(trimmed, 10);
        if (Number.isNaN(seconds)) return null;
        return new Date(seconds * 1000);
      } catch {
        return null;
      }
    };
    for (const file of differingFiles) {
      try {
        // Get local file info
        const localFilePath = path.join(this.repoPath, file);
        const localExists = fs.existsSync(localFilePath);
        const localStats = localExists ? fs.statSync(localFilePath) : null;
        const localSize = localStats?.size || 0;
        const localMtime = localStats?.mtime || new Date(0);

        // Get remote file info
        let remoteSize = 0;
        let remoteMtime = new Date(0);
        let remoteExists = false;
        let remoteContent: string | null = null;
        let remoteDeletedAt: Date | null = null;
        try {
          const content = await this.git.show([`origin/main:${file}`]);
          remoteSize = Buffer.byteLength(content, 'binary');
          remoteExists = true;
          remoteContent = content;
        } catch {
          remoteExists = false;
        }

        try {
          const log = await this.git.raw(['log', '-1', '--format=%ct', 'origin/main', '--', file]);
          const trimmed = log.trim();
          if (trimmed) {
            const seconds = parseInt(trimmed, 10);
            if (!Number.isNaN(seconds)) {
              remoteMtime = new Date(seconds * 1000);
            }
          }
        } catch { /* ignore */ }

        if (!remoteExists) {
          remoteDeletedAt = await getRemoteDeletionTime(file);
          if (remoteDeletedAt) {
            remoteMtime = remoteDeletedAt;
          }
        }

        const contentEqual = localExists && remoteExists && remoteContent !== null && localSize === remoteSize
          ? areContentsEqual(localFilePath, remoteContent)
          : false;

        const isBinaryLike = binaryLikeExtensions.some(ext => file.toLowerCase().endsWith(ext));
        const sizeDiffRatio = Math.max(localSize, remoteSize) > 0
          ? Math.abs(localSize - remoteSize) / Math.max(localSize, remoteSize)
          : 0;

        let keepLocal: boolean;

        if (!localExists && !remoteExists) {
          continue;
        }

        if (!localExists) {
          keepLocal = false;
          this.log(`[智能合并] ${file}: 本地不存在 → 保留远端`);
        } else if (!remoteExists) {
          // Remote deleted: compare deletion time with local mtime
          keepLocal = localMtime >= remoteMtime;
          this.log(`[智能合并] ${file}: 远端不存在 → 按时间保留${keepLocal ? '本地' : '远端'}（更新优先）`);
        } else if (isBinaryLike) {
          if (sizeDiffRatio > 0.2) {
            keepLocal = localSize >= remoteSize;
            this.log(`[智能合并] ${file}: 大小 ${localSize} vs ${remoteSize}（${(sizeDiffRatio * 100).toFixed(0)}%）→ 保留${keepLocal ? '本地' : '远端'}（更大）`);
          } else {
            keepLocal = localMtime >= remoteMtime;
            this.log(`[智能合并] ${file}: 大小接近 → 保留${keepLocal ? '本地' : '远端'}（更新优先）`);
          }
        } else {
          keepLocal = localMtime >= remoteMtime;
          this.log(`[智能合并] ${file}: 文本文件 → 保留${keepLocal ? '本地' : '远端'}（更新优先）`);
        }

        const isDifferent = !contentEqual;
        if (!isDifferent) {
          this.log(`[智能合并] ${file}: 内容一致，跳过`);
          continue;
        }

        if (!keepLocal) {
          if (localExists && isDifferent) {
            writeConflictCopyFromLocal(file, localFilePath);
          }
          if (remoteExists) {
            this.log(`[智能合并] 正在检出远端版本：${file}...`);
            await this.git.raw(['checkout', 'origin/main', '--', file]).catch(e =>
              this.log(`[智能合并] 检出失败：${e.message}`)
            );
          } else if (localExists) {
            this.log(`[智能合并] 正在删除本地文件（远端已删除）：${file}...`);
            try {
              fs.unlinkSync(localFilePath);
            } catch { /* ignore */ }
          }
        } else if (remoteExists && isDifferent) {
          if (!remoteContent) {
            try {
              remoteContent = await this.git.show([`origin/main:${file}`]);
            } catch {
              remoteContent = null;
            }
          }
          if (remoteContent) {
            writeConflictCopyFromRemote(file, remoteContent);
          }
        }
      } catch (err) {
        this.log(`[智能合并] 处理 ${file} 出错：${(err as Error).message}`);
      }
    }

    // Step 7: Stage all changes
    this.log('[智能合并] 步骤 7：暂存所有变更...');
    await this.git.add('-A');
    const statusAfterAdd = await this.git.status();
    this.log(`[智能合并] 暂存后状态：已暂存 ${statusAfterAdd.files.length}，冲突 ${statusAfterAdd.conflicted?.length || 0}`);

    // Step 8: Commit merged result
    this.log('[智能合并] 步骤 8：提交合并结果...');
    const commitResult = await this.git.commit('同步：智能合并（更大/更新优先）').catch(e => `提交失败：${e.message}`);
    this.log(`[智能合并] 提交结果：${JSON.stringify(commitResult)}`);

    // Step 9: Push (no force - safer, will fail if diverged)
    this.log('[智能合并] 步骤 9：推送...');
    const pushResult = await this.git.push('origin', 'main').catch(async (e) => {
      this.log(`[智能合并] 推送失败，尝试先拉取再推送：${e.message}`);
      // If push fails, pull and retry
      await this.git.pull('origin', 'main', { '--rebase': 'false' }).catch(() => { });
      return await this.git.push('origin', 'main').catch(e2 => `推送重试失败：${e2.message}`);
    });
    this.log(`[智能合并] 推送结果：${JSON.stringify(pushResult)}`);

    this.log('[智能合并] === 智能合并完成 ===');
  }

  private getDeviceTag(): string {
    const hostname = os.hostname() || 'device';
    return hostname.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 32);
  }

  /**
   * Pull from remote (handles divergent branches with rebase)
   */
  async pull(): Promise<void> {
    this.log('[Git 拉取] 开始拉取...');
    try {
      // Check initial status
      const status = await this.git.status();
      const hasChanges = status.files.length > 0;
      const hasPreExistingConflicts = (status.conflicted?.length || 0) > 0;
      this.log(`[Git 拉取] 状态：${status.files.length} 个文件，hasChanges=${hasChanges}`);
      this.log(`[Git 拉取] 冲突文件：${status.conflicted?.length || 0}`);
      this.log(`[Git 拉取] 已存在冲突：${hasPreExistingConflicts}`);

      // If there are pre-existing conflicts (ghost conflict state), handle them first
      if (hasPreExistingConflicts) {
        this.log('[Git 拉取] 检测到已有冲突，进入智能合并...');
        await this.handleSmartMerge(false); // false = no stash to pop
        return;
      }

      if (hasChanges) {
        this.log('[Git 拉取] 正在暂存本地改动...');
        await this.git.stash(['push', '-m', 'antigravity-sync-fixed-temp']);
      }

      try {
        // Try pull with rebase to handle divergent branches
        this.log('[Git 拉取] 正在执行 pull --rebase...');
        await this.git.pull('origin', 'main', { '--rebase': 'true' });
        this.log('[Git 拉取] 拉取成功！');
      } catch (error: unknown) {
        const gitError = error as { message?: string };
        this.log(`[Git 拉取] 拉取失败：${gitError.message}`);

        // Empty repo - no remote branches yet, skip pull
        if (gitError.message?.includes("couldn't find remote ref")) {
          this.log('[Git 拉取] 远端为空，跳过拉取');
          // Pop stash if we had changes
          if (hasChanges) {
            await this.git.stash(['pop']).catch(() => { });
          }
          return;
        }

        // Divergent branches or rebase conflict - use "Smart Merge" strategy
        if (gitError.message?.includes('divergent') ||
          gitError.message?.includes('reconcile') ||
          gitError.message?.includes('CONFLICT') ||
          gitError.message?.includes('conflict') ||
          gitError.message?.includes('Exiting') ||
          gitError.message?.includes('unresolved') ||
          gitError.message?.includes('needs merge') ||
          gitError.message?.includes('could not write index') ||
          gitError.message?.includes('index.lock')) {

          this.log(`[Git 拉取] 检测到冲突，进入智能合并（hasChanges=${hasChanges}）...`);
          await this.handleSmartMerge(hasChanges);
          return;
        }

        // Pop stash before throwing
        if (hasChanges) {
          await this.git.stash(['pop']).catch(() => { });
        }
        throw error;
      }

      // Pop stash after successful pull
      if (hasChanges) {
        await this.git.stash(['pop']).catch(() => { });
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get pending changes count
   */
  async getPendingChangesCount(): Promise<number> {
    const status = await this.git.status();
    return status.files.length;
  }

  /**
   * Get changed files list (max 10)
   */
  async getChangedFiles(maxFiles: number = 10): Promise<{ files: string[]; total: number }> {
    const status = await this.git.status();
    const allFiles = status.files.map(f => f.path);
    return {
      files: allFiles.slice(0, maxFiles),
      total: allFiles.length
    };
  }

  /**
   * Get all changed file paths
   */
  async getStatusFiles(): Promise<string[]> {
    const status = await this.git.status();
    return status.files.map(f => f.path);
  }

  /**
   * Get ahead/behind counts compared to remote
   */
  async getAheadBehind(): Promise<{ ahead: number; behind: number }> {
    try {
      await this.git.fetch('origin');
      const status = await this.git.status();
      return {
        ahead: status.ahead || 0,
        behind: status.behind || 0
      };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  /**
   * Get last commit date
   */
  async getLastCommitDate(): Promise<string | null> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.date || null;
    } catch {
      return null;
    }
  }

  /**
   * Build authenticated URL for Git operations
   * Supports any Git provider: GitHub, GitLab, Bitbucket, etc.
   */
  private buildAuthenticatedUrl(url: string, token: string): string {
    // Convert https://host/path to https://token@host/path
    // GitLab requires oauth2:token format for PAT
    const isGitLab = url.includes('gitlab');
    const authToken = isGitLab ? `oauth2:${token}` : token;

    if (url.startsWith('https://')) {
      return url.replace('https://', `https://${authToken}@`);
    }
    // Convert git@host:path to https://token@host/path
    if (url.startsWith('git@')) {
      const match = url.match(/git@([^:]+):(.+)/);
      if (match) {
        return `https://${authToken}@${match[1]}/${match[2]}`;
      }
    }
    return url;
  }

  /**
   * Remove stale index.lock if exists (from crashed git process)
   */
  private cleanupIndexLock(): void {
    const lockPath = path.join(this.repoPath, '.git', 'index.lock');
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  }
}
