#!/usr/bin/env python3
"""Fetch CNKI journal issue catalogues without the desktop app or personal login.

Python 3.10+; standard library only. Only bibliographic metadata is requested.
See README.md for scope, pagination checks and reproducible examples.
"""
import argparse
import csv
import datetime as dt
import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://api2.cnki.net/v20/api/db/"
APP_ID = "cnki_cajcloud"
# Application constant in the public official frontend, not a user's credential.
APP_KEY = "K55qhHX4fvoE7Rc3"
FIELDS = "Title,Creator,Source,SourceCode,Year,Issue,Date,PageRange,DOI,IsPublishAhead"
COLUMNS = ["journal", "journal_code", "year", "issue", "id", "title", "authors",
           "pages", "doi", "api_date", "cnki_url", "doi_url"]


def clean(value):
    return str(value or "").replace("###", "").replace("$$$", "").strip()


def flatten(row):
    result = {c["Name"]: clean(c.get("Value")) for c in row.get("Cells", [])}
    result["Id"] = clean(row.get("Id"))
    result["RecordType"] = clean(row.get("Type"))
    return result


def safe_name(name):
    return re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", name)


def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class Client:
    def __init__(self, delay=0.7):
        self.delay = delay
        self.last_request = 0.0
        self.log = []

    def query(self, database, fields, query, start=0, length=100, order=""):
        params = {"fields": fields, "query": query, "group": "", "order": order,
                  "start": start, "length": length}
        url = BASE + urllib.parse.quote(database, safe="") + "?" + urllib.parse.urlencode(params)
        if len(url) > 2000:
            raise RuntimeError("Query exceeds the official frontend's URL length limit")
        for attempt in range(3):
            time.sleep(max(0, self.last_request + self.delay - time.monotonic()))
            stamp = str(int(time.time() * 1000) / 1000)
            message = f"timestamp={stamp}&appid={APP_ID}&appkey={APP_KEY}"
            headers = {"appid": APP_ID, "timestamp": stamp,
                       "appsign": hashlib.sha1(message.encode()).hexdigest(),
                       "User-Agent": "Mozilla/5.0", "Accept": "application/json"}
            self.last_request = time.monotonic()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
                    raw = response.read()
                break
            except urllib.error.HTTPError as error:
                # Do not retry login/access denials or interactive challenges.
                if error.code not in (500, 502, 503, 504) or attempt == 2:
                    raise
                time.sleep(attempt + 1)
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError) as error:
            raise RuntimeError("Non-JSON response; service may require verification") from error
        if data.get("ErrorCode") != 0:
            raise RuntimeError(f"API error {data.get('ErrorCode')}: {data.get('ErrorMessage')}")
        if data.get("Count") == 0 and data.get("Rows") is None:
            data["Rows"] = []
        if not isinstance(data.get("Rows"), list) or not isinstance(data.get("Count"), int):
            raise RuntimeError("Unexpected API response schema")
        self.log.append({"database": database, "params": params, "url": url,
                         "received_at": dt.datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                         "count": data["Count"], "returned_rows": len(data["Rows"]),
                         "response_sha256": hashlib.sha256(raw).hexdigest()})
        return data

    def all_rows(self, database, fields, query, order="", page_size=100):
        rows, count, offset = [], None, 0
        while True:
            data = self.query(database, fields, query, offset, page_size, order)
            if count is None:
                count = data["Count"]
            if count != data["Count"]:
                raise RuntimeError("Count changed during pagination; rerun for a consistent snapshot")
            page = [flatten(r) for r in data["Rows"]]
            if not page and offset < count:
                raise RuntimeError(f"Empty page before Count: offset={offset}, Count={count}")
            rows.extend(page)
            offset += len(page)
            if offset >= count:
                break
        if len(rows) != count:
            raise RuntimeError(f"Row count mismatch: {len(rows)} != {count}")
        return rows


def resolve(client, journal):
    name, code = journal["name"], journal.get("code", "")
    if code and not re.fullmatch(r"[A-Za-z0-9_-]+", code):
        raise ValueError(f"Invalid journal code: {code!r}")
    query = f"Id eq {code}" if code else "Title eq '" + name.replace("'", "''") + "'"
    candidates = client.all_rows("JournalInfo", "Title,ISSN,CN,Id,Type,Period", query)
    exact = [r for r in candidates if r.get("Title") == name]
    if len(exact) != 1:
        raise RuntimeError(f"Expected exactly one match for {name!r}; candidates: {candidates}")
    return exact[0]


def write_csv(path, rows, fields):
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def page_key(pages):
    match = re.search(r"\d+", pages)
    return int(match[0]) if match else 10**9


def period_key(issue):
    return int(issue["Year"]), clean(issue.get("YearIssue") or issue.get("Issue"))


