# Mac 开发与 Linux 服务器运行

## 新 DSH 开发入口（2026-11-07）

当前优先方向为 `dsh/` 框架与 `dsh-plugins/` 插件，逐步承接原产品功能。它们作为源码快照纳入父仓库，不是外部目录链接或新增子模块。Node >=24.9、固定 pnpm 的准备与构建命令见 [DSH 源码与本机开发入口](dsh-local-app.md)。下方 Python、Extension 和旧 Runtime 的步骤继续用于原产品与迁移对照，不表示已接入新 DSH。

## 取得完整源码

```bash
git clone --recurse-submodules https://github.com/ZhiHaOuang/LiteraryGiant.git
cd LiteraryGiant
git submodule status
```

已经普通 clone 时，在根目录执行 `git submodule update --init --recursive`。子模块的 detached HEAD 是父仓库固定版本的正常结果。要修改产品代码，先在 `LiteraryAgent` 内基于当前提交新建工作分支；提交并推送子仓库后，再提交父仓库的引用变化。

Mac 后续推送需单独配置你自己的 GitHub 登录或 SSH 凭据；服务器上的 GitHub 认证资料不迁移。

`LiteraryAgent/core/codex` 是 vendored 前缀，不是第三个子模块。它包含较多历史，首次递归 clone 可能明显大于当前源码。交接不重写历史、不清理既有 Git 对象。

## Mac Python 环境

在仓库根目录使用 Python 3.12。推荐沿用 LitIsLand 名称：

```bash
conda env create -f environment.yml
conda activate LitIsLand
```

无 Conda 时：

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

已有 Conda 环境同样运行 `python -m pip install -r requirements.txt`。所有安装命令从根目录执行；两个包使用 editable 安装，代码编辑后无需重复安装。`requirements/constraints-python312.txt` 记录这次 Linux/Python 3.12 的运行依赖解析版本，是兼容约束参考，不是完整跨平台锁文件；macOS 的原生轮子仍需本机解析和验证。

基础安装不包含 GPU 库。需要 CUDA/Transformers 的服务器任务，按实际 GPU 与驱动单独安装根项目 `[gpu]` extra；默认 NuExtract 后端还要求 vLLM，须按其与驱动/PyTorch 的匹配关系单独验证。本次未下载权重、安装或验证 GPU 栈。Mac 的统一内存不等同于 CUDA 支持，不将既有 vLLM 路径直接标为 MPS 可用。

服务器还保留了另一套基础环境 `/opt/conda`：Python 3.10.14、torch 2.8.0+cu128、transformers 4.56.2、vLLM 0.10.2、accelerate 1.10.1、sentencepiece 0.2.1、safetensors 0.6.2。以上只是已安装包的元数据快照，本次没有改动这套推理环境。2026-10-18 的 `nvidia-smi` 返回 `No devices were found`，因此当前实例没有可见 GPU，不能把包已安装当作 GPU 任务可运行的证明。完整的名称/版本清单随私有迁移包保存。

## 配置与产品 Runtime

### Apple Silicon 本地正文清洗（2026-11-10 实测）

M3 Ultra / 96 GB 已使用作者提供的 `models/weights/Qwen_14B` 原始 BF16 权重完成单书全文清洗。配置为 `Qwen2ForCausalLM`，不根据目录名推定 Hugging Face 仓库。每次运行在 `identity.json` 固定全部权重、分词器、规则和源 TXT 的 SHA-256。

本机后端为 vLLM Metal 0.33.0、vLLM 0.33.0+cpu、MLX 0.32.4、Torch 2.14.0；引擎实际使用 MLX GPU 与 MPS，`+cpu` 是 vLLM 安装包标识，不表示本次推理使用 CPU。依赖快照在 `requirements/local-clean-metal.lock.txt`，仅用于 macOS ARM64 / Python 3.12 独立环境，不加入基础或 DSH 依赖。未应用上游可选的 nightly Torch 性能补丁。

