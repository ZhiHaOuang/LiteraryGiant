# lg-tool-policy

通过 DSH 原生 `tools.restrict()` 缩小每个 Agent 的工具集合。默认关闭，不替换 agent loop、工具实现、权限或审批。开启后在 `agent/created` 时应用，早于首步工具集合捕获；插件停用与 Agent 释放时撤销。启用或修改配置后需新建会话或重新加载 Agent，不会立即改动已经运行的 Agent。

在专用任务 profile 或 Cordis 作用域内启用，明确列出已安装的全局工具名。例如文件读取与精确修改：

```yaml
- id: lg-tool-policy
  config:
    enabled: true
    allow: [edit]
```

这个例子与 OPS 配合：保留官方全局 `edit`，OPS 的局部文件工具继续可用；不要把 `ops_read_files` 等局部工具写入这个列表。不使用 OPS 时可明确配置 `[read, edit]`。空列表表示不保留全局工具；未知名称、仅在 Agent 内注册的名称和保留传输名由宿主拒绝。其他插件的限制取交集，当前 Agent 自己注册的局部工具遵循 DSH 规则，不受该全局工具掩码遮蔽。因此它是任务工具选择策略，不是文件访问或安全沙箱。

安装包仅增加默认关闭的行。根作用域启用会影响此 profile 中所有随后创建或重新加载的 Agent；通用会话不要直接套用文件任务列表。安装在 Agent 专用作用域时遵循原生事件路由。停用后恢复此前工具视图，不重放模型请求。

对小说正文的正式采用仍使用 lg-workbench / lg-books 的版本与作者确认流程。通用文件工具实验只在合成工作区运行。
