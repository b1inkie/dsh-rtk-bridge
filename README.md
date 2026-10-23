# dsh-rtk-bridge

把 [rtk](https://github.com/rtk-ai/rtk) 接进 DeepSeek Harness。模型调用 `pwsh` / `bash` 时，插件先用 `rtk rewrite` 查找等价命令；命中就用改写后的命令执行，让 rtk 的压缩输出直接进入上下文。

```text
git status  →  rtk git status  →  * master
                                    M a.txt
```

## 功能

- **自动改写并执行**：包装 shell 工具的 `execute`，直接运行 `rtk ...`，不需要模型重试。
- **支持 pwsh / bash**：Windows 走 `pwsh`，Linux / macOS 走 `bash`。
- **失败放行**：rtk 缺失、版本过旧、无等价命令、超时、改写结果不安全时，执行原命令。
- **Windows 安全名单**：不会把 `ls` / `grep` / `find` 等改写成 Windows 上不可用的 rtk 子命令。
- **防重复前缀**：`rtk ...`、`rtk.exe ...` 以及带环境变量前缀的 rtk 命令原样执行。
- **清理噪音**：移除 rtk 输出里的 `[rtk] No hook installed` 等提示。
- **兜底**：工具定义不可写时自动切到 `tools/execute` 短路，继续改写。
- **状态命令**：`/rtk` 查看 rtk 路径、版本、计数、沙箱状态，并可运行时开关。

## 要求

- DeepSeek Harness（已在 0.1.5-rc.1 验证）
- rtk >= 0.23.0
- Node >= 22.19

rtk 安装：<https://www.rtk-ai.app/docs/getting-started/installation/>

Windows 把 `rtk.exe` 放进 PATH 即可。插件查找顺序：

1. `rtkPath` 配置
2. `DSH_RTK_BIN` / `RTK_BIN`
3. PATH 上的 `rtk` / `rtk.exe`
4. `~/.local/bin`、`~/.cargo/bin`、`%LOCALAPPDATA%\Programs\rtk`、WinGet Links

## 安装

### 插件市场（桌面端）

「设置 → 插件市场 → 自定义安装 → GitHub」：

```text
https://github.com/b1inkie/dsh-rtk-bridge
```

### 命令行

```powershell
dsh plugin --profile web add -w "github:b1inkie/dsh-rtk-bridge#<commit-sha>"
```

### 本地开发

```yaml
# dev.patch.yml
- insert:
    - id: rtk-bridge-dev
      name: 'D:/path/to/dsh-rtk-bridge/lib/index.js'
      config:
        debug: true
```

```powershell
dsh --profile web --patch D:/path/to/dev.patch.yml
```

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: rtk-bridge
  config:
    enabled: true
    mode: rewrite            # rewrite | suggest
    intercept: auto          # auto | patch | dispatch
    tools: [pwsh, bash]
    rtkPath: ''
    timeoutMs: 2000
    excludedSubcommands: []
    rewriteWhenConfined: false
    debug: false
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `mode` | `rewrite` | `rewrite` 执行改写命令；`suggest` 改为 deny 并提示改写命令 |
| `intercept` | `auto` | `auto` 包装 `execute`，失败时切 dispatch；`patch` 只包装；`dispatch` 只走 `tools/execute` 短路 |
| `tools` | `[pwsh, bash]` | 要拦截的 shell 工具 |
| `rtkPath` | `''` | 显式指定 rtk 可执行文件 |
| `timeoutMs` | `2000` | `rtk rewrite` 超时 |
| `excludedSubcommands` | `[]` | 不改写的 rtk 子命令 |
| `rewriteWhenConfined` | `false` | Windows 受限沙箱里是否强制尝试 |
| `debug` | `false` | 输出改写日志 |

## `/rtk` 命令

| 命令 | 作用 |
|---|---|
| `/rtk` / `/rtk status` | rtk 路径、版本、工具状态、计数器、沙箱状态 |
| `/rtk verify` | 重新探测 rtk |
| `/rtk rewrite git status` | 预览改写结果 |
| `/rtk gain` | rtk 全局节省统计 |
| `/rtk on` / `/rtk off` | 运行时开关 |
| `/rtk stats` | 改写 / 回退 / 失败计数 |

## 验证

```powershell
rtk --version
rtk rewrite "git status"
```

执行一次 `git status` 后，`/rtk status` 的 `rewrites` 应增加；`/rtk gain` 可查看 rtk 自己的统计。

## 说明

- **Windows 受限沙箱**：`read-only` / `workspace-write` 下 rtk 无法抓取子进程输出，插件默认暂停改写，原命令照常执行。需要完整功能请使用 `danger-full-access`。
- **工具卡片显示原始命令**：DSH 不修改模型参数，所以记录里是 `git status`，实际执行的是 `rtk git status`。
- **只处理 shell 工具**：不处理 `read` / `grep` / `fs` 等原生工具。
- **不做额外输出压缩**：压缩由 rtk 完成，DSH 负责超长截断。

## 开发

```powershell
node --test tests/*.test.mjs
npm pack --dry-run
```

## 许可证

MIT