def collect(client, journal, args, root):
    info = resolve(client, journal)
    code = info["Id"].upper()
    folder = root / (safe_name(info["Title"]) + "_" + code)
    folder.mkdir(parents=True, exist_ok=True)
    issues = client.all_rows("JournalYearInfo", "Id,Issue,Year,YearId,YearIssue,JournalDbCodes",
                             f"Id eq {code}", "Year desc,YearIssue desc", 128)
    # Use returned issue identities rather than assuming 12 issues per year.
    issues.sort(key=period_key, reverse=True)
    lower = journal.get("from_year_issue", args.from_year_issue)
    upper = journal.get("to_year_issue", args.to_year_issue)
    if lower:
        issues = [i for i in issues if i.get("YearIssue", "") >= lower]
    if upper:
        issues = [i for i in issues if i.get("YearIssue", "") <= upper]
    if not lower and not upper:
        issues = issues[:journal.get("last_issues", args.last_issues)]
    if not issues:
        raise RuntimeError(f"No published issues selected for {info['Title']}")
    all_articles, issue_summary, seen = [], [], set()
    for issue in issues:
        year, number = issue["Year"], issue["Issue"]
        if not year.isdigit() or not re.fullmatch(r"[A-Za-z0-9_-]+", number):
            raise RuntimeError(f"Unsupported issue identifier; inspect manually: {issue}")
        query = f"SourceCode eq {code} and Year eq {year} and Issue eq {number}"
        entries = client.all_rows("CJFD", FIELDS, query)
        if len({r["Id"] for r in entries}) != len(entries):
            raise RuntimeError(f"Duplicate IDs within {year}/{number}; pagination may be unstable")
        articles = []
        for record in entries:
            if record.get("Year") != year or record.get("Issue") != number:
                raise RuntimeError(f"Response escaped selected issue: {record['Id']}")
            if record["Id"] in seen:
                raise RuntimeError(f"Duplicate article across issues: {record['Id']}")
            seen.add(record["Id"])
            doi = record.get("DOI", "")
            articles.append({"journal": info["Title"], "journal_code": code,
                             "year": year, "issue": number, "id": record["Id"],
                             "title": record.get("Title", ""), "authors": record.get("Creator", ""),
                             "pages": record.get("PageRange", ""), "doi": doi,
                             "api_date": record.get("Date", ""),
                             "cnki_url": "https://kns.cnki.net/kcms2/article/abstract?" + urllib.parse.urlencode({"dbcode": "CJFD", "filename": record["Id"]}),
                             "doi_url": "https://doi.org/" + urllib.parse.quote(doi, safe="/") if doi else ""})
        articles.sort(key=lambda a: (page_key(a["pages"]), a["id"]))
        payload = {"journal": info, "issue": issue, "api_count": len(entries),
                   "fetched_rows": len(articles), "articles": articles}
        dump(folder / "issues" / f"{year}-{number}.json", payload)
        all_articles.extend(articles)
        issue_summary.append({"year": year, "issue": number, "year_issue": issue.get("YearIssue"),
                              "count": len(articles), "pagination_verified": True})
        print(f"{info['Title']} {year}/{number}: {len(articles)}", flush=True)
    result = {"journal": info, "selection": {"from_year_issue": lower, "to_year_issue": upper,
              "last_issues": None if lower or upper else journal.get("last_issues", args.last_issues)},
              "fetched_at": dt.datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
              "issue_count": len(issues), "article_count": len(all_articles),
              "scope": "CNKI API indexed records in selected published issues; independent publisher completeness not established",
              "issues": issue_summary, "articles": all_articles}
    dump(folder / "catalog.json", result)
    write_csv(folder / "catalog.csv", all_articles, COLUMNS)
    write_csv(folder / "issues.csv", issue_summary,
              ["year", "issue", "year_issue", "count", "pagination_verified"])
    write_html(folder / "catalog.html", result)
    return result


