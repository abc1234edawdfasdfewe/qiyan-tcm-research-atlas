# 采集与组装脚本

Python 3.10+，标准库即可。命令均在仓库根目录执行。上传仓库不重新联网采集，也不改变已固定的数据快照。

## 目录采集

```bash
python3 collectors/catalogue/batch_collect.py \
  --plan datasets/catalogue/采集计划.json \
  --output datasets/catalogue/数据

python3 collectors/catalogue/assemble_results.py --root datasets/catalogue
```

`batch_collect.py` 使用已保存计划中的刊名、代码、出版周期及期号范围，逐页校验行数与 ID。默认复用检查点；需要主动重新请求源服务时使用 `--refresh`。`assemble_results.py` 合并知网与已保存的官网目录，并区分主目录、提前上线及增刊。

官网目录复采依赖 Ego Lite，先阅读它的本机指南：

```bash
ego-browser skill
# 将路径改为实际仓库绝对路径；必须以模块导入，不能按 stdin 执行
ego-browser nodejs -e 'await import("file:///absolute/repo/collectors/catalogue/yiigle_collect.mjs")'
python3 collectors/catalogue/assemble_results.py --root datasets/catalogue
```

该脚本以公开 DOM 提取逐期目录，目标目录由模块路径计算。无需导出登录 Cookie 或个人 token。

## 摘要与关键词

```bash
python3 collectors/enrichment/enrich_cnki.py \
  --catalog-root datasets/catalogue --output datasets/enriched

python3 collectors/enrichment/enrich_publisher.py \
  --catalog-root datasets/catalogue --output datasets/enriched

python3 collectors/enrichment/build_results.py --root datasets/enriched
```

前两步生成检查点和中间结果，第三步才生成最终规范化语料。`cnki_client.py` 与 `cnki_catalog.py` 中的 `APP_KEY` 是原官方公开前端的应用常量，不是本次用户的模型密钥或个人登录凭据。来源接口可能变化，失败会明确记录，不用 AI 补写字段。

原 Summary 的 `<正>` 正文摘录和占位符会分类保留，避免冒充摘要。官网解析只取公开 JATS `front/article-meta` 中选定元数据，不解析文章正文。

## 重建工作台

```bash
python3 build.py \
  --corpus datasets/enriched/全部文献详情.json.gz \
  --catalogue datasets/catalogue
```

当前计划和月份映射针对本次近一年快照。扩展期刊、年份或月份时，需同步调整采集计划、构建器的月份范围及质量元数据。
