"""AI 出题：调用 CloudBase Agent 生成题目草稿，经管理员确认后批量入库。

设计约束：
- 仅生成单选题（type=single），与小程序答题逻辑「单答案提交」保持一致；
- 难度只作为提示词参数，不入库（questions 表无 difficulty 列）；
- 生成结果一律是草稿，不直接写库；管理员确认后由 batch_save_questions 落库；
- 入库前复用 admin_service._validate_question（与 Excel 导入同等校验强度），
  并重新做库内/批内查重，不信任前端回传内容；
- 大批量拆成多批并发调用 Agent，规避单次长回复被截断。
"""
import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.models import Question
from app.services import admin_service, cloudbase_service

logger = logging.getLogger(__name__)

# 当前仅开放单选题：小程序答题接口强制提交单个答案（quiz_service 校验），
# 多选题需同步改动判分与小程序交互，属于破坏性变更，故不在此开放。
SUPPORTED_TYPES = ("single",)
SUPPORTED_DIFFICULTIES = ("easy", "medium", "hard", "mixed")
SUPPORTED_CATEGORIES = ("event", "route", "figure")

TOPIC_MAX_LEN = 100
EXTRA_MAX_LEN = 300
DEFAULT_SCORE = 20
OPTION_LABELS = ("A", "B", "C", "D", "E", "F")
DEFAULT_OPTION_COUNT = 4

_DIFFICULTY_TEXT = {
    "easy": "简单（考查常见基础史实）",
    "medium": "中等（考查重要事件、人物与路线）",
    "hard": "困难（考查细节、时间顺序与因果辨析）",
    "mixed": "难易混合（简单、中等、困难各占一部分）",
}
_CATEGORY_TEXT = {
    "event": "历史事件",
    "route": "长征路线",
    "figure": "历史人物",
}


def _split_batches(count: int, batch_size: int) -> List[int]:
    """把总题数拆成若干批次，例如 25 题、每批 10 → [10, 10, 5]。"""
    size = max(1, batch_size)
    batches = [size] * (count // size)
    if count % size:
        batches.append(count % size)
    return batches


def _build_prompt(
    topic: str, count: int, difficulty: str, category: str, extra: str
) -> str:
    """构建提示词：约束 Agent 只输出可直接 json.loads 的题目数组。"""
    lines = [
        f"请围绕主题「{topic}」生成 {count} 道中国工农红军长征相关的单项选择题。",
        f"难度要求：{_DIFFICULTY_TEXT.get(difficulty, _DIFFICULTY_TEXT['medium'])}。",
    ]
    if category:
        lines.append(f"知识分类侧重：{_CATEGORY_TEXT.get(category, '')}。")
    lines += [
        "",
        "输出要求（务必严格遵守）：",
        "1. 只输出一个 JSON 数组，不要输出任何解释、前后缀文字或 Markdown 代码块标记。",
        f"2. 数组长度必须恰好为 {count}。",
        "3. 每个元素包含且仅包含四个字段：question（题干，字符串）、options（选项数组）、"
        "answer（正确答案数组）、analysis（答案解析，字符串）。",
        f"4. options 固定 {DEFAULT_OPTION_COUNT} 个元素，每个形如 "
        '{"label": "A", "text": "选项内容"}，label 依次取 '
        f"{'、'.join(OPTION_LABELS[:DEFAULT_OPTION_COUNT])}。",
        '5. answer 必须是只含 1 个元素的数组，取值为正确选项的 label，例如 ["B"]。',
        "6. 有且仅有一个正确答案；错误选项须有明显区分度，不得与正确答案等价或含糊。",
        "7. analysis 用 1~3 句中文说明答案依据，可点明其他选项为何错误。",
        "8. 各题之间题干与选项均不得重复或高度雷同。",
        "9. 史实必须准确；无法确认的时间、数字、人物不要编造，宁可换一个确定的考点。",
        "10. 题干与选项使用简体中文，不要出现题号编号。",
    ]
    extra = extra.strip()
    if extra:
        lines.append(f"11. 补充要求：{extra}")
    return "\n".join(lines)


def _extract_json_array(reply: str) -> List[Any]:
    """从 Agent 回复中提取 JSON 数组，容忍代码围栏与前后多余文本。"""
    text = reply.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0]
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("AI 返回内容不是 JSON 数组，请重试")
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        raise ValueError("AI 返回的 JSON 无法解析，请重试")
    if not isinstance(data, list):
        raise ValueError("AI 返回内容不是 JSON 数组，请重试")
    return data