def write_html(path, result):
    esc = lambda x: html.escape(str(x or ""), quote=True)
    sections = []
    for issue in result["issues"]:
        rows = [r for r in result["articles"] if r["year"] == issue["year"] and r["issue"] == issue["issue"]]
        items = []
        for article in rows:
            link = article["doi_url"] or article["cnki_url"]
            items.append(f'<article data-search="{esc(article["title"] + article["authors"] + article["doi"])}"><div class="pages">{esc(article["pages"])}</div><div><a href="{esc(link)}" target="_blank" rel="noopener">{esc(article["title"])}</a><p>{esc(article["authors"])}</p><small>{esc(article["doi"])}</small></div></article>')
        sections.append(f'<section><h2>{esc(issue["year"])} 年 · 第 {esc(issue["issue"])} 期 <small>{issue["count"]} 条</small></h2>{"".join(items)}</section>')
    title = esc(result["journal"]["Title"])
    path.write_text(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · 论文目录</title>
<style>body{{margin:0;background:#f5f3ee;color:#18302f;font-family:system-ui,-apple-system,sans-serif}}main{{max-width:1080px;margin:auto;padding:48px 28px}}.eyebrow{{letter-spacing:3px;color:#6a7872;font-size:12px}}h1{{font-family:serif;font-size:38px;margin:16px 0}}.stats{{display:flex;gap:30px;margin:28px 0}}.stats b{{font-size:28px}}.hint,p,small{{color:#61726b}}input{{box-sizing:border-box;width:100%;padding:14px;border:1px solid #c9d1c9;border-radius:7px;background:white;font-size:16px}}section{{background:#fff;margin:24px 0;padding:24px;border:1px solid #e2e5dd;border-radius:8px}}h2{{margin:0 0 15px;font-size:21px}}h2 small{{font-size:13px;font-weight:400;margin-left:10px}}article{{display:grid;grid-template-columns:74px 1fr;gap:14px;padding:17px 0;border-top:1px solid #edf0e9}}a{{color:#135d55;text-decoration:none;line-height:1.7}}a:hover{{text-decoration:underline}}.pages{{color:#87938a;font-size:13px;padding-top:5px}}p{{font-size:13px;margin:7px 0}}small{{font-size:12px}}[hidden]{{display:none!important}}footer{{font-size:12px;line-height:1.8}}</style>
<main><div class="eyebrow">JOURNAL CATALOGUE · CNKI</div><h1>{title}</h1><div class="hint">正式刊期目录 · 期刊代码 {esc(result['journal']['Id'])} · 离线可浏览</div><div class="stats"><div><b>{result['issue_count']}</b> 期</div><div><b>{result['article_count']}</b> 条目录记录</div></div><input id="search" type="search" placeholder="检索标题、作者或 DOI" aria-label="检索目录">{''.join(sections)}<footer>数据抓取：{esc(result['fetched_at'])}。按刊期选择，避免网络首发日期造成遗漏。记录数量已与 API Count 核对；不代表已与出版社独立核实完整性。论文链接需联网。</footer></main>
<script>document.querySelector('#search').addEventListener('input',e=>{{const q=e.target.value.toLowerCase();document.querySelectorAll('article').forEach(a=>a.hidden=!a.dataset.search.toLowerCase().includes(q));document.querySelectorAll('section').forEach(s=>s.hidden=![...s.querySelectorAll('article')].some(a=>!a.hidden));}});</script></html>''', encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journal", action="append", default=[], help="Exact journal name; repeat for multiple journals")
    parser.add_argument("--journals-file", type=Path, help="JSON list of names or {name, code, last_issues, from_year_issue, to_year_issue}")
    parser.add_argument("--last-issues", type=int, default=12, help="Default 12 available issues, not necessarily 12 months")
    parser.add_argument("--from-year-issue", help="Inclusive CNKI YearIssue lower bound, e.g. 202511")
    parser.add_argument("--to-year-issue", help="Inclusive CNKI YearIssue upper bound, e.g. 202610")
    parser.add_argument("--output", type=Path, default=Path("catalog-output"))
    parser.add_argument("--delay", type=float, default=0.7, help="Minimum seconds between requests")
    args = parser.parse_args()
    if args.last_issues < 1 or args.delay < 0:
        parser.error("--last-issues must be positive and --delay must be nonnegative")
    for bound in [args.from_year_issue, args.to_year_issue]:
        if bound and not re.fullmatch(r"\d{6}", bound):
            parser.error("YearIssue bounds must contain six digits")
    if args.from_year_issue and args.to_year_issue and args.from_year_issue > args.to_year_issue:
        parser.error("YearIssue lower bound exceeds upper bound")
    journals = [{"name": name} for name in args.journal]
    if args.journals_file:
        supplied = json.loads(args.journals_file.read_text(encoding="utf-8-sig"))
        if not isinstance(supplied, list):
            parser.error("--journals-file must contain a JSON list")
        journals.extend({"name": j} if isinstance(j, str) else j for j in supplied)
    if not journals:
        parser.error("Provide --journal or --journals-file")
    if any(not isinstance(j, dict) or not isinstance(j.get('name'), str) or not j['name'] for j in journals):
        parser.error("Each journal must provide a nonempty name")
    if len({j['name'] for j in journals}) != len(journals):
        parser.error("Duplicate journal names")
    args.output.mkdir(parents=True, exist_ok=True)
    client, results, failures = Client(max(0.2, args.delay)), [], []
    for journal in journals:
        try:
            results.append(collect(client, journal, args, args.output))
        except Exception as error:
            failures.append({"journal": journal, "error": str(error)})
            print(f"ERROR {journal.get('name')}: {error}", file=sys.stderr)
    write_csv(args.output / "all_journals.csv", [a for r in results for a in r["articles"]], COLUMNS)
    dump(args.output / "request_log.json", client.log)
    dump(args.output / "run_summary.json", {"successful_journals": len(results), "failed_journals": failures,
         "issue_count": sum(r['issue_count'] for r in results),
         "article_count": sum(r['article_count'] for r in results)})
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
