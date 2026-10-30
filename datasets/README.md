# 数据快照

采集时间：2026-10-29；刊期窗口：2025-11 至 2026-10。来源为知网文献元数据和《国际中医中药杂志》公开官网元数据。

## enriched/

`全部文献详情.json.gz` 是 21,800 条记录的 UTF-8 JSON 数组：主目录 21,709、当时提前上线目录 18、月份未核验增刊 73。它与本次原交付文件逐字节一致，不是模型生成数据。

每条记录包含标题、作者、期刊、年份、期号、页码、DOI、来源链接、摘要、关键词、单位、基金、分类号、来源返回的英文信息，以及原始 Summary、正文摘录、缺失状态等字段。模型分析没有写回这些原始字段。

- `abstract` 为分类后的可用摘要。
- `summary_excerpt` 为原 Summary 明确标记的正文摘录，不作为摘要统计。
- `source_summary_raw` 保留原接口字段。
- `summary_kind` 区分摘要、正文摘录、占位符。
- `collection_scope` 为 `main`、`early`、`supplement`。
- `*_status` 区分有值、来源返回空、未返回、记录未匹配等情况。

原主目录有可用摘要 20,865 条、关键词 20,882 条；正文摘录 811 条、占位内容 33 条。基金和英文信息覆盖不足不等于论文不存在这些信息。配套 CSV 记录逐刊覆盖和字段缺失。

## catalogue/

保存主目录、提前上线目录、增刊、原始刊名及去重映射、67 刊采集计划、逐期覆盖状态。`官网补采/` 的 12 个逐期 JSON 保存官网公开目录。

这里的“完整”仅指采集计划期次存在目录记录，不保证出版社层面每篇都无遗漏。37 个暂无接口目录的计划期次保留在覆盖表中，不据此推断期刊未出版。2026-10 的官网目录中，18 条当时明确标注未来出版日的记录仍单列。

## ../data/corpus.json.gz

这是应用整理后的 21,709 条主目录。保守去重标记保留原记录，默认分析时排除同 DOI 且规范化标题相同的 23 条重复记录，得到 21,686 条。提前上线和增刊没有混入默认图表。

## 使用示例

```python
import gzip, json
from pathlib import Path
raw_path = Path('datasets/enriched/全部文献详情.json.gz')
with gzip.open(raw_path, 'rt', encoding='utf-8') as f:
    records = json.load(f)
main = [r for r in records if r['collection_scope'] == 'main']
print(len(records), len(main))  # 21800, 21709
```

`manifest.json` 提供本目录文件的 SHA-256 与记录范围；仓库根目录 `verify_datasets.py` 可离线校验哈希、记录数及整理前后主目录 ID 集合。