```bash
# 在独立 LitIsLand 推理环境安装；不要覆盖 DSH 或基础 Python 环境。
python -m pip install -r requirements/local-clean-metal.lock.txt

# 指定独立环境的 vllm 可执行文件和已有权重目录。
sh scripts/run_local_clean_metal.sh /absolute/inference/bin/vllm /absolute/Qwen_14B

# 另一个终端，在仓库根目录运行；只允许 localhost 模型服务。
python -m scripts.clean_local_book \
  --source /absolute/book.txt \
  --model-dir /absolute/Qwen_14B \
  --output /absolute/new-run \
  --prefix 100
```

启动器仅监听 `127.0.0.1:18080`，关闭使用统计，使用 8K 上下文、最多 4 个序列、0.55 内存比例，并指定 `GLOO_SOCKET_IFNAME=lo0` 避免本机名称解析等待。完成后用 Ctrl-C 停止前台服务释放内存。

清洗产物是待复核副本，原 TXT 不写入。输出包含全文、章节 JSON 集合、前缀导入包、标准化/规则/模型差异和逐批响应；异常响应停止发布。相同目录可续跑；规则修复后使用新目录及 `--replay-from /absolute/previous-run`，校验来源、权重和每份请求后离线复用响应。编号异常、源文件缺章和正文夹杂广告仍需复核，不把模型判断当作事实认证。

`scripts/import_clean_prefix.mjs` 专用于本次前 100 章实验：通过 LG 原生接口创建草稿书，标记空章，验证统计和章节文件同步。调用方式为 `node scripts/import_clean_prefix.mjs /absolute/dsh-plugins /absolute/run/prefix.json /absolute/new-book`。只接受新的或本脚本已登记的同一导入目录；不覆盖已有正文。导入本身不调用模型。书架中添加该新书目录后即可查看；本次已验证应用退出、重启后书架与正文仍可读取。

新 clone 后可执行：

```bash
cp .vscode/settings.example.json .vscode/settings.json
python -m lg_cli --help
python -m scripts.validate_data_layout --help
```

填写当前机器的 Python 路径。服务器原有 `.vscode/settings.json` 保留，更新代码时不要覆盖它。该文件已从共享跟踪中移出；示例中的 Runtime 和作品路径默认留空。

Linux 正式 Runtime 为 `codex-cli 0.154.0`，对应 pin `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`，使用经过核验的绝对 `runtime.json` 路径。安装器 `LiteraryAgent/scripts/install_codex_runtime.py` 当前仅支持 Linux x86_64，且需要本地相应 Git tag；不能在 Mac 照搬此命令，也不能用本机任意 `codex` 替代产品 Runtime。Core 更新、安装及派生产物登记见子仓库构建说明。

Mac 可以开发与运行不依赖 Linux Runtime 的单元测试、Native 模块和扩展构建。实际模型连接仍需用户配置 API；Codex Runtime 集成和服务器任务在 Linux 上执行。若要在 Mac 本机运行固定 Codex 适配器，应作为后续独立兼容任务实现与验证 ARM64 安装、manifest 和生命周期，本次没有声明完成。

VS Code 扩展的 `extensionKind=workspace`：在本地窗口中后端运行于 Mac；在 Remote SSH 窗口中后端运行于远端。它不是可任意填写服务器 URL 的网络客户端。远端使用时，先把本地提交通过 Git 同步到服务器，在远端构建/安装扩展或启用扩展开发宿主，再配置远端 Python 与 manifest。不要把服务器绝对路径填入 Mac 本地窗口。

密钥在每台机器通过产品配置入口或环境变量重新提供；不从服务器复制认证缓存，不在 shell 命令、文档和历史中填写真实值。产品 API-only 与本地开发工具 Codex 的登录方式是不同边界。

## 最快检查与完整检查

父仓库测试从根目录执行：

