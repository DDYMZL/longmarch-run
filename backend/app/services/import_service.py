"""Excel 批量导入（V1.1）：模板生成、上传解析、整批校验、确认写入。

通用约定：
- 仅支持 .xlsx，限制文件大小与数据行数；
- 公式单元格（文本以 = / + / @ 开头，或非数值的 - 开头）整行判错，防 Excel 公式注入；
- 任意一行校验失败则整批不可确认导入，避免产生不完整数据；
- 预览数据暂存 import_previews 表，确认接口凭 token 一次性事务写入并核销 token；
- 默认新增导入模式：与库内既有数据重复的整行判错，不自动覆盖。

各业务（题库/寄语/人员）注册各自的表头、模板说明、行解析与批量写入函数。
"""
import io
import uuid
from datetime import datetime, timedelta
from typing import Callable, Dict, List, Optional, Tuple

from openpyxl import Workbook, load_workbook
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.models import ImportPreview, Question
from app.services.admin_service import _validate_question

MAX_FILE_SIZE = 2 * 1024 * 1024  # 2MB
MAX_ROWS = 500
PREVIEW_TTL_MINUTES = 30


class ImportError(Exception):
    """文件级错误（类型/大小/表头不符），路由层转 400。"""


def _fail(row: int, field: str, reason: str) -> Dict:
    return {"row": row, "field": field, "reason": reason}


def _cell_text(value) -> str:
    """单元格转纯文本；公式/DDE 注入特征抛 ValueError。

    Excel 数值单元格读出为 int/float（如 20.0），整数型浮点还原为整数字符串，
    避免选项、分值等纯数字文本被污染成「20.0」。
    """
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).strip()
    if not text:
        return ""
    if text[0] in ("=", "+", "@"):
        raise ValueError("不允许包含公式或以 + = @ 开头的内容")
    if text[0] == "-" and not text[1:].replace(".", "", 1).isdigit():
        raise ValueError("不允许以 - 开头的非数值内容")
    return text


def _read_sheet(content: bytes, expected_headers: List[str]) -> Tuple[List[Dict], List[Dict]]:
    """解析首个工作表，返回 (有效数据行, 文件级错误)。

    数据行为 [{row: Excel 行号, raw: {表头: 文本}}]；全空行跳过。
    表头不匹配、无数据行等返回文件级错误（errors 非空时调用方直接返回）。
    """
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=False)
    except Exception:
        raise ImportError("文件无法解析，请使用下载的 .xlsx 模板填写后上传")
    ws = wb.worksheets[0]
    rows_iter = ws.iter_rows(values_only=True)
    try:
        header_row = next(rows_iter)
    except StopIteration:
        raise ImportError("文件为空，请使用下载的模板填写数据")
    headers = [_cell_text(v) for v in header_row]
    trimmed = [h for h in headers if h]
    if trimmed[: len(expected_headers)] != expected_headers:
        raise ImportError("表头与模板不一致，请下载最新模板填写")
    data_rows: List[Dict] = []
    errors: List[Dict] = []
    for index, values in enumerate(rows_iter, start=2):
        raw: Dict[str, str] = {}
        has_content = False
        row_error: Optional[Dict] = None
        for col, value in enumerate(values):
            if col >= len(expected_headers):
                break
            try:
                text = _cell_text(value)
            except ValueError as exc:
                row_error = _fail(index, expected_headers[col], str(exc))
                break
            raw[expected_headers[col]] = text
            if text:
                has_content = True
        if row_error is not None:
            errors.append(row_error)
        elif has_content:
            data_rows.append({"row": index, "raw": raw})
        if len(data_rows) + len(errors) > MAX_ROWS:
            raise ImportError(f"数据行数超过上限 {MAX_ROWS} 行")
    wb.close()
    if not data_rows and not errors:
        raise ImportError("未解析到任何数据行")
    return data_rows, errors


