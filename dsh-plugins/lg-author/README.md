# lg-author

作者称呼、回复详略与写作偏好；个人默认跨当前 DSH profile 的作品共用，本书可单独覆盖写作偏好。空字符串是明确的空偏好，恢复继承则保存没有 writing 字段的本书设置。

个人数据位于 profile 的 `lg-author.sqlite3`，本书数据复用作品 SQLite；保存需要前置预览、版本比较和幂等操作记录。历史可分页查看。未写入新存储时，兼容读取旧个人 `~/.config/literarygiant/preferences.json`（尊重 XDG_CONFIG_HOME，可配置 legacyPersonalPath）和本书 `.literarygiant/preferences.json`。仅读取允许字段，限制文件与字段大小，不跟随文件或其父目录的符号链接；新保存不修改旧文件。

默认空偏好不增加模型输入或改变任务签名。新版 lg-agents 在唯一公共准备入口装配生效偏好，完整输入、调用签名和费用包含这些文字。写作偏好用于创作及审阅任务，记忆提取和资料分析不接收写作偏好。称呼和详略只作用于允许的作者说明，不改变小说事实、输出契约或作者授权。单次任务要求优先。偏好改变使旧预览失效；既有候选不会自动作废，生成时使用的偏好仍可从任务记录和候选元数据查看。

Cordis 服务 `literaryAuthor`，作者接口 `/api/lg/author` 提供 read/preview/apply/history。无模型写工具；不根据作者采纳/拒绝自动猜测偏好。模型选择继续复用 DSH 模型设置和 lg-execution，不存储凭据。
