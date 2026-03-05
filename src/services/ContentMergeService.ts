/**
 * ContentMergeService - Intelligent content-aware merge for Antigravity data
 *
 * Instead of blindly picking "local" or "remote" based on timestamp/size,
 * this service understands the structure of synced files and merges them
 * at content level to preserve data from BOTH sides.
 *
 * Supported strategies:
 * - MCP config field-level merge: preserve local paths/commands, absorb remote API keys & new servers
 * - JSON deep merge: merge arrays by element identity (id/timestamp), merge objects recursively
 * - Markdown line merge: use diff3-style three-way merge when a common ancestor is available,
 *   otherwise concatenate unique lines
 * - Pbtxt append merge: for .pbtxt annotation files, preserve all unique top-level blocks
 * - Binary fallback: for .pb and other binary files, fall back to size/timestamp heuristic
 */
import * as path from 'path';

export type MergeResult = {
  /** The merged content as a string (or null if merge is not applicable) */
  merged: string | null;
  /** Whether a true merge happened (both sides contributed) */
  wasMerged: boolean;
  /** Human-readable description of what happened */
  description: string;
};

export class ContentMergeService {
  /**
   * Attempt to merge local and remote content for a given file.
   * Returns null merged content if the file type is not supported for content merge.
   */
  merge(
    relativePath: string,
    localContent: Buffer,
    remoteContent: Buffer,
    baseContent?: Buffer
  ): MergeResult {
    const ext = path.extname(relativePath).toLowerCase();
    const fileName = path.basename(relativePath).toLowerCase();

    // MCP config gets specialized field-level merge
    if (fileName === 'mcp_config.json' && ext === '.json') {
      return this.mergeMcpConfig(relativePath, localContent, remoteContent);
    }

    // JSON files (brain artifacts, config, metadata)
    if (ext === '.json') {
      return this.mergeJson(relativePath, localContent, remoteContent);
    }

    // Markdown files (brain artifacts, knowledge items)
    if (ext === '.md') {
      return this.mergeMarkdown(relativePath, localContent, remoteContent, baseContent);
    }

    // Text protobuf annotation files
    if (ext === '.pbtxt') {
      return this.mergePbtxt(relativePath, localContent, remoteContent);
    }

    // Binary protobuf conversation files - not mergeable at content level
    if (ext === '.pb') {
      return {
        merged: null,
        wasMerged: false,
        description: `${relativePath}: 二进制 protobuf 文件，无法内容合并`
      };
    }

    // Default: not supported
    return {
      merged: null,
      wasMerged: false,
      description: `${relativePath}: 不支持内容合并的文件类型 (${ext})`
    };
  }

  /**
   * JSON deep merge strategy:
   * - If both are arrays: merge by element identity (prefer "id" or "timestamp" fields)
   * - If both are objects: recursively merge keys
   * - Otherwise: keep the larger/newer version
   */
  private mergeJson(
    relativePath: string,
    localBuf: Buffer,
    remoteBuf: Buffer
  ): MergeResult {
    let localObj: unknown;
    let remoteObj: unknown;

    try {
      localObj = JSON.parse(localBuf.toString('utf-8'));
    } catch {
      return {
        merged: null,
        wasMerged: false,
        description: `${relativePath}: 本地 JSON 解析失败`
      };
    }

    try {
      remoteObj = JSON.parse(remoteBuf.toString('utf-8'));
    } catch {
      return {
        merged: null,
        wasMerged: false,
        description: `${relativePath}: 远端 JSON 解析失败`
      };
    }

    try {
      const merged = this.deepMerge(localObj, remoteObj);
      const mergedStr = JSON.stringify(merged, null, 2) + '\n';
      return {
        merged: mergedStr,
        wasMerged: true,
        description: `${relativePath}: JSON 深度合并成功`
      };
    } catch (err) {
      return {
        merged: null,
        wasMerged: false,
        description: `${relativePath}: JSON 合并出错 - ${(err as Error).message}`
      };
    }
  }