def _build_workbook(sheet_name: str, headers: List[str], instructions: List[str]) -> bytes:
    """生成双工作表模板：数据表（仅表头）+ 填写说明。"""
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name
    ws.append(headers)
    for col in range(1, len(headers) + 1):
        ws.column_dimensions[ws.cell(row=1, column=col).column_letter].width = 18
    guide = wb.create_sheet("填写说明")
    for line in instructions:
        guide.append([line])
    guide.column_dimensions["A"].width = 100
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def _save_preview(db: Session, biz_type: str, rows: List[Dict], errors: List[Dict], operator: str) -> str:
    """暂存预览结果，返回一次性确认令牌。"""
    token = uuid.uuid4().hex
    db.add(
        ImportPreview(
            token=token,
            biz_type=biz_type,
            payload={"rows": rows, "errors": errors},
            created_by=operator,
            expires_at=datetime.utcnow() + timedelta(minutes=PREVIEW_TTL_MINUTES),
        )
    )
    db.commit()
    return token


def _confirm(
    db: Session,
    token: str,
    biz_type: str,
    inserter: Callable[[Session, List[Dict]], int],
) -> int:
    """核销预览令牌并批量写入正式表；任一步骤失败整体回滚。

    令牌核销采用条件更新（status pending → confirmed），并发重复提交只有
    一个请求能核销成功；写入异常时回滚，令牌恢复 pending 可重试。
    """
    preview = db.query(ImportPreview).filter(ImportPreview.token == token).first()
    if preview is None or preview.biz_type != biz_type:
        raise ValueError("预览不存在，请重新上传文件")
    if preview.expires_at < datetime.utcnow():
        raise ValueError("预览已过期，请重新上传文件")
    errors = (preview.payload or {}).get("errors") or []
    if errors:
        raise ValueError("存在校验失败的数据行，本批次禁止导入")
    rows = (preview.payload or {}).get("rows") or []
    if not rows:
        raise ValueError("没有可导入的数据行")
    claimed = (
        db.query(ImportPreview)
        .filter(ImportPreview.token == token, ImportPreview.status == "pending")
        .update({"status": "confirmed", "confirmed_at": datetime.utcnow()})
    )
    if claimed != 1:
        raise ValueError("该导入已确认，请勿重复提交")
    try:
        count = inserter(db, rows)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return count


# ---------------- 题库导入 ----------------
QUESTION_HEADERS = [
    "题型", "题目内容", "选项A", "选项B", "选项C", "选项D", "选项E", "选项F",
    "正确答案", "答案解析", "分值", "知识分类",
]

QUESTION_INSTRUCTIONS = [
    "长征步迹题库导入模板 · 填写说明",
    "1. 在「题目数据」工作表从第 2 行开始填写，请勿修改表头；单次最多 500 行。",
    "2. 题型：必填，填「单选」或「判断」（也接受 single / judge）。",
    "3. 选项A~F：单选题至少填写 2 个选项；判断题无需填写选项（系统固定为 A.正确 B.错误）。",
    "4. 正确答案：单选题填选项字母（如 A，且只能 1 个）；判断题填「正确」或「错误」（也接受 A / B）。",
    "5. 答案解析：可选；分值：正整数，留空默认 20。",
    "6. 知识分类：可选，填 历史事件 / 长征路线 / 历史人物（也接受 event / route / figure）。",
    "7. 题目内容与库内已有题目或文件内其他行完全相同的，整行判错（默认新增导入，不覆盖）。",
    "8. 任意一行校验失败，本批次全部禁止导入；修正后重新上传即可。",
]

_QUESTION_TYPE_ALIASES = {"单选": "single", "single": "single", "判断": "judge", "judge": "judge"}
_QUESTION_CATEGORY_ALIASES = {
    "历史事件": "event", "event": "event",
    "长征路线": "route", "route": "route",
    "历史人物": "figure", "figure": "figure",
}


