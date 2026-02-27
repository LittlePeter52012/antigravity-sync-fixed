/**
 * Relauncher - Setup CDP flag for IDE startup
 * Helps users configure their IDE to launch with --remote-debugging-port
 */
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_PORT = 31905;

export type RelaunchStatus = 'MODIFIED' | 'READY' | 'FAILED' | 'NOT_FOUND';
export type RelauncherLogCallback = (message: string, type: 'info' | 'success' | 'error' | 'warning') => void;

export class Relauncher {
  private platform: NodeJS.Platform;
  private logCallback?: RelauncherLogCallback;
  private cdpPort: number;

  constructor() {
    this.platform = os.platform();
    const config = vscode.workspace.getConfiguration('antigravitySync');
    this.cdpPort = config.get('cdpPort', DEFAULT_PORT);
  }

  setLogCallback(callback: RelauncherLogCallback): void {
    this.logCallback = callback;
  }

  private log(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
    console.log(`[Relauncher] ${message}`);
    this.logCallback?.(message, type);
  }

  getIdeName(): string {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('cursor')) return 'Cursor';
    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
    return 'VS Code';
  }

  getCDPPort(): number {
    return this.cdpPort;
  }

  getCDPFlag(): string {
    return `--remote-debugging-port=${this.cdpPort}`;
  }

  checkCurrentProcessHasFlag(): boolean {
    return process.argv.join(' ').includes(`--remote-debugging-port=${this.cdpPort}`);
  }

  /**
   * Main entry point: setup CDP and show instructions
   */
  async ensureCDPAndPrompt(): Promise<{ success: boolean; relaunched: boolean }> {
    if (this.checkCurrentProcessHasFlag()) {
      this.log('已检测到 CDP 参数。', 'success');
      return { success: true, relaunched: false };
    }

    this.log('正在设置 CDP...', 'info');
    const status = await this.modifyShortcut();

    if (status === 'MODIFIED' || status === 'READY') {
      await this.showSetupDialog();
      return { success: true, relaunched: false };
    }

    this.showManualInstructions();
    return { success: false, relaunched: false };
  }

  /**
   * Show setup complete dialog with platform-specific instructions
   */
  private async showSetupDialog(): Promise<void> {
    const ideName = this.getIdeName();

    if (this.platform === 'darwin') {
      await this.showMacOSDialog(ideName);
    } else if (this.platform === 'win32') {
      await this.showWindowsDialog(ideName);
    } else {
      await this.showLinuxDialog(ideName);
    }
  }

  /**
   * macOS: Show dialog with Terminal and Finder options
   */
  private async showMacOSDialog(ideName: string): Promise<void> {
    const command = `~/.local/bin/${ideName.toLowerCase()}-cdp`;

    const choice = await vscode.window.showWarningMessage(
      `✅ CDP 设置完成！\n\n` +
      `📌 接下来请按步骤操作：\n` +
      `1. 按 Cmd+Q 退出 ${ideName}\n` +
      `2. 打开“终端”应用（/Applications/Utilities/）\n` +
      `3. 粘贴命令并回车\n\n` +
      `或者使用 ~/Applications 目录中的启动器。`,
      { modal: true },
      '📋 复制命令',
      '📁 打开文件夹'
    );

    if (choice === '📋 复制命令') {
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage(
        `✅ 命令已复制！\n\n` +
        `现在：Cmd+Q → 打开终端 → 粘贴（Cmd+V）→ 回车`
      );
    } else if (choice === '📁 打开文件夹') {
      const { exec } = require('child_process');
      const folderPath = path.join(os.homedir(), 'Applications');
      exec(`open "${folderPath}"`);
      vscode.window.showInformationMessage(
        `✅ 已打开文件夹！\n\n` +
        `现在：Cmd+Q → 双击文件夹中的 "${ideName}CDP"`
      );
    }
  }

  /**
   * Windows: Show dialog with CMD/PowerShell instructions
   */
  private async showWindowsDialog(ideName: string): Promise<void> {
    const command = this.getLaunchCommand();

    const choice = await vscode.window.showWarningMessage(
      `✅ CDP 设置完成！\n\n` +
      `📌 请选择一种方式：\n\n` +
      `方式 A - 使用已更新的快捷方式：\n` +
      `1. 关闭 ${ideName}（文件 → 退出）\n` +
      `2. 从桌面或开始菜单重新打开\n\n` +
      `方式 B - 使用命令行：\n` +
      `1. 点击下方“复制并退出”\n` +
      `2. 按 Win+R 输入 "cmd" 回车\n` +
      `3. 右键粘贴并回车`,
      { modal: true },
      '📋 复制并退出'
    );

    if (choice === '📋 复制并退出') {
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage(
        `✅ 命令已复制！${ideName} 即将关闭。\n\n` +
        `Win+R → 输入 "cmd" → 回车 → 右键粘贴 → 回车`
      );
      // Auto quit after short delay
      setTimeout(() => {
        vscode.commands.executeCommand('workbench.action.quit');
      }, 2000);
    }
  }

  /**
   * Linux: Show dialog with Terminal instructions
   */
  private async showLinuxDialog(ideName: string): Promise<void> {
    const command = this.getLaunchCommand();

    const choice = await vscode.window.showWarningMessage(
      `✅ CDP 设置完成！\n\n` +
      `📌 请选择一种方式：\n\n` +
      `方式 A - 使用已更新的启动器：\n` +
      `1. 关闭 ${ideName}\n` +
      `2. 从应用菜单重新打开\n\n` +
      `方式 B - 使用终端：\n` +
      `1. 点击下方“复制并退出”\n` +
      `2. 按 Ctrl+Alt+T 打开终端\n` +
      `3. 粘贴（Ctrl+Shift+V）并回车`,
      { modal: true },
      '📋 复制并退出'
    );

    if (choice === '📋 复制并退出') {
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage(
        `✅ 命令已复制！${ideName} 即将关闭。\n\n` +
        `Ctrl+Alt+T → 粘贴（Ctrl+Shift+V）→ 回车`
      );
      // Auto quit after short delay
      setTimeout(() => {
        vscode.commands.executeCommand('workbench.action.quit');
      }, 2000);
    }
  }

  /**
   * Get launch command for current platform
   * Uses background-friendly commands so user can close terminal
   */
  private getLaunchCommand(): string {
    const ideName = this.getIdeName();
    const port = this.cdpPort;

    if (this.platform === 'darwin') {
      return `~/.local/bin/${ideName.toLowerCase()}-cdp`;
    } else if (this.platform === 'win32') {
      const exe = this.findExecutable();
      // Use 'start' to run in background (no need to keep CMD open)
      return `start "" "${exe}" --remote-debugging-port=${port}`;
    } else {
      const exe = this.findExecutable();
      // Use 'nohup' and '&' to run in background
      return `nohup ${exe} --remote-debugging-port=${port} > /dev/null 2>&1 &`;
    }
  }

  /**
   * Find executable path for current platform
   */
  private findExecutable(): string {
    const ideName = this.getIdeName();

    if (this.platform === 'win32') {
      const paths = [
        path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'cursor', 'Cursor.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
      return `C:\\Path\\To\\${ideName}.exe`;
    } else {
      const paths = [
        '/usr/bin/code',
        '/usr/bin/cursor',
        '/usr/bin/antigravity',
        path.join(os.homedir(), '.local/share/code/code'),
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
      return ideName.toLowerCase();
    }
  }

  /**
   * Show manual instructions
   */
  showManualInstructions(): void {
    const ideName = this.getIdeName();
    const command = this.getLaunchCommand();

    vscode.window.showInformationMessage(
      `📖 启用自动重试步骤：\n\n` +
      `1. 关闭 ${ideName}\n` +
      `2. 运行：${command}\n\n` +
      `或者把 --remote-debugging-port=${this.cdpPort} 添加到启动参数。`,
      '复制命令'
    ).then(choice => {
      if (choice === '复制命令') {
        vscode.env.clipboard.writeText(command);
        vscode.window.showInformationMessage('✅ 命令已复制！');
      }
    });
  }

  /**
   * Modify shortcut/wrapper for current platform
   */
  async modifyShortcut(): Promise<RelaunchStatus> {
    try {
      if (this.platform === 'darwin') {
        return this.createMacOSWrapper() ? 'MODIFIED' : 'FAILED';
      } else if (this.platform === 'win32') {
        return this.modifyWindowsShortcut();
      } else {
        return this.modifyLinuxDesktop() ? 'MODIFIED' : 'FAILED';
      }
    } catch (e: any) {
      this.log(`错误：${e.message}`, 'error');
      return 'FAILED';
    }
  }

  /**
   * macOS: Create wrapper script
   */
  private createMacOSWrapper(): boolean {
    const ideName = this.getIdeName();
    const binDir = path.join(os.homedir(), '.local', 'bin');

    try {
      fs.mkdirSync(binDir, { recursive: true });

      // Find app
      const locations = ['/Applications', path.join(os.homedir(), 'Applications')];
      const appNames = [`${ideName}.app`, 'Cursor.app', 'Visual Studio Code.app', 'Antigravity.app'];
      let appPath = '';

      for (const loc of locations) {
        for (const name of appNames) {
          const p = path.join(loc, name);
          if (fs.existsSync(p)) { appPath = p; break; }
        }
        if (appPath) break;
      }

      if (!appPath) return false;

      const wrapperPath = path.join(binDir, `${ideName.toLowerCase()}-cdp`);
      const content = `#!/bin/bash\nopen -a "${appPath}" --args --remote-debugging-port=${this.cdpPort} "$@"`;
      fs.writeFileSync(wrapperPath, content, { mode: 0o755 });

      this.log(`已创建启动器：${wrapperPath}`, 'success');
      return true;
    } catch (e: any) {
      this.log(`创建失败：${e.message}`, 'error');
      return false;
    }
  }

  /**
   * Windows: Modify shortcuts using PowerShell
   */
  private modifyWindowsShortcut(): RelaunchStatus {
    const ideName = this.getIdeName();
    const port = this.cdpPort;
    const { execSync } = require('child_process');

    const script = `
$WshShell = New-Object -ComObject WScript.Shell
$folders = @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))
$modified = $false

foreach ($folder in $folders) {
  if (Test-Path $folder) {
    Get-ChildItem -Path $folder -Filter "*${ideName}*.lnk" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      $shortcut = $WshShell.CreateShortcut($_.FullName)
      if ($shortcut.Arguments -notlike "*--remote-debugging-port=${port}*") {
        $shortcut.Arguments = "--remote-debugging-port=${port} " + $shortcut.Arguments
        $shortcut.Save()
        $modified = $true
      }
    }
  }
}

if ($modified) { "MODIFIED" } else { "READY" }
`;

    try {
      const result = execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8',
        timeout: 10000
      }).trim();

      return result.includes('MODIFIED') ? 'MODIFIED' : 'READY';
    } catch {
      return 'FAILED';
    }
  }

  /**
   * Linux: Modify .desktop file
   */
  private modifyLinuxDesktop(): boolean {
    const ideName = this.getIdeName().toLowerCase();
    const port = this.cdpPort;
    const desktopDir = path.join(os.homedir(), '.local', 'share', 'applications');

    try {
      fs.mkdirSync(desktopDir, { recursive: true });

      const searchDirs = [desktopDir, '/usr/share/applications'];

      for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;

        const files = fs.readdirSync(dir).filter(f =>
          f.endsWith('.desktop') && (f.includes(ideName) || f.includes('code') || f.includes('cursor'))
        );

        for (const file of files) {
          let content = fs.readFileSync(path.join(dir, file), 'utf8');

          if (!content.includes(`--remote-debugging-port=${port}`)) {
            content = content.replace(/^Exec=(.*)$/m, `Exec=$1 --remote-debugging-port=${port}`);
            fs.writeFileSync(path.join(desktopDir, file), content);
            this.log(`已修改：${file}`, 'success');
            return true;
          }
        }
      }

      return false;
    } catch (e: any) {
      this.log(`修改失败：${e.message}`, 'error');
      return false;
    }
  }
}
