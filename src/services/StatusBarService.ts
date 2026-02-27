/**
 * StatusBarService - VS Code status bar integration
 */
import * as vscode from 'vscode';

export enum SyncState {
  Synced = 'synced',
  Syncing = 'syncing',
  Pushing = 'pushing',
  Pulling = 'pulling',
  Pending = 'pending',
  Error = 'error',
  NotConfigured = 'not-configured'
}

interface StateConfig {
  icon: string;
  text: string;
  tooltip: string;
  color?: vscode.ThemeColor;
}

const STATE_CONFIGS: Record<SyncState, StateConfig> = {
  [SyncState.Synced]: {
    icon: '$(check)',
    text: '已同步',
    tooltip: 'Antigravity 同步：已完成同步'
  },
  [SyncState.Syncing]: {
    icon: '$(sync~spin)',
    text: '同步中...',
    tooltip: 'Antigravity 同步：正在同步...'
  },
  [SyncState.Pushing]: {
    icon: '$(cloud-upload)',
    text: '推送中...',
    tooltip: 'Antigravity 同步：正在推送...'
  },
  [SyncState.Pulling]: {
    icon: '$(cloud-download)',
    text: '拉取中...',
    tooltip: 'Antigravity 同步：正在拉取...'
  },
  [SyncState.Pending]: {
    icon: '$(circle-outline)',
    text: '待同步',
    tooltip: 'Antigravity 同步：有待同步变更，点击查看'
  },
  [SyncState.Error]: {
    icon: '$(error)',
    text: '错误',
    tooltip: 'Antigravity 同步：同步失败，点击重试',
    color: new vscode.ThemeColor('errorForeground')
  },
  [SyncState.NotConfigured]: {
    icon: '$(gear)',
    text: '未配置',
    tooltip: 'Antigravity 同步：点击配置'
  }
};

export class StatusBarService {
  private statusBarItem: vscode.StatusBarItem;
  private currentState: SyncState = SyncState.NotConfigured;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'antigravitySync.syncNow';
    this.update(SyncState.NotConfigured);
  }

  /**
   * Update status bar state
   */
  update(state: SyncState): void {
    this.currentState = state;
    const config = STATE_CONFIGS[state];

    this.statusBarItem.text = `${config.icon} ${config.text}`;
    this.statusBarItem.tooltip = config.tooltip;
    this.statusBarItem.color = config.color;

    // Change command based on state
    if (state === SyncState.NotConfigured) {
      this.statusBarItem.command = 'antigravitySync.configure';
    } else if (state === SyncState.Error) {
      this.statusBarItem.command = 'antigravitySync.syncNow';
    } else {
      this.statusBarItem.command = 'antigravitySync.showStatus';
    }
  }

  /**
   * Set error state with custom message
   */
  setError(errorMessage: string): void {
    this.currentState = SyncState.Error;
    const shortMessage = errorMessage.length > 50
      ? errorMessage.substring(0, 47) + '...'
      : errorMessage;

    this.statusBarItem.text = `$(error) ${shortMessage}`;
    this.statusBarItem.tooltip = `Antigravity 同步错误：${errorMessage}\n\n点击重试`;
    this.statusBarItem.color = new vscode.ThemeColor('errorForeground');
    this.statusBarItem.command = 'antigravitySync.syncNow';
  }

  /**
   * Get current state
   */
  getState(): SyncState {
    return this.currentState;
  }

  /**
   * Show status bar item
   */
  show(): void {
    this.statusBarItem.show();
  }

  /**
   * Hide status bar item
   */
  hide(): void {
    this.statusBarItem.hide();
  }

  /**
   * Get the status bar item for disposal
   */
  getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem;
  }
}
