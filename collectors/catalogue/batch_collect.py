#!/usr/bin/env python3
"""Replay the verified CNKI batch plan; no desktop client or login required.

Usage: python3 batch_collect.py --plan 采集计划.json --output 数据
Completed journal checkpoints are reused unless --refresh is supplied.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo
import cnki_catalog as c

EXTRA_COLUMNS = c.COLUMNS + ["period_scope", "in_issue_index"]


def issue_number(value):
    value = c.clean(value)
    return str(int(value)).zfill(2) if value.isdigit() else value.upper()


def encode_article(record, info, scope, in_index):
    doi = record.get("DOI", "")
    return {"journal": info["Title"], "journal_code": info["Id"],
            "year": record["Year"], "issue": issue_number(record["Issue"]), "id": record["Id"],
            "title": record.get("Title", ""), "authors": record.get("Creator", ""),
            "pages": record.get("PageRange", ""), "doi": doi, "api_date": record.get("Date", ""),
            "cnki_url": "https://kns.cnki.net/kcms2/article/abstract?" + c.urllib.parse.urlencode({"dbcode": "CJFD", "filename": record["Id"]}),
            "doi_url": "https://doi.org/" + c.urllib.parse.quote(doi, safe="/") if doi else "",
            "period_scope": scope, "in_issue_index": in_index}


def fetch_range(client, folder, query, refresh):
    key = hashlib.sha256(query.encode()).hexdigest()[:16]
    rows, expected, start = [], None, 0
    pages = folder / "pages" / key
    pages.mkdir(parents=True, exist_ok=True)
    while True:
        path = pages / f"{start:07d}.json"
        if path.exists() and not refresh:
            data = json.loads(path.read_text())
            if data["query"] != query or data["start"] != start:
                raise RuntimeError("Invalid cached page identity")
        else:
            response = client.query("CJFD", c.FIELDS, query, start, 100, "Date desc")
            data = {"query": query, "start": start, "count": response["Count"],
                    "rows": [c.flatten(r) for r in response["Rows"]],
                    "received_at": dt.datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                    "request": client.log[-1]}
            c.dump(path, data)
        if expected is None:
            expected = data["count"]
        if expected != data["count"]:
            raise RuntimeError("Count changed between pages; rerun with --refresh")
        if not data["rows"] and start < expected:
            raise RuntimeError("Empty page before Count")
        rows.extend(data["rows"])
        start += len(data["rows"])
        if start >= expected:
            break
    if len(rows) != expected:
        raise RuntimeError("Pagination count mismatch; rerun with --refresh")
    return rows, expected


def collect_one(client, item, root, refresh):
    info = item["info"]
    folder = root / (c.safe_name(info["Title"]) + "_" + info["Id"])
    folder.mkdir(parents=True, exist_ok=True)
    plan_hash = hashlib.sha256(json.dumps(item, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    done = folder / "catalog.json"
    if done.exists() and not refresh:
        saved = json.loads(done.read_text())
        if saved.get("plan_hash") == plan_hash:
            return saved
    raw, total = fetch_range(client, folder, item["query"], refresh)
    expected = {(x["Year"], issue_number(x["Issue"])) for x in item["expected_issues"]}
    index_keys = {(x["Year"], issue_number(x["Issue"])) for x in item["indexed_issues"]}
    source_duplicates = []
    if len({r['Id'] for r in raw}) != len(raw):
        # Distinguish a duplicate source record from unstable cross-page order.
        # Re-query EVERY issue; a repeated ID is accepted only when the complete
        # affected issue fits on one page and bibliographic fields agree.
        verified, raw_total = [], 0
        for year, number in sorted(expected):
            query = f"SourceCode eq {info['Id']} and Year eq {year} and Issue eq {number}"
            individual, count = fetch_range(client, folder, query, refresh)
            raw_total += count
            by_id = {}
            for row in individual:
                prior = by_id.get(row['Id'])
                if prior:
                    if count > 100 or any(row.get(k) != prior.get(k) for k in ['Title','Creator','Year','Issue','PageRange','DOI']):
                        raise RuntimeError('Unverified duplicate or conflicting metadata')
                    source_duplicates.append({'id':row['Id'],'year':year,'issue':number,'confirmation':'duplicate inside complete single-page issue response'})
                else:
                    by_id[row['Id']] = row
            verified.extend(by_id.values())
        if raw_total != total:
            raise RuntimeError('Per-issue raw Count differs from journal-range Count')
        raw = verified
    if len({r['Id'] for r in raw}) != len(raw):
        raise RuntimeError('Unresolved duplicate IDs')
    groups = collections.defaultdict(list)
    for record in raw:
        key = record.get("Year"), issue_number(record.get("Issue"))
        if key not in expected:
            raise RuntimeError(f"Response escaped time window: {record['Id']} {key}")
        groups[key].append(encode_article(record, info, "regular_window", key in index_keys))
    articles, issues = [], []
    for year, number in sorted(expected, reverse=True):
        rows = sorted(groups[(year, number)], key=lambda r: (c.page_key(r["pages"]), r["id"]))
        in_index = (year, number) in index_keys
        state = "ok" if rows else "no_records_in_api"
        if rows and not in_index:
            state = "recovered_missing_index"
        issue = {"year": year, "issue": number, "year_issue": year + number, "count": len(rows),
                 "in_issue_index": in_index, "status": state,
                 "pagination_verified": True, "count_verification": "journal-range-total-and-unique-ids"}
        c.dump(folder / "issues" / f"{year}-{number}.json", {"journal": info, "issue": issue, "articles": rows})
        issues.append(issue)
        articles.extend(rows)
    # Supplements have no reliable month in JournalYearInfo. Keep them separate.
    supplements = []
    for special in item["supplements"]:
        year, number = special["Year"], special["Issue"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", number):
            raise RuntimeError(f"Unsupported supplement issue {number!r}")
        query = f"SourceCode eq {info['Id']} and Year eq {year} and Issue eq {number}"
        special_raw, special_count = fetch_range(client, folder, query, refresh)
        for r in special_raw:
            if r.get("Year") != year or issue_number(r.get("Issue")) != issue_number(number):
                raise RuntimeError("Supplement response escaped selected issue")
        entries = [encode_article(r, info, "supplement_month_unverified", True) for r in special_raw]
        entries.sort(key=lambda r: (c.page_key(r["pages"]), r["id"]))
        c.dump(folder / "supplements" / f"{year}-{number}.json", {"issue": special, "api_count": special_count, "articles": entries})
        supplements.extend(entries)
    if len(articles) + len(source_duplicates) != total:
        raise RuntimeError("Grouped article count differs from API Count")
    result = {"journal": info, "plan_hash": plan_hash, "selection": item["selection"],
              "fetched_at": dt.datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
              "api_count": total, "article_count": len(articles), "source_duplicates": source_duplicates,
              "issue_count": sum(bool(i["count"]) for i in issues), "expected_issue_count": len(issues),
              "issues": issues, "articles": articles, "supplement_articles": supplements,
              "scope": "Regular issue months approximated from the verified publication cycle, 2025-11 through 2026-10; supplements separate; API coverage only"}
    c.dump(done, result)
    c.write_csv(folder / "catalog.csv", articles, EXTRA_COLUMNS)
    c.write_csv(folder / "issues.csv", issues, ["year", "issue", "year_issue", "count", "in_issue_index", "status", "count_verification"])
    c.write_csv(folder / "supplements.csv", supplements, EXTRA_COLUMNS)
    c.write_html(folder / "catalog.html", result)
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", type=Path, default=Path("采集计划.json"))
    ap.add_argument("--output", type=Path, default=Path("数据"))
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--delay", type=float, default=.7)
    args = ap.parse_args()
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    client, results, errors = c.Client(max(.7, args.delay)), [], []
    for index, item in enumerate(plan["journals"], 1):
        try:
            result = collect_one(client, item, args.output, args.refresh)
            results.append(result)
            print(f"[{index}/{len(plan['journals'])}] {item['info']['Title']}: {result['issue_count']}/{result['expected_issue_count']} issues, {result['article_count']} records", flush=True)
        except Exception as e:
            errors.append({"journal": item["info"], "error": str(e)})
            print(f"ERROR [{index}] {item['info']['Title']}: {e}", flush=True)
        c.dump(args.output / "run_progress.json", {"completed": index, "total": len(plan["journals"]),
               "successful": len(results), "failed": errors,
               "records": sum(r["article_count"] for r in results)})
        c.dump(args.output / "request_log.json", client.log)
    articles = [a for r in results for a in r["articles"]]
    supplements = [a for r in results for a in r["supplement_articles"]]
    c.write_csv(args.output / "all_journals.csv", articles, EXTRA_COLUMNS)
    c.write_csv(args.output / "supplements_month_unverified.csv", supplements, EXTRA_COLUMNS)
    summary = [{"journal": r["journal"]["Title"], "code": r["journal"]["Id"], "frequency": r["journal"].get("Type"),
                "expected_issues": r["expected_issue_count"], "issues_with_records": r["issue_count"],
                "records": r["article_count"], "missing_issues": ";".join(i["year_issue"] for i in r["issues"] if not i["count"]),
                "recovered_issues": ";".join(i["year_issue"] for i in r["issues"] if i["status"] == "recovered_missing_index"),
                "supplement_records": len(r["supplement_articles"])} for r in results]
    c.write_csv(args.output / "journal_summary.csv", summary, list(summary[0]) if summary else ["journal"])
    c.dump(args.output / "run_summary.json", {"successful_journals": len(results), "failed_journals": errors,
           "record_count": len(articles), "unique_ids": len({r['id'] for r in articles}),
           "issues_with_records": sum(r['issue_count'] for r in results),
           "expected_issues": sum(r['expected_issue_count'] for r in results),
           "supplement_records_separate": len(supplements), "journals": summary})
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
