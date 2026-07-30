# DvalinCode Bug Log

记录开发/测试过程中发现的 Bug，供后续开发参考。

---

## BUG-001: `resolveInsideWorkspace` 对不存在的嵌套目录抛出 ENOENT

**发现日期**: 2026-06-11  
**状态**: ✅ 已修复  
**文件**: `src/core/workspace.ts`

### 现象
LLM 通过 `write_file` 工具尝试写入 `calc/src/index.ts` 时报错：
```
Error: ENOENT: no such file or directory, realpath '/Users/.../dvalincode/calc'
```

### 根本原因
原来的 catch 块只尝试 `realpath(path.dirname(target))`——如果父目录也不存在（如 `calc/src/`），这个调用同样会抛出，导致错误未被处理。

### 修复
在 catch 块中向上遍历目录树，找到最近的真实存在的祖先目录，再拼接剩余路径段：

```typescript
const resolvedTarget = await realpath(target).catch(async () => {
  let ancestor = path.dirname(target);
  const segments: string[] = [path.basename(target)];
  while (ancestor !== path.dirname(ancestor)) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      return path.join(resolvedAncestor, ...segments);
    } catch {
      segments.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  throw new Error(`Cannot resolve path: no existing ancestor found for ${target}`);
});
```

---

## BUG-002: `spawn sandbox-exec ENOENT` — shell 工具在某些环境下无法执行

**发现日期**: 2026-06-11  
**状态**: ✅ 已修复  
**文件**: `src/tools/shell.ts`

### 现象
DvalinCode 在 Code 模式下通过 shell 工具运行 `npm install` 时报：
```
spawn sandbox-exec ENOENT
```

### 根本原因
`sandbox-exec` 被硬编码启用（`process.platform === 'darwin'`），但 `spawn` 通过 `PATH` 查找可执行文件时，`which sandbox-exec` 可能因 Node.js 进程的 PATH 不包含 `/usr/bin` 而失败。

### 修复
在启用沙箱前先异步检查可用性：

```typescript
async function isSandboxExecAvailable(): Promise<boolean> {
  try { await execAsync('which', ['sandbox-exec']); return true; } catch { return false; }
}

// in run():
const sandboxEnabled = process.platform === 'darwin' && await isSandboxExecAvailable();
```

### 副作用
即使 `sandbox-exec` 可用，沙箱内的 `npm`/`npx` 也可能因 nvm 路径不在沙箱 PATH 中而失败。**当前建议**：沙箱仅用于不需要包管理器的命令；`npm install` / `npx tsc` 由用户在沙箱外手动执行。

---

## BUG-003: 服务器以错误的 `cwd` 启动导致所有路径解析失败

**发现日期**: 2026-06-11  
**状态**: ✅ 规避（操作规范）  
**文件**: `src/server/index.ts`（运行方式问题）

### 现象
后端报：
```
ENOENT: no such file or directory, realpath '/Users/panchao/Documents/dvalincode'
```
（`Claude` 子目录丢失）

### 根本原因
Bash 工具的 working directory 在之前 `cd web/` 后没有重置。从错误的 shell cwd 启动服务器时，`process.cwd()` 为错误路径，而前端 Settings 中 cwd 为空时后端会 fallback 到 `process.cwd()`。

### 规避
始终用显式绝对路径的子 shell 启动服务器：
```bash
(cd /Users/panchao/Documents/Claude/dvalincode && PORT=3001 npx tsx src/server/index.ts)
```

### 建议改进
后端启动时打印 `process.cwd()` 到日志，方便排查。或者，将 workspace cwd 的 fallback 改为强制要求前端配置，而非静默使用 `process.cwd()`。

---

## BUG-004: Settings UI 保存了历史错误的 `cwd`，跨会话污染

**发现日期**: 2026-06-11  
**状态**: 📋 待优化  
**文件**: `web/src/App.tsx`（前端持久化逻辑）

### 现象
打开 DvalinCode 后，Settings 中 Workspace 字段仍显示上一个会话中设置的错误路径（如 `/Users/panchao/Documents/dvalincode`，少了 `Claude`），导致所有文件操作报错。

### 根本原因
Settings 通过 `localStorage` 持久化，错误值会跨会话保留直到用户手动修改。

### 建议改进
每次启动时校验 `cwd` 路径是否真实存在（`fs.existsSync`），如不存在则清空并提示用户重新配置。

---

## BUG-005: 聊天框换行触发消息发送，无法输入多行需求

**发现日期**: 2026-06-11  
**状态**: 📋 待优化  
**文件**: `web/src/` 聊天输入组件

### 现象
在聊天框中按 Enter（或输入包含 `\n` 的文本）时，消息立即发送，无法输入多行需求。

### 影响
用户需要把需求压缩成单行，降低可读性；复杂需求难以清晰表达。

### 建议改进
- Enter 插入换行，Ctrl+Enter / Cmd+Enter 发送（与 Slack/GitHub 等产品一致）
- 或提供 `/load <file>` 命令支持从文件读取长 prompt

---

## BUG-006: `ref_*` 元素引用在页面导航后失效

**发现日期**: 2026-06-11  
**状态**: ℹ️ 已知限制（Chrome MCP 行为）  
**组件**: Chrome MCP (`mcp__Claude_in_Chrome__find`)

### 现象
页面刷新或导航后，之前 `find` 返回的 `ref_62` 等引用变为无效，后续操作报 `Element not found`。

### 原因
Chrome MCP 的元素引用是基于当前 DOM 快照生成的，页面重载后 DOM 重建，旧引用自动失效。

### 处理方式
每次页面变化后重新调用 `find` 获取新引用。这是正常行为，无需在产品层面修复。

---

## BUG-007: Windows 进程运行器硬编码 `/bin/sh`，OS 命令无法启动

**发现日期**: 2026-07-30
**状态**: ✅ 已修复
**文件**: `src/core/subprocessSandbox.ts`

### 问题定义

受治理的 `shell` 与 `run_check` 共用进程运行器。此前运行器在所有平台上都生成
`/bin/sh -c <command>`，这隐含了 POSIX 宿主假设。在 Windows 上 `/bin/sh` 通常不存在，
所以 `cmd`、`dir`、`npm.cmd` 等命令会在执行前以 `ENOENT` 失败。

跨平台执行契约为：

- Linux、macOS：通过 `/bin/sh -c` 执行 shell 命令行。
- Windows：通过系统 `ComSpec`（缺省为 `cmd.exe`）执行 `cmd.exe /d /s /c` 命令行。
- `command` 单独使用时表示原生 shell 命令行，可包含管道、重定向和条件操作符。
- 同时传入 `args` 时，`command` 表示可执行文件名或路径；命令与每个参数按宿主 shell
  规则分别转义。
- 中断或超时时必须终止整个子进程树：POSIX 使用独立进程组，Windows 使用
  `taskkill.exe /T /F`。
- OS 网络沙箱能力保持原有安全边界：Seatbelt（macOS）、Bubblewrap（Linux）；
  Windows 在限制性网络策略下仍然 fail closed，不以“跨平台执行”为由绕过组织策略。

### 验收

CI 在 Ubuntu、Windows 和 macOS 上运行同一组原生命令执行、参数转义、取消与沙箱选择
回归测试。Windows 启动参数中不得出现 `/bin/sh`，路径位于 `Program Files` 下的可执行
文件必须被正确引用。
