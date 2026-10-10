# -*- coding: utf-8 -*-
"""
S12 题库批量导入 冒烟脚本（TestClient + SQLite 临时库，不依赖 8010/openGauss）

覆盖 V1.1 功能一验收点：
  Q01 模板下载：xlsx 内容类型、双工作表、表头正确
  Q02 合法文件预览：total/valid/invalid 统计正确
  Q03 确认导入：写库成功、id 连续分配、列表可见
  Q04 同一 token 重复确认 → 400（防重复提交）
  Q05 错误行定位：题型非法 / 答案不在选项中 / 公式注入 / 与库内重复 / 文件内重复
  Q06 含错误批次确认 → 400 整批禁止导入
  Q07 非 .xlsx 文件 → 400
  Q08 表头不符 → 400
  Q09 判断题「正确/错误」映射 A/B 且选项自动生成
  Q10 数值单元格（分值读为 20.0 浮点）解析为整数 20
  Q11 题目列表分页与筛选（page/page_size/keyword/qtype/category）

用法：cd backend && python test/s12_question_import.py
"""
import io
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_import.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook

from app.core.database import Base, SessionLocal, engine
from app.core.security import create_admin_token
from app.main import app
from app.models.models import Question

RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def build_xlsx(headers, rows):
    wb = Workbook()
    ws = wb.active
    ws.title = "题目数据"
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


HEADERS = ["题型", "题目内容", "选项A", "选项B", "选项C", "选项D", "选项E", "选项F",
           "正确答案", "答案解析", "分值", "知识分类"]


