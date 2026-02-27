/**
 * RepoValidationService - Shared validation helpers for repository config
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const UPSTREAM_REPO_URL = 'https://github.com/mrd9999/antigravity-sync';

interface RepoIdentity {
  host: string;
  path: string;
}

function normalizePath(pathname: string): string {
  let path = pathname.trim();
  path = path.replace(/^\//, '').replace(/\/$/, '');
  if (path.endsWith('.git')) {
    path = path.slice(0, -4);
  }
  return path;
}

export function normalizeRepoIdentity(url: string): RepoIdentity | null {
  const trimmed = url.trim();

  if (trimmed.startsWith('git@')) {
    const match = trimmed.match(/^git@([^:]+):(.+)$/);
    if (!match) return null;
    return { host: match[1], path: normalizePath(match[2]) };
  }

  if (trimmed.startsWith('ssh://')) {
    try {
      const parsed = new URL(trimmed);
      return { host: parsed.hostname, path: normalizePath(parsed.pathname) };
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      return { host: parsed.hostname, path: normalizePath(parsed.pathname) };
    } catch {
      return null;
    }
  }

  return null;
}

export function getCleanRemoteUrl(url: string): string {
  const identity = normalizeRepoIdentity(url);
  if (!identity) return url;
  return `https://${identity.host}/${identity.path}.git`;
}

export function isUpstreamRepo(url: string): boolean {
  const target = normalizeRepoIdentity(url);
  const upstream = normalizeRepoIdentity(UPSTREAM_REPO_URL);
  if (!target || !upstream) return false;
  return target.host === upstream.host && target.path === upstream.path;
}

export function validateGitRepoUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: '请输入有效的仓库地址。' };
  }

  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('git@')) {
    return { valid: false, error: '仓库地址格式不正确，请使用 https:// 或 git@...' };
  }

  const gitProviders = [
    'github.com',
    'gitlab.com',
    'bitbucket.org',
    'gitee.com',
    'codeberg.org',
    'sr.ht',
    'dev.azure.com'
  ];

  const urlLower = url.toLowerCase();
  const isKnownProvider = gitProviders.some(p => urlLower.includes(p));
  const hasGitExtension = urlLower.endsWith('.git');
  const hasRepoPath = /\/([\w.-]+)\/([\w.-]+)(\.git)?$/.test(url);

  if (!isKnownProvider && !hasGitExtension && !hasRepoPath) {
    return {
      valid: false,
      error: '仓库地址看起来不正确。示例：https://host/user/repo 或 git@host:user/repo.git'
    };
  }

  return { valid: true };
}

export async function checkIsPublicRepo(url: string): Promise<boolean> {
  try {
    await execAsync(`git ls-remote ${url}`, {
      timeout: 10000,
      env: {
        ...process.env,
        GIT_ASKPASS: 'echo',
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: '/nonexistent'
      }
    });
    return true;
  } catch {
    return false;
  }
}
