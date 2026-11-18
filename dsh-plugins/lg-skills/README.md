# 文学 Skills

在 DSH 会话里输入 `/lg-scene-planner` 加上具体场景，或用 `/lg-continuity-checker` 核对两处原文。15 种方法及其适用任务在 [catalog.json](catalog.json) 中。每项的 technique 是文学操作方法，session 说明 DSH 会话中可用的工具及交接入口。

作者可显式调用全部方法。开启插件设置 `modelDiscovery` 后，DSH 会将简短目录提供给模型，模型可通过原生 skill 工具加载正文。默认关闭自动发现，普通任务仅在作者调用时获得文学技能正文。

文学编辑台在支持的任务中提供可选方法。专家使用所选方法的 technique，完整输入、费用和签名随选择更新。选用方法的局部修订使用正文起止行保存替换文本，作者可以对照原文检查变更。由原生会话分派时，可在 literary_propose_task 的 input.method 中传入同一名称。此字段引用 LG 安装包内的文学方法。DSH 的斜杠调用则服从宿主对同名技能的作用域和优先级。

这些方法对应旧项目 LiteraryAgent/lg-skills 的 15 项能力，采用 LG 当前的 DSH 工具和作者确认流程。运行时资源全部随此包安装。