def build_question_template() -> bytes:
    """生成题库导入模板（数据表 + 填写说明）。"""
    return _build_workbook("题目数据", QUESTION_HEADERS, QUESTION_INSTRUCTIONS)


def _parse_question_row(raw: Dict[str, str]) -> Dict:
    """把一行 Excel 文本转换为题目字段 dict；非法值抛 ValueError。"""
    qtype = _QUESTION_TYPE_ALIASES.get(raw["题型"].lower() if raw["题型"] else "")
    if qtype is None:
        raise ValueError("题型必须为「单选」或「判断」")
    data: Dict = {
        "type": qtype,
        "question": raw["题目内容"],
        "analysis": raw["答案解析"],
        "category": "",
        "options": [],
        "answer": [],
    }
    category = raw["知识分类"]
    if category:
        mapped = _QUESTION_CATEGORY_ALIASES.get(category.lower() if category.isascii() else category)
        if mapped is None:
            raise ValueError("知识分类必须为 历史事件 / 长征路线 / 历史人物 或留空")
        data["category"] = mapped
    score_text = raw["分值"] or "20"
    try:
        score_value = float(score_text)
    except ValueError:
        raise ValueError("分值必须为正整数")
    if not score_value.is_integer() or score_value <= 0:
        raise ValueError("分值必须为正整数")
    data["score"] = int(score_value)
    answer_text = raw["正确答案"].upper()
    if qtype == "judge":
        data["options"] = [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}]
        judge_map = {"正确": "A", "错误": "B", "A": "A", "B": "B", "对": "A", "错": "B"}
        if raw["正确答案"] not in judge_map and answer_text not in judge_map:
            raise ValueError("判断题正确答案必须填「正确」或「错误」")
        data["answer"] = [judge_map.get(raw["正确答案"], judge_map.get(answer_text, ""))]
    else:
        options = []
        for label in ("A", "B", "C", "D", "E", "F"):
            text = raw[f"选项{label}"]
            if text:
                options.append({"label": label, "text": text})
        data["options"] = options
        data["answer"] = [a for a in answer_text.replace("，", ",").replace("、", ",").split(",") if a]
    _validate_question(data)
    return data


def preview_question_import(db: Session, content: bytes, operator: str) -> Dict:
    """解析并整批校验题库文件，暂存预览，返回统计与令牌。"""
    data_rows, row_errors = _read_sheet(content, QUESTION_HEADERS)
    valid_rows: List[Dict] = []
    errors: List[Dict] = list(row_errors)
    seen_texts: Dict[str, int] = {}
    existing = {q.question.strip() for q in db.query(Question.question).all()}
    for item in data_rows:
        row_no, raw = item["row"], item["raw"]
        try:
            data = _parse_question_row(raw)
        except ValueError as exc:
            errors.append(_fail(row_no, "", str(exc)))
            continue
        text = data["question"].strip()
        if text in existing:
            errors.append(_fail(row_no, "题目内容", "与题库中已有题目重复"))
            continue
        if text in seen_texts:
            errors.append(_fail(row_no, "题目内容", f"与文件内第 {seen_texts[text]} 行重复"))
            continue
        seen_texts[text] = row_no
        valid_rows.append({"row": row_no, "data": data})
    errors.sort(key=lambda e: e["row"])
    token = _save_preview(db, "question", valid_rows, errors, operator)
    return {
        "preview_token": token,
        "total": len(valid_rows) + len(errors),
        "valid_count": len(valid_rows),
        "invalid_count": len(errors),
        "errors": errors,
    }


def confirm_question_import(db: Session, token: str) -> int:
    """核销令牌并批量写入题目（id 取 max+1 起连续分配，与新增题目一致）。"""

    def _insert(session: Session, rows: List[Dict]) -> int:
        base_id = session.query(func.max(Question.id)).scalar() or 0
        for offset, item in enumerate(rows, start=1):
            session.add(Question(id=base_id + offset, **item["data"]))
        return len(rows)

    return _confirm(db, token, "question", _insert)