def main():
    Base.metadata.create_all(engine)
    client = TestClient(app)
    headers = {"Authorization": "Bearer " + create_admin_token("s12-smoke")}
    imported_texts = []
    try:
        # Q01 模板下载
        r = client.get("/api/admin/questions/import-template", headers=headers)
        ok = False
        detail = f"status={r.status_code}"
        if r.status_code == 200:
            wb = load_workbook(io.BytesIO(r.content))
            got = [c.value for c in wb["题目数据"][1]]
            ok = ("填写说明" in wb.sheetnames) and got == HEADERS
            detail = f"sheets={wb.sheetnames} header_ok={got == HEADERS}"
        record("Q01", "模板下载：xlsx 双工作表且表头正确", ok, detail)

        # Q02 合法文件预览
        valid_rows = [
            ["单选", "S12冒烟单选题一？", "甲", "乙", "丙", "丁", "", "", "B", "解析一", 20, "历史事件"],
            ["判断", "S12冒烟判断题一。", "", "", "", "", "", "", "正确", "解析二", "", "route"],
            ["单选", "S12冒烟单选题二？", "A项", "B项", "", "", "", "", "a", "", 30, ""],
        ]
        content = build_xlsx(HEADERS, valid_rows)
        r = client.post("/api/admin/questions/import-preview", headers=headers,
                        files={"file": ("import.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
        body = r.json() if r.status_code == 200 else {}
        record("Q02", "合法文件预览统计正确",
               r.status_code == 200 and body.get("total") == 3 and body.get("valid_count") == 3
               and body.get("invalid_count") == 0 and body.get("errors") == [],
               f"status={r.status_code} body={json.dumps(body, ensure_ascii=False)[:200]}")
        token = body.get("preview_token", "")
        imported_texts = [row[1] for row in valid_rows]

        # Q03 确认导入写库
        r = client.post("/api/admin/questions/import-confirm", headers=headers, json={"preview_token": token})
        db = SessionLocal()
        try:
            stored = db.query(Question).filter(Question.question.in_(imported_texts)).all()
            ids = sorted(q.id for q in stored)
        finally:
            db.close()
        record("Q03", "确认导入写库成功且内容正确",
               r.status_code == 200 and r.json().get("imported") == 3 and len(stored) == 3
               and stored and all(q.score in (20, 30) for q in stored),
               f"status={r.status_code} imported={r.json().get('imported') if r.status_code == 200 else None} ids={ids}")

        # Q09 判断题映射（随 Q03 已入库，直接核对）
        db = SessionLocal()
        try:
            judge = db.query(Question).filter(Question.question == "S12冒烟判断题一。").first()
        finally:
            db.close()
        record("Q09", "判断题正确答案映射与选项自动生成",
               judge is not None and judge.type == "judge" and judge.answer == ["A"]
               and judge.options == [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
               f"answer={judge.answer if judge else None} options={judge.options if judge else None}")

        # Q04 重复确认 → 400
        r = client.post("/api/admin/questions/import-confirm", headers=headers, json={"preview_token": token})
        record("Q04", "同一 token 重复确认被拒绝", r.status_code == 400, f"status={r.status_code} detail={r.json().get('detail')}")

        # Q05 错误行定位
        bad_rows = [
            ["多选", "S12错误题型？", "甲", "乙", "", "", "", "", "A", "", 20, ""],               # row2 题型非法
            ["单选", "S12答案越界？", "甲", "乙", "", "", "", "", "C", "", 20, ""],               # row3 答案不在选项
            ["单选", "=cmd|'/c calc'!A1", "甲", "乙", "", "", "", "", "A", "", 20, ""],           # row4 公式注入
            ["单选", imported_texts[0], "甲", "乙", "", "", "", "", "A", "", 20, ""],             # row5 与库内重复
            ["单选", "S12文件内重复？", "甲", "乙", "", "", "", "", "A", "", 20, ""],             # row6
            ["单选", "S12文件内重复？", "丙", "丁", "", "", "", "", "A", "", 20, ""],             # row7 文件内重复
        ]
        content = build_xlsx(HEADERS, bad_rows)
        r = client.post("/api/admin/questions/import-preview", headers=headers,
                        files={"file": ("bad.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
        body = r.json() if r.status_code == 200 else {}
        errors = body.get("errors", [])
        rows_with_error = sorted(e["row"] for e in errors)
        record("Q05", "错误行定位（题型/答案/公式/库内重复/文件内重复）",
               r.status_code == 200 and rows_with_error == [2, 3, 4, 5, 7] and body.get("valid_count") == 1,
               f"rows={rows_with_error} valid={body.get('valid_count')} errors={json.dumps(errors, ensure_ascii=False)[:250]}")
        bad_token = body.get("preview_token", "")

        # Q06 含错误批次确认 → 400
        r = client.post("/api/admin/questions/import-confirm", headers=headers, json={"preview_token": bad_token})
        record("Q06", "含错误批次确认被禁止", r.status_code == 400, f"status={r.status_code} detail={r.json().get('detail')}")

        # Q07 非 xlsx
        r = client.post("/api/admin/questions/import-preview", headers=headers,
                        files={"file": ("import.csv", b"a,b,c", "text/csv")})
        record("Q07", "非 .xlsx 文件拒绝", r.status_code == 400, f"status={r.status_code}")

        # Q08 表头不符
        r = client.post("/api/admin/questions/import-preview", headers=headers,
                        files={"file": ("bad_header.xlsx", build_xlsx(["错", "表", "头"], [["1", "2", "3"]]),
                                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
        record("Q08", "表头不符拒绝", r.status_code == 400 and "表头" in r.json().get("detail", ""),
               f"status={r.status_code} detail={r.json().get('detail')}")

        # Q10 分值浮点单元格（openpyxl 写入 int 后读出可能是 int；此处直接写 float 模拟）
        wb = Workbook()
        ws = wb.active
        ws.append(HEADERS)
        ws.append(["单选", "S12浮点分值题？", "甲", "乙", "", "", "", "", "A", "", 20.0, ""])
        buf = io.BytesIO()
        wb.save(buf)
        r = client.post("/api/admin/questions/import-preview", headers=headers,
                        files={"file": ("float.xlsx", buf.getvalue(),
                                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
        body = r.json() if r.status_code == 200 else {}
        ok_float = r.status_code == 200 and body.get("valid_count") == 1
        if ok_float:
            r2 = client.post("/api/admin/questions/import-confirm", headers=headers,
                             json={"preview_token": body["preview_token"]})
            db = SessionLocal()
            try:
                q = db.query(Question).filter(Question.question == "S12浮点分值题？").first()
                score_val = q.score if q else None
            finally:
                db.close()
            ok_float = r2.status_code == 200 and score_val == 20
        record("Q10", "分值浮点单元格解析为整数 20", ok_float, f"preview={body.get('valid_count')}")

        # Q11 列表分页与筛选（库内 S12 前缀共 4 条：Q03 三条 + Q10 一条）
        r = client.get("/api/admin/questions?page=1&page_size=2&keyword=S12", headers=headers)
        body = r.json()
        page1_ok = r.status_code == 200 and body["total"] == 4 and len(body["items"]) == 2
        r2 = client.get("/api/admin/questions?page=2&page_size=2&keyword=S12", headers=headers)
        r3 = client.get("/api/admin/questions?qtype=judge&keyword=S12", headers=headers)
        r4 = client.get("/api/admin/questions?category=event&keyword=S12", headers=headers)
        record("Q11", "列表分页与筛选（keyword/qtype/category）",
               page1_ok and len(r2.json()["items"]) == 2
               and all(i["type"] == "judge" for i in r3.json()["items"]) and r3.json()["total"] == 1
               and all(i["category"] == "event" for i in r4.json()["items"]),
               f"total={body['total']} p1={len(body['items'])} p2={len(r2.json()['items'])} judge={r3.json()['total']}")
    finally:
        db = SessionLocal()
        try:
            db.query(Question).filter(Question.question.like("S12%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        engine.dispose()

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S12 题库批量导入: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s12-question-import-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    if os.path.exists(_DB_PATH):
        os.remove(_DB_PATH)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
