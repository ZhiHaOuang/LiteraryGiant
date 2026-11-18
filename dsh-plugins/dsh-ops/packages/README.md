# Platform package skeletons

`bash-win32-x64/` is the committed skeleton of the Windows Bash platform package this plugin
publishes; the release build assembles it from the verified pinned upstream tree plus a per-package
`provenance.json`. `pwsh-win32-x64/` is historical only: PowerShell stays host-managed and is never
packaged.

| Skeleton | Released as | What it carries |
| --- | --- | --- |
| `bash-win32-x64/` | `@dsh-ops/bash-win32-x64@0.2.1`, declared as an optional dependency of the main package | Git for Windows PortableGit, the pinned upstream release, unchanged (GNU bash 5.3.15) |
| `pwsh-win32-x64/` | not published (historical skeleton) | — |

**No binary is ever committed here.** The main package's published copy declares
`@dsh-ops/bash-win32-x64@0.2.1` in `optionalDependencies`, so npm fetches it automatically on
Windows x64 and skips it on platforms it does not cover; POSIX keeps the system Bash. Because an
optional dependency resolves silently when it is missing, `dsh-ops bash-runtime install` remains the
repair path. See [usage](../docs/usage.md).

这些目录保留平台包骨架：`bash-win32-x64/` 是主包 Windows bash 可选依赖的骨架，发布构建用固定的上游 PortableGit 树与 `provenance.json` 组装；`pwsh-win32-x64/` 仅作历史记录，PowerShell 始终由宿主管理，不随包发布。主包在 `optionalDependencies` 中声明 `@dsh-ops/bash-win32-x64@0.2.1`，Windows x64 上 npm 安装时自动拉取，其它平台跳过并继续使用系统 bash；可选依赖缺失时解析是静默的，因此 `dsh-ops bash-runtime install` 仍是修复路径。详见[使用指南](../docs/使用指南.md)。
