/**
 * UpdateService - Check GitHub releases and install VSIX updates
 */
import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ReleaseInfo {
  tagName: string;
  version: string;
  htmlUrl: string;
  assetUrl?: string;
  assetName?: string;
  publishedAt?: string;
}

export class UpdateService {
  private static readonly DEFAULT_REPO = 'LittlePeter52012/antigravity-sync-fixed';

  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  getCurrentVersion(): string {
    const version = this.context.extension.packageJSON.version;
    return typeof version === 'string' ? version : '0.0.0';
  }

  getUpdateRepo(): string {
    const config = vscode.workspace.getConfiguration('antigravitySync');
    const repo = (config.get<string>('updateRepo') || UpdateService.DEFAULT_REPO).trim();
    return repo || UpdateService.DEFAULT_REPO;
  }

  async getLatestRelease(): Promise<ReleaseInfo> {
    const repo = this.getUpdateRepo();
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new Error('更新仓库格式无效（应为 owner/repo）');
    }

    const url = `https://api.github.com/repos/${owner}/${name}/releases/latest`;
    const data = await this.fetchJson(url);
    const tagName = String(data.tag_name || '');
    const version = tagName.replace(/^v/i, '') || '';
    const htmlUrl = String(data.html_url || `https://github.com/${owner}/${name}/releases`);
    const publishedAt = String(data.published_at || '');

    let assetUrl: string | undefined;
    let assetName: string | undefined;
    const assets = Array.isArray(data.assets) ? data.assets : [];
    for (const asset of assets) {
      const nameStr = String(asset.name || '');
      if (nameStr.toLowerCase().endsWith('.vsix')) {
        assetUrl = String(asset.browser_download_url || '');
        assetName = nameStr;
        break;
      }
    }

    return { tagName, version, htmlUrl, assetUrl, assetName, publishedAt };
  }

  async downloadVsix(downloadUrl: string, fileName: string): Promise<string> {
    if (!downloadUrl) {
      throw new Error('未找到可下载的 VSIX');
    }

    const safeName = fileName.replace(/[^\w.\-]/g, '_') || 'antigravity-sync-fixed.vsix';
    const targetPath = path.join(os.tmpdir(), safeName);
    await this.downloadFile(downloadUrl, targetPath);
    return targetPath;
  }

  private async fetchJson(url: string): Promise<any> {
    const raw = await this.httpGet(url);
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('更新信息解析失败');
    }
  }

  private async httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            'User-Agent': 'antigravity-sync-fixed',
            'Accept': 'application/vnd.github+json'
          }
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            this.httpGet(res.headers.location).then(resolve).catch(reject);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`更新请求失败（HTTP ${status}）`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }
      );
      request.on('error', reject);
    });
  }

  private async downloadFile(url: string, targetPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            'User-Agent': 'antigravity-sync-fixed',
            'Accept': 'application/octet-stream'
          }
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            this.downloadFile(res.headers.location, targetPath).then(resolve).catch(reject);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`下载失败（HTTP ${status}）`));
            return;
          }
          const file = fs.createWriteStream(targetPath, { mode: 0o600 });
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', (err) => reject(err));
        }
      );
      request.on('error', reject);
    });
  }
}
