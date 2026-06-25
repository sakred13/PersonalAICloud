"""
FastAPI application entry point for the PersonalCloud agent service.

Responsibilities:
  - Mount all routers (search, jobs)
  - Initialise the database pool and run migrations on startup
  - Start APScheduler with the configured cron for the nightly tag job
  - Expose a health endpoint
"""
import logging
import threading
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI

from .config import settings
from .db import close_db, init_db
from .routers import jobs as jobs_router
from .routers import search as search_router
from .routers import agent as agent_router
from .routers.jobs import TOOL_REGISTRY, _run_tool_bg

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Scheduler ─────────────────────────────────────────────────────────────────
_scheduler: BackgroundScheduler | None = None


def _parse_cron(expr: str) -> CronTrigger:
    """Parse a 5-field cron string into an APScheduler CronTrigger."""
    fields = expr.strip().split()
    if len(fields) != 5:
        raise ValueError(f"Invalid AGENT_CRON expression: '{expr}' (need 5 fields)")
    minute, hour, day, month, day_of_week = fields
    return CronTrigger(
        minute=minute,
        hour=hour,
        day=day,
        month=month,
        day_of_week=day_of_week,
    )


# ── Lifespan (startup / shutdown) ─────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _scheduler

    # 1. Initialise DB (creates pool + runs idempotent migration)
    logger.info("[startup] Connecting to database …")
    init_db()

    # 2. Start cron scheduler for nightly tag job
    _scheduler = BackgroundScheduler(timezone=settings.TIMEZONE)
    trigger = _parse_cron(settings.AGENT_CRON)
    _scheduler.add_job(
        func=lambda: _run_tool_bg("tag_images"),
        trigger=trigger,
        id="nightly_tag_images",
        name="Nightly image tagging",
        replace_existing=True,
        misfire_grace_time=3600,  # If the container was down, run within 1h of scheduled time
    )

    # 3. Schedule thumbnail generation 30 minutes after tagging window ends
    thumb_hour = settings.JOB_END_HOUR
    thumb_minute = settings.JOB_END_MINUTE + 30
    if thumb_minute >= 60:
        thumb_hour = (thumb_hour + (thumb_minute // 60)) % 24
        thumb_minute = thumb_minute % 60

    _scheduler.add_job(
        func=lambda: _run_tool_bg("generate_thumbnails"),
        trigger=CronTrigger(hour=thumb_hour, minute=thumb_minute, timezone=settings.TIMEZONE),
        id="nightly_generate_thumbnails",
        name="Nightly thumbnail generation",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    _scheduler.start()
    logger.info(
        "[startup] Scheduler started. tag_images cron: '%s', generate_thumbnails at: %02d:%02d (%s)",
        settings.AGENT_CRON,
        thumb_hour,
        thumb_minute,
        settings.TIMEZONE,
    )

    yield  # Application runs here

    # Shutdown
    logger.info("[shutdown] Stopping scheduler …")
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
    close_db()
    logger.info("[shutdown] Agent service stopped.")


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="PersonalCloud Agent",
    description="AI tool runner service — internal use only.",
    version="1.0.0",
    lifespan=lifespan,
    # Disable docs in prod if desired; useful during dev
    docs_url="/docs",
    redoc_url=None,
)

app.include_router(search_router.router)
app.include_router(jobs_router.router)
app.include_router(agent_router.router)


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok", "service": "agent"}
