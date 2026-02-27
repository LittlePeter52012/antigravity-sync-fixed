/**
 * NotificationService - Handle VS Code notifications
 */
import * as vscode from 'vscode';

export enum NotificationType {
  Error = 'error',
  Warning = 'warning',
  Info = 'info'
}

export interface NotificationAction {
  title: string;
  action: () => void | Promise<void>;
}

export class NotificationService {
  /**
   * Show an error notification
   */
  static async error(
    message: string,
    options?: {
      detail?: string;
      actions?: NotificationAction[];
      modal?: boolean;
    }
  ): Promise<void> {
    const fullMessage = options?.detail
      ? `${message}\n\n${options.detail}`
      : message;

    if (options?.modal) {
      await vscode.window.showErrorMessage(fullMessage, { modal: true });
      return;
    }

    const actionTitles = options?.actions?.map(a => a.title) || [];
    const result = await vscode.window.showErrorMessage(fullMessage, ...actionTitles);

    if (result && options?.actions) {
      const action = options.actions.find(a => a.title === result);
      if (action) {
        await action.action();
      }
    }
  }

  /**
   * Show a warning notification
   */
  static async warning(
    message: string,
    options?: {
      detail?: string;
      actions?: NotificationAction[];
    }
  ): Promise<void> {
    const fullMessage = options?.detail
      ? `${message}: ${options.detail}`
      : message;

    const actionTitles = options?.actions?.map(a => a.title) || [];
    const result = await vscode.window.showWarningMessage(fullMessage, ...actionTitles);

    if (result && options?.actions) {
      const action = options.actions.find(a => a.title === result);
      if (action) {
        await action.action();
      }
    }
  }

  /**
   * Show an info notification (only for important events)
   */
  static async info(message: string): Promise<void> {
    await vscode.window.showInformationMessage(message);
  }

  /**
   * Show progress notification
   */
  static async withProgress<T>(
    title: string,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken
    ) => Promise<T>
  ): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true
      },
      task
    );
  }

  /**
   * Pre-defined error handlers
   */
  static handleSyncError(error: Error): void {
    if (error.message.includes('PRIVATE')) {
      void this.error('仓库必须为私有', {
        detail: '你的 Antigravity 上下文可能包含敏感信息，请使用私有仓库。',
        actions: [
          { title: '重新配置', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
        ]
      });
    } else if (error.message.includes('404')) {
      void this.error('仓库不存在', {
        detail: '请检查仓库地址，并确保令牌拥有访问权限。',
        actions: [
          { title: '重新配置', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
        ]
      });
    } else if (error.message.includes('401')) {
      void this.error('访问令牌无效', {
        detail: '你的访问令牌无效或已过期。',
        actions: [
          { title: '更新令牌', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
        ]
      });
    } else if (error.message.includes('同步密码')) {
      void this.error('同步密码验证失败', {
        detail: '请输入正确的同步密码（需与仓库中的密码一致）。',
        actions: [
          { title: '重新配置', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
        ]
      });
    } else if (error.message.includes('password')) {
      void this.error('同步密码验证失败', {
        detail: '请输入正确的同步密码（需与仓库中的密码一致）。',
        actions: [
          { title: '重新配置', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
        ]
      });
    } else if (error.message.includes('network') || error.message.includes('ENOTFOUND')) {
      void this.error('网络错误', {
        detail: '请检查你的网络连接。',
        actions: [
          { title: '重试', action: () => void vscode.commands.executeCommand('antigravitySync.syncNow') }
        ]
      });
    } else {
      void this.error('同步失败', {
        detail: error.message,
        actions: [
          { title: '重试', action: () => void vscode.commands.executeCommand('antigravitySync.syncNow') },
          { title: '查看日志', action: () => void vscode.commands.executeCommand('workbench.action.toggleDevTools') }
        ]
      });
    }
  }

  /**
   * Conflict notification
   */
  static handleConflict(files: string[]): void {
    void this.warning('检测到合并冲突', {
      detail: `共有 ${files.length} 个文件存在冲突，已尝试自动合并。`,
      actions: [
        {
          title: '查看文件', action: () => {
            // Open first conflicted file
            if (files.length > 0) {
              void vscode.window.showTextDocument(vscode.Uri.file(files[0]));
            }
          }
        }
      ]
    });
  }
}
