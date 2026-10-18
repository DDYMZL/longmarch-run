"""运营参数配置服务：把散落在 settings 的活动/积分/答题规则外化到 system_settings。

设计与 ai_config_service 一致（生效值 = system_settings 覆盖 > Settings/.env 默认）：
- get_effective(db) 返回一次请求内解析好的快照，供各 service 复用，避免逐处查库（N+1）；
- get_config_view(db) 供管理端「运营参数」页展示（生效值/默认/范围/是否已覆盖）；
- patch_config(db, updates) 白名单校验后写 system_settings（只 flush，路由层 commit）。

覆盖参数：步长、连续行军达标步数、步行/答题积分规则、答题时限与宽限、全员目标步数、
实时动态昵称脱敏开关。
"""
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple
import time

from sqlalchemy.orm import Session

from app.core.config import settings
from app.services import setting_service


@dataclass
class OperationConfig:
    """一次请求内解析好的运营参数快照。"""

    stride_m: float
    streak_goal_steps: int
    points_walk_steps_per_point: int
    points_quiz_per_correct: int
    points_quiz_daily_cap: int
    quiz_question_seconds: int
    quiz_answer_grace_seconds: int
    global_goal_steps: int
    activity_mask_nickname: bool


# 可编辑运营参数规格：(setting_key, 字段名, env 默认取值, 类型, 最小值, 最大值)。
# 类型 ∈ int / float / bool；env 默认用 lambda 延迟读取，保证测试改 settings 后仍生效。
_SPEC: List[Tuple[str, str, Callable[[], Any], str, Optional[float], Optional[float]]] = [
    ("op_stride_m", "stride_m", lambda: settings.STRIDE_M, "float", 0.1, 3.0),
    ("op_streak_goal_steps", "streak_goal_steps", lambda: settings.STREAK_GOAL_STEPS, "int", 1, 100000),
    ("op_points_walk_steps_per_point", "points_walk_steps_per_point", lambda: settings.POINTS_WALK_STEPS_PER_POINT, "int", 1, 1000000),
    ("op_points_quiz_per_correct", "points_quiz_per_correct", lambda: settings.POINTS_QUIZ_PER_CORRECT, "int", 0, 1000),
    ("op_points_quiz_daily_cap", "points_quiz_daily_cap", lambda: settings.POINTS_QUIZ_DAILY_CAP, "int", 0, 100000),
    ("op_quiz_question_seconds", "quiz_question_seconds", lambda: settings.QUIZ_QUESTION_SECONDS, "int", 5, 600),
    ("op_quiz_answer_grace_seconds", "quiz_answer_grace_seconds", lambda: settings.QUIZ_ANSWER_GRACE_SECONDS, "int", 0, 60),
    ("op_global_goal_steps", "global_goal_steps", lambda: settings.GLOBAL_GOAL_STEPS, "int", 1, 10_000_000_000),
    ("op_activity_mask_nickname", "activity_mask_nickname", lambda: settings.ACTIVITY_MASK_NICKNAME, "bool", None, None),
]
_BY_KEY: Dict[str, Tuple[str, str, Callable[[], Any], str, Optional[float], Optional[float]]] = {
    spec[0]: spec for spec in _SPEC
}
_BY_FIELD: Dict[str, Tuple[str, str, Callable[[], Any], str, Optional[float], Optional[float]]] = {
    spec[1]: spec for spec in _SPEC
}