```bash
python -m unittest discover -s tests -v
```

产品测试从 `LiteraryAgent` 执行，必须保留 `-t .`：

```bash
python -m unittest discover -s tests -t . -v
```

缺少固定 Runtime 时，一部分集成会跳过，报告必须注明，不能称为全量通过。Linux 完整检查需要显式设置 `LG_TEST_RUNTIME_MANIFEST`、`LG_TEST_CODEX_BINARY`；独立 app_server 检查还需要已验证的 `LG_TEST_APP_SERVER_BINARY`。后者是历史隔离构建产物，不能用 `codex` 冒充；本次私有说明记录取得方式。

Extension 从 `LiteraryAgent/lg-vscode` 执行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

Linux 真实后端集成另运行 `node --import tsx --test --test-concurrency=1 tests/*.integration.ts`，需要 `LG_TEST_PYTHON` 和 `LG_TEST_RUNTIME_MANIFEST`，并确保 Python 子进程能通过绝对 PYTHONPATH 导入对应源码。Node 20.18.1 / npm 10.8.2 是现有 Linux 验证版本。浏览器 UI/桌面安装验证另有前置条件；本次命令行构建不冒充桌面验收。

服务器先检查 `/sys/fs/cgroup/memory.max` 与 `memory.current`；本次实际为 2GiB 上限。重任务串行，Python 按模块分片；Linux Node 可通过既有 `scripts/run-guarded.py` 限制内存。测试临时目录设在 LitIsLand，避免再次把审计编译缓存留在镜像层。

## 发布代码到服务器

本地先验证并提交。修改子模块时，先推送子仓库分支，再提交/推送父仓库引用。远端代码更新前完成正在运行的任务，并在服务器检查两层工作树；有本地改动时先人工处理，不能强制覆盖。

```bash
git status --short --branch
git -C LiteraryAgent status --short --branch
git pull --ff-only origin main
git submodule update --init --recursive
conda activate LitIsLand
python -m pip install -r requirements.txt
python -m lg_cli --help
python -m scripts.validate_data_layout --help
```

确认命令成功后再启动实际任务。不要执行 `git clean`、`reset --hard` 或带删除选项的数据同步，也不要运行 `git submodule update --remote` 漂移产品版本。可用 `git -C LiteraryAgent push origin HEAD:literary-agent` 推送正式产品分支；若远端已前进，先审查合并，不强推。

## 私有迁移包的下载与恢复

在 Mac 上，使用你已经配置好的 SSH 地址替换下面的 `SERVER`；无需把地址或私钥写入仓库：

```bash
scp SERVER:/root/private_data/LiteraryGiant/handoff-private/20261018/private-migration.tar.gz ~/Downloads/
scp SERVER:/root/private_data/LiteraryGiant/handoff-private/20261018/SHA256SUMS ~/Downloads/
```

同目录也可单独下载 `MANIFEST.json`。在下载目录校验迁移包，并解压到新建空目录：

```bash
cd ~/Downloads
shasum -a 256 -c SHA256SUMS
mkdir LiteraryGiant-private-20261018
tar -xzf private-migration.tar.gz -C LiteraryGiant-private-20261018
```

先读包内 `RESTORE.txt` 与 `MANIFEST.json`。`workspace/` 中是原仓库的相对路径，可将选定作品复制到本地 clone 的对应位置；不要把整个包直接覆盖进去。数据库经过备份且不附 WAL/SHM；部分记录保留旧机器绝对路径，不自动改写数据库或合并作品。在本地以真实新路径打开已恢复作品，再核对正文、版本、候选、参考资料和历史。

`conversations/` 是可访问的项目可见消息导出。让本地 Codex 先读公开交接摘要，再按任务读取相关历史；不要把导出复制为 `~/.codex` 的认证/数据库，也不要假定它可以直接 `resume` 当前网页会话。原数据仍保留在服务器。
