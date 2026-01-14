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
      void this.error('Repository must be private', {
        detail: 'Your Antigravity context may contain sensitive information. Please use a private repository.',
        actions: [
          { title: 'Configure', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
        ]
      });
    } else if (error.message.includes('404')) {
      void this.error('Repository not found', {
        detail: 'Please check the repository URL and ensure your token has access.',
        actions: [
          { title: 'Configure', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
        ]
      });
    } else if (error.message.includes('401')) {
      void this.error('Invalid access token', {
        detail: 'Your Personal Access Token is invalid or expired.',
        actions: [
          { title: 'Update Token', action: () => void vscode.commands.executeCommand('antigravitySync.configure') }
        ]
      });
    } else if (error.message.includes('network') || error.message.includes('ENOTFOUND')) {
      void this.error('Network error', {
        detail: 'Please check your internet connection.',
        actions: [
          { title: 'Retry', action: () => void vscode.commands.executeCommand('antigravitySync.syncNow') }
        ]
      });
    } else {
      void this.error('Sync failed', {
        detail: error.message,
        actions: [
          { title: 'Retry', action: () => void vscode.commands.executeCommand('antigravitySync.syncNow') },
          { title: 'Show Logs', action: () => void vscode.commands.executeCommand('workbench.action.toggleDevTools') }
        ]
      });
    }
  }

  /**
   * Conflict notification
   */
  static handleConflict(files: string[]): void {
    void this.warning('Merge conflict detected', {
      detail: `${files.length} file(s) have conflicts. Auto-merge was applied.`,
      actions: [
        {
          title: 'View Files', action: () => {
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