def _cast_number(raw: Any, default: Any, kind: str, lo: Optional[float], hi: Optional[float]) -> Any:
    """按类型转换并夹取范围；无法解析时回退默认值。"""
    try:
        num = float(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if lo is not None:
        num = max(lo, num)
    if hi is not None:
        num = min(hi, num)
    return int(round(num)) if kind == "int" else num


# 前端步长控件步进：浮点型 0.1 / 整数型 1 / 布尔型无步进语义（None）。
_STEP_BY_KIND: Dict[str, Optional[float]] = {"int": 1, "float": 0.1, "bool": None}


def _step_of(kind: str) -> Optional[float]:
    return _STEP_BY_KIND.get(kind)


def _normalize(default_fn: Callable[[], Any], kind: str, num: Optional[float] = None) -> Any:
    """把 env 默认值（num 为空）或已解析数值（num 非空）归一为可比较的同类型值。"""
    source = default_fn() if num is None else num
    if kind == "bool":
        return bool(source)
    if kind == "int":
        return int(round(float(source)))
    return float(source)


def _equals_default(new_val: Any, default_val: Any, kind: str) -> bool:
    """判断提交值是否等于 env 默认（浮点用微小容差，避免二进制表示误差）。"""
    if kind == "float":
        return abs(float(new_val) - float(default_val)) < 1e-9
    return new_val == default_val


def get_effective(db: Session) -> OperationConfig:
    """合并生效配置：DB 有值且合法则覆盖 env 默认，否则回退 env 默认（单次批量查库）。

    性能（#15）：配置为全局单例、变更极少，加进程内短 TTL 缓存（_CONFIG_TTL 秒），
    避免一次请求内多处 get_effective 及高频接口反复批量查 system_settings（N+1）。
    patch_config 写库后调用 invalidate_cache() 立即失效，保证管理端改配置即时生效。
    """
    now = time.monotonic()
    cached = _CONFIG_CACHE["val"]
    if cached is not None and now - _CONFIG_CACHE["at"] < _CONFIG_TTL:
        return cached
    cfg = _compute_effective(db)
    _CONFIG_CACHE["at"] = now
    _CONFIG_CACHE["val"] = cfg
    return cfg


def _compute_effective(db: Session) -> OperationConfig:
    """实际查库合并生效配置（get_effective 的未缓存实现）。"""
    raw_map = setting_service.get_values(db, [spec[0] for spec in _SPEC])
    values: Dict[str, Any] = {}
    for key, field, default_fn, kind, lo, hi in _SPEC:
        raw = raw_map.get(key)
        if raw is None or str(raw).strip() == "":
            values[field] = default_fn()
        elif kind == "bool":
            values[field] = str(raw).strip().lower() in ("1", "true", "yes", "on")
        else:
            values[field] = _cast_number(raw, default_fn(), kind, lo, hi)
    return OperationConfig(**values)


# 运营参数进程内短 TTL 缓存（#15）：配置全局且极少变更，缓存 _CONFIG_TTL 秒消除高频 N+1。
_CONFIG_TTL = 30.0
_CONFIG_CACHE: Dict[str, Any] = {"at": 0.0, "val": None}


def invalidate_cache() -> None:
    """失效运营参数缓存（patch_config 写库后、或测试改 settings 后调用）。"""
    _CONFIG_CACHE["at"] = 0.0
    _CONFIG_CACHE["val"] = None


def get_config_view(db: Session) -> Dict[str, Any]:
    """管理端「运营参数」展示视图：生效值 + env 默认 + 取值范围 + 已覆盖项。

    直接走未缓存的 _compute_effective，确保管理端看到的生效值与 overridden 严格一致
    （不受 #15 短 TTL 缓存影响）。
    """
    raw_map = setting_service.get_values(db, [spec[0] for spec in _SPEC])
    cfg = _compute_effective(db)
    return {
        "values": {spec[1]: getattr(cfg, spec[1]) for spec in _SPEC},
        "defaults": {spec[1]: spec[2]() for spec in _SPEC},
        "ranges": {
            spec[1]: {
                "min": spec[4],
                "max": spec[5],
                "type": spec[3],
                "step": _step_of(spec[3]),
            }
            for spec in _SPEC
        },
        "overridden": [
            spec[1] for spec in _SPEC if (raw_map.get(spec[0]) or "").strip() != ""
        ],
    }


def patch_config(db: Session, updates: Dict[str, Any]) -> Dict[str, Any]:
    """校验并写入运营参数（不提交，由路由统一 commit）。仅接受白名单字段名。

    入参键为字段名（如 stride_m）；越界/类型错误抛 ValueError（路由转 400）。
    纵深防御（D12）：提交值等于 env 默认时不持久化——若该 key 已有覆盖记录则删除，
    使其回到「未覆盖」状态，避免把默认值固化、后续改 env/Settings 默认不再生效；
    只有真正偏离默认的值才成为覆盖记录。
    含白名单外的键时抛「不支持的配置项：xxx」，而非误导性的「没有需要更新的配置」。
    """
    if not updates:
        raise ValueError("没有需要更新的配置")
    unknown = sorted(field for field in updates if field not in _BY_FIELD)
    if unknown:
        raise ValueError("不支持的配置项：" + "、".join(unknown))
    for field, value in updates.items():
        key, _, default_fn, kind, lo, hi = _BY_FIELD[field]
        if kind == "bool":
            if not isinstance(value, bool):
                raise ValueError(f"{field} 必须是布尔值")
            new_val = bool(value)
            stored = "true" if new_val else "false"
        else:
            if value is None:
                raise ValueError(f"{field} 不能为空")
            try:
                num = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"{field} 必须是数字")
            if (lo is not None and num < lo) or (hi is not None and num > hi):
                raise ValueError(f"{field} 取值必须在 {lo:g}~{hi:g} 之间")
            new_val = _normalize(default_fn, kind, num)
            stored = str(int(round(num))) if kind == "int" else repr(num)
        # D12：提交值 == env 默认 → 跳过持久化并删除既有覆盖记录，回到「未覆盖」状态
        if _equals_default(new_val, _normalize(default_fn, kind), kind):
            setting_service.delete_value(db, key)
            continue
        setting_service.set_value(db, key, stored)
    # autoflush=False：先 flush 让写入对随后读取可见，保证响应即返回最新生效值。
    db.flush()
    # #15：配置已变更，失效短 TTL 缓存，使后续 get_effective 立即读到新值。
    invalidate_cache()
    return get_config_view(db)

