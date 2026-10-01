#!/bin/bash
# 分阶段跑完 5 个阶段 + 汇总；单阶段失败（退出码非0 / 结果为空 / hung）时重启自动化桥重跑一次
cd "$(dirname "$0")"
CLI="/d/Program Files (x86)/Tencent/微信web开发者工具/cli.bat"
PROJECT="D:/project/longmarch-run"

rearm() {
  echo "--- restart IDE + automation bridge ---"
  # 长会话后 IDE 自动化服务会崩（Connection closed / not on top），仅 cli auto 无法恢复，
  # 必须整体重启 IDE 再开自动化端口
  "$CLI" quit >/dev/null 2>&1
  sleep 6
  "$CLI" auto --project "$PROJECT" --auto-port 9420 2>&1 | tail -1
  sleep 45
}

phase_ok() {
  PHASE="$1" node -e '
    try {
      const r = require("./results-p" + process.env.PHASE + ".json");
      process.exit(r && !r.hung && Array.isArray(r.results) && r.results.length > 0 ? 0 : 1);
    } catch (e) { process.exit(1); }
  '
}

node --check ui-test.cjs || exit 1
rm -f results-p1.json results-p2.json results-p3.json results-p4.json results-p5.json results.json console-log.json state.json
rearm

for p in 1 2 3 4 5; do
  ok=0
  for attempt in 1 2 3; do
    if [ $attempt -gt 1 ]; then
      echo "===== PHASE $p failed, retry (attempt $attempt) after bridge rearm ====="
      rearm
    fi
    echo "===== PHASE $p (attempt $attempt) ====="
    if node ui-test.cjs $p && phase_ok $p; then ok=1; break; fi
  done
  [ $ok -ne 1 ] && echo "PHASE $p gave up"
done

node ui-test.cjs merge
echo "===== ALL DONE ====="
