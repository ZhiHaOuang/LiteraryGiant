# 智谱配置与首轮同模型实验 — 2026-10-22

已按作者批准的5元预算完成本机配置和首轮请求。一次隐藏密钥输入保存两个profile，默认GLM-4.5-Air／Native；GLM-4.6V使用智谱Responses。密钥只在本机LG凭据库，未写入项目、日志或Git，服务器需单独配置。

| 型号 | LG可读候选／尝试 | 简化基线可读候选／尝试 | 当前边界 |
| --- | --- | --- | --- |
| GLM-4.5-Air | 4／4 | 4／4 | 可运行受控阶段，文学质量仍需作者判断 |
| GLM-4.6V | 0／4 | 4／4 | 四次LG结果被Schema拒绝，尚未验收受控R5 |

16次对照加3次探测，共19次调用，报告输入19,300／输出21,405 token。按可见用量及官方目录价估算0.097211元，约0.10元；缓存优惠、赠送包实际抵扣和现金实扣均未核实。保守预留1.9966408元，低于5元，不等于账单花费。[官方价格](https://docs.bigmodel.cn/cn/guide/start/pricing)

Air两次LG润色选区外保持，基线一次改变引号；两组章节均有方向或因果问题。4.6V不能因简单JSON探测成功就视为完整输出契约可靠。没有文学质量优越、统计显著或长期一致性结论。

本轮额外配置操作为型号澄清一次、密钥输入一次；生成阶段追加作者选择／澄清为零。作者盲评、手工修改字数、返修轮次与耗时仍待实际审读，不填写成零成本。开发Agent已做非盲初读，不能代替作者。

完整调用链、数据、失败、费用口径与验证见[产品实验记录](../LiteraryAgent/docs/evaluations/zhipu-first-round-20261022.md)和[脱敏结果JSON](../LiteraryAgent/docs/evaluations/zhipu-first-round-20261022.json)。本机原始证据在`/Users/zh/.codex/reports/LiteraryGiant-quality-20261022/`，其中`report.md`是阅读入口、`review/blind-review.md`是匿名材料、`review/author-review.csv`是待填写的作者干预与评分表。

真实模型请求直接进入R5领域服务和Native阶段；没有覆盖真实模型下Extension UI、Backend作者交互、完整工具循环、正式采用或长期恢复。正式作品没有读取或改动，合成作品初始active正文保持不变。

当前配置已经完成，无需再次输入Key。日常显式切换可用：

```sh
literary auth use zhipu-air
literary auth use zhipu-vision
```

这两条是互斥的手动切换示例，不必依次执行；默认已是Air。4.6V完整受控任务应先补契约兼容验证。初次配置或新机器操作见产品记录中的`configure_zhipu.py`，已有同名profile会拒绝覆盖。新模型实验需要新的明确样本与预算，不自动扩大本轮规模。


## 后续：原LG与轻量LG的固定源码对照

作者另行批准本轮5元；现有配置直接复用，额外密钥输入为零。两型号各P1／P2、before／after共8次真实请求，无探测、重试、付费裁判或正式采用。Air输入8534→3956 token，目录价估算0.0129712→0.0080068元；两组均2／2结构化候选且选区外逐字保持。Vision两组均0／2，尚未验收受控R5。

全部8次输入18208／输出6261 token，目录价估算0.039986元，失败保留预留后总占用1.176516元，低于5元；现金、缓存和赠送包扣减仍未知。官方价格于2026-10-22重新核对。轻量P1有违反“不写抒情比喻”的明确反例，作者质量评分与返修量／时间待评，不能宣布文学质量改善。

[本批交付与版本](delivery-20261022.md)、[完整实验说明](../LiteraryAgent/docs/evaluations/zhipu-first-round-20261022.md)、[逐请求结果](../LiteraryAgent/docs/evaluations/polish-simplification-20261022.json)。本机新证据在`/Users/zh/.codex/reports/LiteraryGiant-simplify-20261022/`，匿名材料为`model-run/blind-review.md`，作者表为`model-run/author-review.csv`。原首轮19次记录保留，各批不混用样本或预算。
