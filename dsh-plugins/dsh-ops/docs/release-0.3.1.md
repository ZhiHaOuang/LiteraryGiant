# dsh-ops 0.3.1 — Windows x64、Linux x64 与 Apple Silicon

## 精确支持范围

- Windows x64：`win32-x64`。
- Linux x64：`linux-x64`（GNU/Linux；ELF worker）。
- macOS Apple Silicon：`darwin-arm64`（APFS；Mach-O worker）。
- **不支持 Intel Mac、Windows ARM64、Linux ARM64 或 OpenHarmony。** npm 的 os/cpu 字段不能表达配对矩阵，实际支持以 runtime 白名单和组件 `targets` 为准。
- 目标宿主 DSH `0.2.0-rc.2`；PTC 组件保持显式启用、仅纯 PTC 会话发布。

## Shell 与安装载荷

- Bash、PowerShell 7 保留为 `@dsh-ops/bash-win32-x64@0.2.1`、`@dsh-ops/pwsh-win32-x64@0.2.1` 固定版本可选依赖；子包声明 `os: [win32]`、`cpu: [x64]`。
- Linux/macOS 安装不落地这两个 Windows shell 包。没有 postinstall 下载器；#90 保持 open，二进制管理将另行制定方案。
- POSIX 的 `ops_bash` 使用宿主 Bash；受限模式仍须通过 DSH sandbox，缺失或不可用时拒绝执行，不裸执行回退。macOS 优先支持显式 `bashPath`、PATH 和 Homebrew/system 位置。
- Windows 的 IPC 私有兼容副本、固定摘要校验和宿主权限边界保持不变；macOS 不承诺 pwsh 工具。后台组件默认关闭，正式声明仍限 Windows。

## 主要改动

- 整合 Linux #81 和 macOS #67 的原始提交历史；Linux #70/#71/#72/#56 的工作由 #81 整合。#69 的 macOS `/tmp`、`/var` 父目录别名修复已包含在 #67。
- native worker 的版本、receipt、SHA256、PE/ELF/Mach-O 架构检查与精确平台矩阵一致；正式 release gate 强制三个目标齐全并验证 Windows IPC。单机开发使用 `check --staged`，不得冒充完整发布检查。
- Linux 目录句柄 `O_PATH` 导致的 `fsync EBADF` 保留真实持久化屏障，不吞错误。
- 替换时私有临时 inode、Linux ACL 清理、mode/owner/xattr 恢复后再 fsync；macOS APFS clone 保留 Darwin 元数据，无法克隆的文件系统拒绝替换，不静默丢 ACL。
- 稳定路径锁覆盖 cooperating replace 的读／revision 检查／发布窗口，避免 atomic rename 换 inode 后锁失效；隐藏锁文件持久保留，不能在并发写入时删除。
- 凭据规则应用于遍历出来的文件和 batch 源树，不再只校验请求入口；显式关闭策略仍由 operator config 控制。
- 修复 hex 首行、跨行 grep、长行输出预算与 UTF-8 收集分块边界；同步 macOS、Windows 8.3 路径和平台专属测试夹具。
- 纳入 #107：工作区路径以实际 reparse ancestry 判定，不把 Windows 8.3 短名误当 junction；真实链接仍拒绝。

## 验证与分发

本次仅发布 **GitHub Release**，不执行 npm publish。Release 的源码/tag 与验证过的运行时产物相对应；正式消费者包须通过三平台产物闭包检查。

- 使用手动触发、只读 contents 权限的三平台 Actions 工作流；它没有 npm 凭据或 npm publish 步骤。
- 每个 runner 校验自身 `process.platform/process.arch`，构建和测试 native worker、构建可选 FastCtx、运行 manifest 与完整测试，并验证 Windows shell 平台过滤。
- 平台不适用的 suite 明确记为 skip，不计为 pass；不能以 Linux 结果代替 macOS 或 Windows 结果。
- 首轮验证暴露的 xattr、locale、8.3 路径和测试夹具差异被保留为修复依据；首轮失败不是最终通过证据。最终 run 链接、产物摘要和验收数字以 GitHub Release 正文为准。
- 完成此次发布后恢复仓库 Actions 关闭；旧自动 Release workflow 在临时启用期间单独停用，不会因 tag push 运行。

## 使用注意与剩余边界

- Git checkout 不携带生成的 worker；本机开发需 `npm ci`、`npm run build:ptc` 后测试。macOS 仅 Apple Silicon，替换需 APFS clone 支持。
- 正常退出并重启 Desktop 后加载新模块；不自动更改已有 profile。
- Windows restricted enforcement 仍按宿主报告的 partial，不冒充完整隔离。Windows 自定义 DACL/ADS 等文件元数据边界见 `windows-verification.md`，不宣称此次完成通用元数据保真。
- advisory 路径锁只串行化采用本协议的写入者；外部编辑器不会被强行纳入锁协议。
- token benchmark 不是跨任务通用性能保证。
- 历史 PortableGit 完整 source-delivery 闭包限制见 PROVENANCE；不分发本机修改后的 MSYS DLL。
