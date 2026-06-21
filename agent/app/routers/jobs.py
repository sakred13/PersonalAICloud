"""
Jobs router — internal only.

Exposes manual trigger + status endpoints for every registered tool.
Extend TOOL_REGISTRY to add new tools — no other changes needed.

POST /jobs/{tool_name}/trigger  — run a tool immediately (async, returns job id)
GET  /jobs/{tool_name}/status   — last run result for that tool
GET  /jobs/                     — list all registered tools + last status
"""
import logging
import threading
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, HTTPException

from ..tools.base import JobResult
from ..tools.tag_images import TagImagesTool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/jobs", tags=["jobs"])

# ── Tool registry ─────────────────────────────────────────────────────────────
# Add new tools here — the router handles the rest automatically.
TOOL_REGISTRY: dict[str, object] = {
    TagImagesTool.name: TagImagesTool(),
    # future: "transcribe_audio": TranscribeAudioTool(),
    # future: "summarise_docs": SummariseDocsTool(),
}

# In-memory store of the last result per tool (survives within a container
# lifetime — fine for a batch job status display)
_last_results: dict[str, JobResult] = {}
_running: dict[str, bool] = {}
_lock = threading.Lock()


def _run_tool_bg(tool_name: str) -> None:
    """Background thread target — runs the tool and stores the result."""
    tool = TOOL_REGISTRY[tool_name]
    with _lock:
        _running[tool_name] = True
    try:
        result = tool.run()
    except Exception as exc:
        result = JobResult(
            tool_name=tool_name,
            started_at=datetime.now(tz=timezone.utc),
            finished_at=datetime.now(tz=timezone.utc),
            errors=[str(exc)],
        )
        logger.error("[jobs] %s failed: %s", tool_name, exc)
    finally:
        with _lock:
            _last_results[tool_name] = result
            _running[tool_name] = False


@router.get("/")
def list_tools():
    """List all registered tools and their last run status."""
    out = []
    for name, tool in TOOL_REGISTRY.items():
        last = _last_results.get(name)
        out.append({
            "name": name,
            "description": tool.description,
            "running": _running.get(name, False),
            "last_run": last.to_dict() if last else None,
        })
    return {"tools": out}


@router.post("/{tool_name}/trigger")
def trigger_tool(tool_name: str, background_tasks: BackgroundTasks):
    """Immediately run the named tool in a background thread."""
    if tool_name not in TOOL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {tool_name}")
    if _running.get(tool_name):
        raise HTTPException(status_code=409, detail=f"'{tool_name}' is already running")

    background_tasks.add_task(_run_tool_bg, tool_name)
    return {"triggered": tool_name, "message": f"'{tool_name}' started in background"}


@router.get("/{tool_name}/status")
def tool_status(tool_name: str):
    """Return the last result for the named tool."""
    if tool_name not in TOOL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {tool_name}")
    last = _last_results.get(tool_name)
    return {
        "name": tool_name,
        "running": _running.get(tool_name, False),
        "last_run": last.to_dict() if last else None,
    }