def _normalize_options(raw_options: Any) -> List[Dict[str, str]]:
    """把 Agent 输出的选项规整为 [{"label": "A", "text": "..."}]。

    兼容三种写法：{"label","text"}、{"label","content"}、纯字符串数组；
    label 缺失时按顺序补 A/B/C/D。
    """
    options: List[Dict[str, str]] = []
    for index, opt in enumerate(raw_options):
        if isinstance(opt, dict):
            label = str(opt.get("label") or "").strip().upper()
            text = str(opt.get("text") or opt.get("content") or "").strip()
        else:
            label, text = "", str(opt).strip()
        if not label:
            label = OPTION_LABELS[index] if index < len(OPTION_LABELS) else str(index + 1)
        options.append({"label": label, "text": text})
    return options


def _normalize_answer(raw_answer: Any) -> List[str]:
    """把 Agent 输出的答案统一为大写 label 数组，兼容 "B" / ["B"] / ["b"] 三种写法。"""
    if isinstance(raw_answer, str):
        raw_answer = [raw_answer]
    if not isinstance(raw_answer, list):
        raise ValueError("answer 字段必须是数组")
    return [str(a).strip().upper() for a in raw_answer if str(a).strip()]


def _blank_question(category: str) -> Dict:
    """结构完整但内容为空的题目，供无法解析的条目占位，保证前端可渲染并手工修正。"""
    return {
        "type": "single",
        "question": "",
        "options": [
            {"label": label, "text": ""} for label in OPTION_LABELS[:DEFAULT_OPTION_COUNT]
        ],
        "answer": [],
        "analysis": "",
        "score": DEFAULT_SCORE,
        "category": category,
    }


def _normalize_item(raw: Any, category: str) -> Dict:
    """把 Agent 输出的单个元素规整为 questions 表结构，结构非法抛 ValueError。"""
    if not isinstance(raw, dict):
        raise ValueError("题目必须是 JSON 对象")
    raw_options = raw.get("options")
    if not isinstance(raw_options, list):
        raise ValueError("options 字段必须是数组")
    return {
        "type": "single",
        "question": str(raw.get("question") or "").strip(),
        "options": _normalize_options(raw_options),
        "answer": _normalize_answer(raw.get("answer")),
        "analysis": str(raw.get("analysis") or "").strip(),
        "score": DEFAULT_SCORE,
        "category": category,
    }


def _existing_question_texts(db: Session) -> Set[str]:
    """库内启用题目的题干集合，用于查重（口径与 Excel 导入预览一致）。"""
    rows = db.query(Question.question).filter(Question.active.is_(True)).all()
    return {(row[0] or "").strip() for row in rows}


def _duplicate_reasons(text: str, existing: Set[str], seen: Set[str]) -> List[str]:
    """返回重复原因列表；题干为空时不报重复（由校验环节报「题干不能为空」）。"""
    key = text.strip()
    if not key:
        return []
    if key in existing:
        return ["与题库中已有题目重复"]
    if key in seen:
        return ["与本次生成的其他题目重复"]
    return []


def _generate_batch(
    topic: str, count: int, difficulty: str, category: str, extra: str
) -> List[Any]:
    """调用 Agent 生成一批题目，返回解析后的原始元素列表。"""
    reply = cloudbase_service.prompt(
        _build_prompt(topic, count, difficulty, category, extra)
    )
    return _extract_json_array(reply)


def _run_batches(
    topic: str, batches: List[int], difficulty: str, category: str, extra: str
) -> Tuple[List[Any], List[str], Optional[Exception]]:
    """并发执行各批次；返回（题目元素、批次级错误消息、首个异常）。

    单批失败不影响其他批次，只记录错误；首个异常保留原类型，
    以便全部失败时路由层仍能区分 502（上游故障）与 400（参数/解析问题）。
    """
    workers = max(1, min(len(batches), settings.AI_QUESTION_MAX_CONCURRENCY))
    outcomes: List[Tuple[int, Optional[List[Any]], Optional[Exception]]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_generate_batch, topic, size, difficulty, category, extra): index
            for index, size in enumerate(batches)
        }
        for future in as_completed(futures):
            index = futures[future]
            try:
                outcomes.append((index, future.result(), None))
            except Exception as exc:  # 批次级兜底：任何单批异常都不得中断整体生成
                outcomes.append((index, None, exc))
    outcomes.sort(key=lambda item: item[0])
    elements: List[Any] = []
    errors: List[str] = []
    first_error: Optional[Exception] = None
    for index, data, exc in outcomes:
        if exc is not None:
            if first_error is None:
                first_error = exc
            errors.append(f"第 {index + 1} 批生成失败：{exc}")
            continue
        elements.extend(data or [])
    return elements, errors, first_error


