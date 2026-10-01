# -*- coding: utf-8 -*-
"""
昵称修改（每人仅一次）功能冒烟验收脚本（后端黑盒）
覆盖：登录建号记录微信名 / 重复登录不覆盖昵称 / 一次改名 / 二次改名拦截
      / 排名洞察与人员详情展示修改记录 / 未登录拦截
用法：cd backend && python test/nickname_change_smoke.py
结果：stdout PASS/FAIL + test/nickname-smoke-results.json 证据文件
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BASE = "http://127.0.0.1:8010/api"

RESULTS = []
RUN_CODE = "e2e-nickname-%d" % int(time.time())


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def http(path, token=None, method="GET", data=None):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        BASE + path,
        headers=headers,
        data=json.dumps(data).encode() if data is not None else None,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, None


def main():
    print("== 昵称修改（每人仅一次）冒烟验收 ==")

    # 管理端令牌
    st, admin = http("/admin/login", method="POST", data={"username": "admin", "password": "112233"})
    record("N01", "管理端登录", st == 200 and bool(admin.get("token")), "st=%d" % st)
    admin_token = admin.get("token") if st == 200 else None

    # 1. 首次登录：直接用微信名称建号
    st, res = http("/auth/login", method="POST", data={
        "code": RUN_CODE, "nickname": "微信昵称测试员", "avatar": ""
    })
    ok = st == 200 and res["user"]["nickname"] == "微信昵称测试员" and res["user"].get("nicknameChangedAt") is None
    record("N02", "首次登录以微信名称建号（未改名状态）", ok,
           "st=%d nickname=%s changedAt=%s" % (st, res["user"]["nickname"], res["user"].get("nicknameChangedAt")))
    token = res["token"]
    user_id = res["user"]["id"]

    # 2. 再次登录携带不同昵称：昵称不被登录覆盖
    st, res2 = http("/auth/login", method="POST", data={
        "code": RUN_CODE, "nickname": "登录时的新名字", "avatar": ""
    })
    ok = st == 200 and res2["user"]["nickname"] == "微信昵称测试员"
    record("N03", "重复登录不覆盖已建立昵称", ok,
           "nickname=%s" % res2["user"]["nickname"])

    # 3. 首次改名：成功并记录时间
    st, res3 = http("/auth/nickname", token, "PUT", {"nickname": "长征小红军"})
    ok = st == 200 and res3["nickname"] == "长征小红军" and bool(res3.get("nicknameChangedAt"))
    record("N04", "首次修改昵称成功（返回修改时间）", ok,
           "st=%d nickname=%s changedAt=%s" % (st, res3["nickname"], res3.get("nicknameChangedAt")))

    # 4. 二次改名：400 拦截
    st, res4 = http("/auth/nickname", token, "PUT", {"nickname": "还想再改"})
    ok = st == 400 and "一次" in res4.get("detail", "")
    record("N05", "第二次修改被拒绝（仅一次）", ok, "st=%d detail=%s" % (st, res4.get("detail")))

    # 5. 已改名用户再次登录：昵称保持改后值，不被微信名覆盖
    st, res5 = http("/auth/login", method="POST", data={
        "code": RUN_CODE, "nickname": "微信昵称测试员", "avatar": ""
    })
    ok = st == 200 and res5["user"]["nickname"] == "长征小红军" and bool(res5["user"].get("nicknameChangedAt"))
    record("N06", "已改名用户重复登录昵称保持改后值", ok,
           "nickname=%s changedAt=%s" % (res5["user"]["nickname"], res5["user"].get("nicknameChangedAt")))

    # 6. 排名洞察展示修改记录
    st, rank = http("/admin/rankings", admin_token)
    item = next((i for i in rank.get("items", []) if i["user_id"] == user_id), None) if st == 200 else None
    ok = bool(item) and item["nickname"] == "长征小红军" \
        and item["original_nickname"] == "微信昵称测试员" and bool(item.get("nickname_changed_at"))
    record("N07", "排名洞察返回曾用名与修改时间", ok,
           "st=%d item=%s" % (st, {k: item[k] for k in ("nickname", "original_nickname", "nickname_changed_at")} if item else None))

    # 7. 人员详情聚合展示修改记录
    st, ov = http("/admin/users/%d/overview" % user_id, admin_token)
    u = ov.get("user") if st == 200 else {}
    ok = st == 200 and u.get("original_nickname") == "微信昵称测试员" and bool(u.get("nickname_changed_at"))
    record("N08", "人员详情返回曾用名与修改时间", ok,
           "st=%d nickname=%s original=%s" % (st, u.get("nickname"), u.get("original_nickname")))

    # 8. 空昵称修改：422/400 拦截
    st, res8 = http("/auth/nickname", token, "PUT", {"nickname": "   "})
    record("N09", "空昵称被拒绝", st in (400, 422), "st=%d" % st)

    # 9. 未登录修改昵称：401
    st, _ = http("/auth/nickname", method="PUT", data={"nickname": "匿名"})
    record("N10", "未登录修改昵称被拒绝", st == 401, "st=%d" % st)

    failed = [r for r in RESULTS if not r["ok"]]
    print("== 结果：%d 通过 / %d 失败 ==" % (len(RESULTS) - len(failed), len(failed)))
    Path(__file__).parent.joinpath("nickname-smoke-results.json").write_text(
        json.dumps({"run_code": RUN_CODE, "user_id": user_id, "results": RESULTS},
                   ensure_ascii=False, indent=2), encoding="utf-8"
    )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