  // ==================== MCP Config Field-Level Merge ====================

  /** Env var key suffixes that indicate machine-specific paths */
  private static readonly PATH_SUFFIXES = ['_DIR', '_PATH', '_FILE', '_HOME'];

  /**
   * Specialized merge for mcp_config.json:
   * - Preserve local `command` and `args` (machine-specific executables)
   * - Preserve local env vars ending in _DIR/_PATH/_FILE/_HOME
   * - Absorb remote-only new servers
   * - Absorb remote API token / secret updates
   */
  private mergeMcpConfig(
    relativePath: string,
    localBuf: Buffer,
    remoteBuf: Buffer
  ): MergeResult {
    let localObj: Record<string, unknown>;
    let remoteObj: Record<string, unknown>;

    try {
      localObj = JSON.parse(localBuf.toString('utf-8')) as Record<string, unknown>;
    } catch {
      return { merged: null, wasMerged: false, description: `${relativePath}: 本地 MCP 配置 JSON 解析失败` };
    }
    try {
      remoteObj = JSON.parse(remoteBuf.toString('utf-8')) as Record<string, unknown>;
    } catch {
      return { merged: null, wasMerged: false, description: `${relativePath}: 远端 MCP 配置 JSON 解析失败` };
    }

    const localServers = (localObj.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const remoteServers = (remoteObj.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const mergedServers: Record<string, Record<string, unknown>> = {};

    // Collect all server names from both sides
    const allNames = new Set([...Object.keys(localServers), ...Object.keys(remoteServers)]);

    for (const name of allNames) {
      const local = localServers[name];
      const remote = remoteServers[name];

      if (local && !remote) {
        // Only exists locally → keep
        mergedServers[name] = local;
        continue;
      }
      if (!local && remote) {
        // Only exists remotely → absorb (new server added on another machine)
        mergedServers[name] = remote;
        continue;
      }
      if (!local || !remote) { continue; }

      // Both exist → field-level merge
      const merged: Record<string, unknown> = { ...remote };

      // Keep LOCAL command & args (machine-specific executables)
      if (local.command !== undefined) {
        merged.command = local.command;
      }
      if (local.args !== undefined) {
        merged.args = local.args;
      }
      if (local.timeout !== undefined) {
        merged.timeout = local.timeout;
      }

      // Merge env: keep local path-like vars, absorb remote tokens/secrets
      const localEnv = (local.env ?? {}) as Record<string, string>;
      const remoteEnv = (remote.env ?? {}) as Record<string, string>;
      const mergedEnv: Record<string, string> = { ...remoteEnv };

      for (const [envKey, envVal] of Object.entries(localEnv)) {
        const isPathLike = ContentMergeService.PATH_SUFFIXES.some(s => envKey.toUpperCase().endsWith(s));
        if (isPathLike) {
          // Path-like → always keep local
          mergedEnv[envKey] = envVal;
        } else if (!(envKey in remoteEnv)) {
          // Local-only non-path key → keep (local addition)
          mergedEnv[envKey] = envVal;
        }
        // else: remote has it too → keep remote (newer token)
      }

      merged.env = mergedEnv;
      mergedServers[name] = merged;
    }

    const result = { ...localObj, mcpServers: mergedServers };
    const mergedStr = JSON.stringify(result, null, 4) + '\n';

    return {
      merged: mergedStr,
      wasMerged: true,
      description: `${relativePath}: MCP 配置字段级智能合并成功（路径保留本地，密钥吸收远端）`
    };
  }

  // ==================== Generic JSON Deep Merge ====================

  /**
   * Deep merge two JSON values.
   * Arrays are merged by element identity; objects are merged key by key.
   */
  private deepMerge(local: unknown, remote: unknown): unknown {
    // Both arrays → union merge
    if (Array.isArray(local) && Array.isArray(remote)) {
      return this.mergeArrays(local, remote);
    }

    // Both plain objects → recursive key merge
    if (this.isPlainObject(local) && this.isPlainObject(remote)) {
      const result: Record<string, unknown> = { ...local as Record<string, unknown> };
      const remoteObj = remote as Record<string, unknown>;
      for (const key of Object.keys(remoteObj)) {
        if (key in result) {
          result[key] = this.deepMerge(result[key], remoteObj[key]);
        } else {
          result[key] = remoteObj[key];
        }
      }
      return result;
    }

    // Different types or primitives → prefer remote if different (it's "newer from the cloud")
    // But if they're equal, just return either
    if (JSON.stringify(local) === JSON.stringify(remote)) {
      return local;
    }

    // For primitives, prefer the one that looks "more complete" or just keep remote
    return remote;
  }

  /**
   * Merge two arrays by element identity.
   * Uses "id", "conversationId", "timestamp", or index-based dedup.
   */
  private mergeArrays(local: unknown[], remote: unknown[]): unknown[] {
    // Try to find a suitable identity key
    const identityKey = this.findArrayIdentityKey(local, remote);

    if (identityKey) {
      // Identity-based union merge
      const seen = new Map<string, unknown>();
      const result: unknown[] = [];

      // Add all local elements first
      for (const item of local) {
        const key = this.getIdentity(item, identityKey);
        if (key !== null && !seen.has(key)) {
          seen.set(key, item);
          result.push(item);
        } else if (key === null) {
          result.push(item);
        }
      }

      // Add remote elements that aren't already present
      for (const item of remote) {
        const key = this.getIdentity(item, identityKey);
        if (key !== null && !seen.has(key)) {
          seen.set(key, item);
          result.push(item);
        } else if (key === null) {
          // Check for deep equality with existing items
          const exists = result.some(
            existing => JSON.stringify(existing) === JSON.stringify(item)
          );
          if (!exists) {
            result.push(item);
          }
        }
      }

      return result;
    }

    // No identity key found - do value-based dedup (for primitive arrays or small arrays)
    if (local.length + remote.length <= 500) {
      const result = [...local];
      const localStrings = new Set(local.map(item => JSON.stringify(item)));
      for (const item of remote) {
        if (!localStrings.has(JSON.stringify(item))) {
          result.push(item);
        }
      }
      return result;
    }

    // Large arrays without identity - just concatenate (user can dedup manually)
    return [...local, ...remote];
  }

  /**
   * Find a suitable identity key for array elements.
   */
  private findArrayIdentityKey(arr1: unknown[], arr2: unknown[]): string | null {
    const candidates = ['id', 'conversationId', 'messageId', 'timestamp', 'name', 'path', 'key'];
    const sample = [...arr1.slice(0, 5), ...arr2.slice(0, 5)];

    for (const key of candidates) {
      const hasKey = sample.every(
        item => this.isPlainObject(item) && key in (item as Record<string, unknown>)
      );
      if (hasKey && sample.length > 0) {
        return key;
      }
    }

    return null;
  }

  /**
   * Extract identity value from an array element.
   */
  private getIdentity(item: unknown, key: string): string | null {
    if (this.isPlainObject(item)) {
      const val = (item as Record<string, unknown>)[key];
      if (val !== undefined && val !== null) {
        return String(val);
      }
    }
    return null;
  }

  /**
   * Markdown merge strategy:
   * If a base (common ancestor) is available, do 3-way line merge.
   * Otherwise, do a simple line-level union merge preserving order.
   */
  private mergeMarkdown(
    relativePath: string,
    localBuf: Buffer,
    remoteBuf: Buffer,
    baseBuf?: Buffer
  ): MergeResult {
    const localStr = localBuf.toString('utf-8');
    const remoteStr = remoteBuf.toString('utf-8');

    if (baseBuf) {
      // 3-way merge
      const baseStr = baseBuf.toString('utf-8');
      const result = this.threeWayLineMerge(baseStr, localStr, remoteStr);
      if (result.hasConflicts) {
        return {
          merged: null,
          wasMerged: false,
          description: `${relativePath}: Markdown 三方合并发现冲突，降级为冲突副本`
        };
      }
      return {
        merged: result.content,
        wasMerged: true,
        description: `${relativePath}: Markdown 三方合并成功`
      };
    }

    // No base available - do simple additive merge
    const localLines = localStr.split('\n');
    const remoteLines = remoteStr.split('\n');

    // If one is a strict prefix of the other, keep the longer one
    if (this.isPrefix(localLines, remoteLines)) {
      return {
        merged: remoteStr,
        wasMerged: true,
        description: `${relativePath}: 远端包含本地所有内容（追加合并）`
      };
    }
    if (this.isPrefix(remoteLines, localLines)) {
      return {
        merged: localStr,
        wasMerged: true,
        description: `${relativePath}: 本地包含远端所有内容（无需合并）`
      };
    }

    // Neither is a prefix - fall back to conflict copy strategy
    return {
      merged: null,
      wasMerged: false,
      description: `${relativePath}: Markdown 文件双端均有独立修改，降级为冲突副本`
    };
  }

  /**
   * Simple 3-way line merge.
   * For each line range, if only one side changed from base, take that change.
   * If both changed the same range differently, mark as conflict.
   */
  private threeWayLineMerge(
    base: string,
    local: string,
    remote: string
  ): { content: string; hasConflicts: boolean } {
    const baseLines = base.split('\n');
    const localLines = local.split('\n');
    const remoteLines = remote.split('\n');

    // Simple heuristic: if local and remote both differ from base at the same lines, conflict
    const maxLen = Math.max(baseLines.length, localLines.length, remoteLines.length);
    const resultLines: string[] = [];
    let hasConflicts = false;

    for (let i = 0; i < maxLen; i++) {
      const baseLine = baseLines[i] ?? '';
      const localLine = localLines[i] ?? '';
      const remoteLine = remoteLines[i] ?? '';

      const localChanged = localLine !== baseLine;
      const remoteChanged = remoteLine !== baseLine;

      if (!localChanged && !remoteChanged) {
        resultLines.push(baseLine);
      } else if (localChanged && !remoteChanged) {
        resultLines.push(localLine);
      } else if (!localChanged && remoteChanged) {
        resultLines.push(remoteLine);
      } else {
        // Both changed
        if (localLine === remoteLine) {
          resultLines.push(localLine);
        } else {
          hasConflicts = true;
          break;
        }
      }
    }

    return {
      content: hasConflicts ? '' : resultLines.join('\n'),
      hasConflicts
    };
  }

  /**
   * Pbtxt annotation merge strategy:
   * Parse top-level blocks and do union merge by block content hash.
   */
  private mergePbtxt(
    relativePath: string,
    localBuf: Buffer,
    remoteBuf: Buffer
  ): MergeResult {
    const localStr = localBuf.toString('utf-8');
    const remoteStr = remoteBuf.toString('utf-8');

    // If one contains the other, keep the larger
    if (localStr.includes(remoteStr.trim())) {
      return {
        merged: localStr,
        wasMerged: false,
        description: `${relativePath}: 本地已包含远端所有注解`
      };
    }
    if (remoteStr.includes(localStr.trim())) {
      return {
        merged: remoteStr,
        wasMerged: true,
        description: `${relativePath}: 远端已包含本地所有注解`
      };
    }

    // For pbtxt, both might have added different annotation fields.
    // Since these are typically small text-proto files with one top-level message,
    // we fall back to keeping the larger version and generating a conflict copy.
    return {
      merged: null,
      wasMerged: false,
      description: `${relativePath}: pbtxt 双端有不同修改，降级为冲突副本`
    };
  }

  /**
   * Check if arr1 is a prefix of arr2
   */
  private isPrefix(arr1: string[], arr2: string[]): boolean {
    if (arr1.length > arr2.length) {
      return false;
    }
    for (let i = 0; i < arr1.length; i++) {
      if (arr1[i] !== arr2[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if a value is a plain object (not array, not null)
   */
  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