def _build_drafts(db: Session, elements: List[Any], category: str) -> List[Dict]:
    """把原始元素规整、校验、查重后组装成草稿列表（含每题待修正问题）。"""
    existing = _existing_question_texts(db)
    seen: Set[str] = set()
    drafts: List[Dict] = []
    for raw in elements:
        errors: List[str] = []
        try:
            data = _normalize_item(raw, category)
        except ValueError as exc:
            data = _blank_question(category)
            errors.append(str(exc))
        else:
            try:
                admin_service._validate_question(data)
            except ValueError as exc:
                errors.append(str(exc))
            errors.extend(_duplicate_reasons(data["question"], existing, seen))
            seen.add(data["question"].strip())
        drafts.append({"index": len(drafts) + 1, "data": data, "errors": errors})
    return drafts


def generate_questions(
    db: Session,
    topic: str,
    count: int,
    question_type: str = "single",
    difficulty: str = "medium",
    category: str = "",
    extra_requirements: str = "",
) -> Dict:
    """生成题目草稿并做校验/查重，返回草稿与统计；不写入正式题库。"""
    topic = (topic or "").strip()
    if not topic:
        raise ValueError("出题主题不能为空")
    if len(topic) > TOPIC_MAX_LEN:
        raise ValueError(f"出题主题不能超过 {TOPIC_MAX_LEN} 字")
    if question_type not in SUPPORTED_TYPES:
        raise ValueError("AI 出题目前仅支持单选题（single）")
    if difficulty not in SUPPORTED_DIFFICULTIES:
        raise ValueError("难度必须为 easy（简单）/ medium（中等）/ hard（困难）/ mixed（混合）")
    category = (category or "").strip()
    if category and category not in SUPPORTED_CATEGORIES:
        raise ValueError("分类必须为 event（历史事件）/ route（长征路线）/ figure（历史人物）或留空")
    extra = (extra_requirements or "").strip()
    if len(extra) > EXTRA_MAX_LEN:
        raise ValueError(f"补充要求不能超过 {EXTRA_MAX_LEN} 字")
    max_count = settings.AI_QUESTION_MAX_COUNT
    if not 1 <= count <= max_count:
        raise ValueError(f"生成数量必须在 1~{max_count} 之间")

    batches = _split_batches(count, settings.AI_QUESTION_BATCH_SIZE)
    elements, batch_errors, first_error = _run_batches(
        topic, batches, difficulty, category, extra
    )
    if not elements:
        # 全部批次失败：抛出原始异常，保留 CloudBaseError 类型以便路由映射为 502
        if first_error is not None:
            raise first_error
        raise ValueError("AI 未返回任何题目，请重试")

    drafts = _build_drafts(db, elements, category)
    invalid = sum(1 for d in drafts if d["errors"])
    logger.info(
        "ai generate: topic_len=%d requested=%d batches=%d generated=%d invalid=%d batch_errors=%d",
        len(topic), count, len(batches), len(drafts), invalid, len(batch_errors),
    )
    return {
        "requested": count,
        "generated": len(drafts),
        "valid_count": len(drafts) - invalid,
        "invalid_count": invalid,
        "items": drafts,
        "batch_errors": batch_errors,
    }


def batch_save_questions(db: Session, items: List[Dict]) -> Dict:
    """重新校验并批量写入题目，返回保存数量与失败明细。

    不信任前端：每条都重新过 admin_service._validate_question 与库内/批内查重。
    通过校验的题目在单事务内写入，数据库异常整体回滚；未通过的跳过并计入失败明细，
    从而实现「部分失败可统计」而不产生半批脏数据。
    """
    if not items:
        raise ValueError("没有需要保存的题目")
    max_count = settings.AI_QUESTION_MAX_COUNT
    if len(items) > max_count:
        raise ValueError(f"单次最多保存 {max_count} 道题目")

    existing = _existing_question_texts(db)
    seen: Set[str] = set()
    pending: List[Dict] = []
    failures: List[Dict] = []
    for index, item in enumerate(items, start=1):
        data = dict(item)
        try:
            admin_service._validate_question(data)
        except ValueError as exc:
            failures.append({"index": index, "reason": str(exc)})
            continue
        reasons = _duplicate_reasons(data["question"], existing, seen)
        if reasons:
            failures.append({"index": index, "reason": "；".join(reasons)})
            continue
        seen.add(data["question"].strip())
        pending.append(data)

    if pending:
        # questions.id 无数据库自增（种子占用固定 id），与新增/导入一致显式取 max+1 连续分配
        base_id = db.query(func.max(Question.id)).scalar() or 0
        try:
            for offset, data in enumerate(pending, start=1):
                db.add(Question(id=base_id + offset, **data))
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("ai question batch save failed")
            raise ValueError("保存失败，请稍后重试")
    logger.info("ai batch save: saved=%d failed=%d", len(pending), len(failures))
    return {"saved": len(pending), "failed": len(failures), "failures": failures}
