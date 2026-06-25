"""
Image Tagging Tool
==================
Uses a LangGraph StateGraph to walk every user's storage directory, send each
untagged (or updated) image to the Gemma 4 vision model running on the host
machine via LM Studio, and persist the returned tags to Postgres.

Graph nodes (linear for now, ready for branching/retry):
  fetch_users → walk_files → filter_new → call_llm → save_tags

To add retry logic later: add a conditional edge from call_llm → retry_node.
To add other media types later: add a parallel branch in walk_files.
"""
import ast
import json
import logging
import os
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import TypedDict

from langchain_core.messages import HumanMessage
from langgraph.graph import END, StateGraph

from ..config import settings
from ..db import fetch_all_users, get_tagged_paths, upsert_tags
from .base import BaseTool, JobResult
from .media_processor import (
    get_llm,
    encode_image,
    extract_text_from_pdf,
    extract_text_from_txt,
    transcribe_audio,
    get_video_metadata,
    extract_keyframes,
    extract_audio,
)

logger = logging.getLogger(__name__)

# ── LangGraph state schema ────────────────────────────────────────────────────

class TaggingState(TypedDict):
    """Mutable state object threaded through every graph node."""
    users: list[dict]                   # [{id, username}, ...]
    # Accumulated per-file work items: {user_id, username, abs_path, rel_path}
    pending: list[dict]
    result: JobResult
    # Hard stop time: computed once at job start, checked after every file.
    # The job always finishes the file it is currently processing before
    # inspecting the clock — it never interrupts mid-LLM-call.
    deadline: datetime


# ── Graph nodes ───────────────────────────────────────────────────────────────

def node_fetch_users(state: TaggingState) -> dict:
    """
    Load all users from the database.
    Also computes the hard deadline for this run: today at JOB_END_HOUR:JOB_END_MINUTE in the configured timezone.
    If the job somehow starts after that hour (e.g. manual trigger), the
    deadline is pushed to the same hour tomorrow so it still gets a full run.
    """
    users = fetch_all_users()
    logger.info("[tag_images] Found %d user(s) to process.", len(users))

    tz = ZoneInfo(settings.TIMEZONE)
    now = datetime.now(tz=tz)
    deadline = now.replace(
        hour=settings.JOB_END_HOUR, minute=settings.JOB_END_MINUTE, second=0, microsecond=0
    )
    # If we're already past today's deadline (e.g. manual trigger at noon),
    # push to the same hour tomorrow so the run isn't dead on arrival.
    if deadline <= now:
        deadline += timedelta(days=1)

    logger.info(
        "[tag_images] Deadline: %s %s (JOB_END_HOUR=%d, JOB_END_MINUTE=%d)",
        deadline.strftime("%H:%M"),
        settings.TIMEZONE,
        settings.JOB_END_HOUR,
        settings.JOB_END_MINUTE,
    )
    return {"users": users, "deadline": deadline}


def node_walk_files(state: TaggingState) -> dict:
    """
    Walk each user's storage directory and collect all files of supported types
    (images, documents, audio). Skips .thumbnails directories and hidden files.
    """
    pending = []
    for user in state["users"]:
        user_dir = Path(settings.STORAGE_ROOT) / user["username"]
        if not user_dir.exists():
            continue
        for root, dirs, files in os.walk(user_dir):
            # Skip hidden dirs (including .thumbnails)
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for fname in files:
                if fname.startswith("."):
                    continue
                ext = Path(fname).suffix.lower()
                
                if ext in settings.IMAGE_EXTENSIONS:
                    file_type = "image"
                elif ext in settings.DOCUMENT_EXTENSIONS:
                    file_type = "document"
                elif ext in settings.AUDIO_EXTENSIONS:
                    file_type = "audio"
                elif ext in settings.VIDEO_EXTENSIONS:
                    file_type = "video"
                else:
                    continue
                    
                abs_path = Path(root) / fname
                # rel_path is relative to STORAGE_ROOT/<username>/
                rel_path = str(abs_path.relative_to(user_dir)).replace("\\", "/")
                pending.append({
                    "user_id": user["id"],
                    "username": user["username"],
                    "abs_path": str(abs_path),
                    "rel_path": rel_path,
                    "type": file_type,
                    "mtime": abs_path.stat().st_mtime,
                })
    logger.info("[tag_images] Found %d file(s) across all users.", len(pending))
    return {"pending": pending}


def node_filter_new(state: TaggingState) -> dict:
    """
    Remove files that are already tagged AND whose mtime hasn't changed since
    the last tagging run. Groups tagged paths by user for efficient lookup.
    """
    # Build a per-user map: {user_id: {rel_path: tagged_at_ts}}
    user_tagged: dict[int, dict[str, float]] = {}
    for user in state["users"]:
        user_tagged[user["id"]] = get_tagged_paths(user["id"])

    filtered = []
    skipped = 0
    for item in state["pending"]:
        tagged = user_tagged.get(item["user_id"], {})
        tagged_ts = tagged.get(item["rel_path"])
        if tagged_ts is not None and item["mtime"] <= tagged_ts:
            skipped += 1
            continue
        filtered.append(item)

    state["result"].files_skipped = skipped
    logger.info(
        "[tag_images] %d to tag, %d already up-to-date.",
        len(filtered), skipped,
    )
    return {"pending": filtered}


_TAG_PROMPT = """You are a photo-tagging assistant. Analyse this image and return ONLY a
JSON array of concise, lowercase, single-word or short-phrase descriptive tags.

Rules:
- Include: subjects (e.g. "car", "dog"), colours ("red"), brands/makes if
  clearly visible ("honda"), scene types ("beach", "indoor"), and dominant
  objects.
- Exclude: generic terms like "photo", "image", "picture".
- Return 5–15 tags.
- Output ONLY valid JSON, e.g.: ["car", "red", "honda", "road", "sunny"]
"""

_DOC_TAG_PROMPT = """You are a document-tagging assistant. Analyse this document text and return ONLY a
JSON array of concise, lowercase, single-word or short-phrase descriptive tags summarizing its key topics, subjects, or document type.

Rules:
- Include: document type (e.g. "invoice", "receipt", "resume", "letter"), primary subjects (e.g. "taxes", "contract", "meeting"), and key organizations/names mentioned.
- Exclude: generic terms like "text", "file", "document", "page".
- Return 5–15 tags.
- Output ONLY valid JSON, e.g.: ["invoice", "taxes", "internal revenue", "2025", "salary"]
"""

_AUDIO_TAG_PROMPT = """You are an audio-tagging assistant. Analyse this audio transcript and return ONLY a
JSON array of concise, lowercase, single-word or short-phrase descriptive tags summarizing the spoken content, topics discussed, or speaker context.

Rules:
- Include: primary topics (e.g. "interview", "tutorial", "meeting", "music"), key entities mentioned, and general categories.
- Exclude: generic terms like "audio", "transcript", "recording", "speech".
- Return 5–15 tags.
- Output ONLY valid JSON, e.g.: ["meeting", "project plan", "quarterly", "marketing", "schedule"]
"""



def _call_text_llm(text_content: str, prompt: str) -> list[str]:
    """Send document/audio text to Gemma 4 and parse the returned tag list."""
    if not text_content:
        return []
    message = HumanMessage(
        content=f"{prompt}\n\nDocument/Transcript text:\n{text_content}"
    )
    response = get_llm().invoke([message])
    raw = response.content.strip()

    # Extract JSON array from the response
    if "```" in raw:
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1:
        raise ValueError(f"No JSON array found in LLM response: {raw[:200]}")
    
    raw_json = raw[start : end + 1]
    try:
        tags = json.loads(raw_json)
    except json.JSONDecodeError:
        try:
            tags = ast.literal_eval(raw_json)
        except Exception as exc:
            raise ValueError(f"Failed to parse LLM response array: {raw_json}. Error: {exc}")
            
    return [str(t).lower().strip() for t in tags if t]


def _call_vision(abs_path: str) -> list[str]:
    """Send a single image to Gemma 4 and parse the returned tag list."""
    b64 = encode_image(abs_path)
    message = HumanMessage(
        content=[
            {"type": "text", "text": _TAG_PROMPT},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            },
        ]
    )
    response = get_llm().invoke([message])
    raw = response.content.strip()

    # Extract JSON array from the response (model may wrap it in markdown)
    if "```" in raw:
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    # Find the first [ ... ] block
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1:
        raise ValueError(f"No JSON array found in LLM response: {raw[:200]}")
    
    raw_json = raw[start : end + 1]
    try:
        tags = json.loads(raw_json)
    except json.JSONDecodeError:
        try:
            tags = ast.literal_eval(raw_json)
        except Exception as exc:
            raise ValueError(f"Failed to parse LLM response array: {raw_json}. Error: {exc}")
            
    return [str(t).lower().strip() for t in tags if t]


def node_call_llm(state: TaggingState) -> dict:
    """
    Call the vision or text LLM (transcribing audio first if needed) for each pending file.

    After every file is fully committed (tags written to DB), the clock is
    checked against the deadline.  If it is at or past the deadline, the loop
    exits cleanly.

    Errors on individual files are recorded but do NOT abort the whole run.
    """
    result = state["result"]
    deadline = state["deadline"]

    for item in state["pending"]:
        try:
            file_type = item["type"]
            abs_path = item["abs_path"]
            ext = Path(abs_path).suffix.lower()

            if file_type == "image":
                tags = _call_vision(abs_path)
            elif file_type == "document":
                if ext == ".pdf":
                    text = extract_text_from_pdf(abs_path)
                else:
                    text = extract_text_from_txt(abs_path)
                
                if text:
                    tags = _call_text_llm(text, _DOC_TAG_PROMPT)
                else:
                    tags = [ext[1:]]  # fallback
            elif file_type == "audio":
                transcript = transcribe_audio(abs_path)
                if transcript:
                    tags = _call_text_llm(transcript, _AUDIO_TAG_PROMPT)
                else:
                    tags = ["audio", ext[1:]]  # fallback
            elif file_type == "video":
                # Metadata check for guardrails
                duration, file_size = get_video_metadata(abs_path)
                if file_size > settings.MAX_VIDEO_SIZE:
                    logger.info("[tag_images] Skipping %s: size %s MB exceeds limit %s MB", 
                                item["rel_path"], file_size // 1024 // 1024, settings.MAX_VIDEO_SIZE // 1024 // 1024)
                    continue
                if duration > settings.MAX_VIDEO_DURATION:
                    logger.info("[tag_images] Skipping %s: duration %s seconds exceeds limit %s seconds", 
                                item["rel_path"], int(duration), settings.MAX_VIDEO_DURATION)
                    continue

                video_tags = set()
                audio_path = ""
                keyframe_paths = []
                try:
                    # 1. Process visual track
                    keyframe_paths = extract_keyframes(abs_path, duration)
                    for kf in keyframe_paths:
                        try:
                            kf_tags = _call_vision(kf)
                            video_tags.update(kf_tags)
                        except Exception as kf_exc:
                            logger.warning("[tag_images] Error tagging keyframe %s: %s", kf, kf_exc)
                    
                    # 2. Process audio track
                    audio_path = extract_audio(abs_path)
                    if audio_path:
                        transcript = transcribe_audio(audio_path)
                        if transcript:
                            try:
                                audio_tags = _call_text_llm(transcript, _AUDIO_TAG_PROMPT)
                                video_tags.update(audio_tags)
                            except Exception as audio_exc:
                                logger.warning("[tag_images] Error tagging audio transcript for %s: %s", abs_path, audio_exc)
                finally:
                    # Clean up temp files
                    if audio_path and os.path.exists(audio_path):
                        try:
                            os.remove(audio_path)
                        except Exception as rm_exc:
                            logger.warning("[tag_images] Error removing temp audio %s: %s", audio_path, rm_exc)
                    for kf in keyframe_paths:
                        if os.path.exists(kf):
                            try:
                                os.remove(kf)
                            except Exception as rm_exc:
                                logger.warning("[tag_images] Error removing temp keyframe %s: %s", kf, rm_exc)
                
                tags = list(video_tags)
                if not tags:
                    tags = ["video", ext[1:]]  # fallback
            else:
                continue


            upsert_tags(item["user_id"], item["rel_path"], tags)
            result.files_processed += 1
            logger.debug("[tag_images] %s → %s", item["rel_path"], tags)
        except Exception as exc:
            msg = f"{item['rel_path']}: {exc}"
            result.errors.append(msg)
            logger.warning("[tag_images] Error: %s", msg)

        # ── Deadline check — runs AFTER the file is fully done ────────────────
        now = datetime.now(tz=ZoneInfo(settings.TIMEZONE))
        if now >= deadline:
            remaining = len(state["pending"]) - state["pending"].index(item) - 1
            logger.info(
                "[tag_images] Deadline reached at %s %s. "
                "Stopping with %d file(s) deferred to tomorrow.",
                now.strftime("%H:%M:%S"),
                settings.TIMEZONE,
                remaining,
            )
            result.extra["stopped_at_deadline"] = True
            result.extra["deferred_files"] = remaining
            break

    return {"result": result}


def node_finalise(state: TaggingState) -> dict:
    """Mark the job as finished."""
    state["result"].finished_at = datetime.now(tz=timezone.utc)
    logger.info(
        "[tag_images] Done — processed=%d skipped=%d errors=%d",
        state["result"].files_processed,
        state["result"].files_skipped,
        len(state["result"].errors),
    )
    return {"result": state["result"]}


# ── Build the LangGraph ───────────────────────────────────────────────────────

def _build_graph():
    g = StateGraph(TaggingState)
    g.add_node("fetch_users",  node_fetch_users)
    g.add_node("walk_files",   node_walk_files)
    g.add_node("filter_new",   node_filter_new)
    g.add_node("call_llm",     node_call_llm)
    g.add_node("finalise",     node_finalise)

    g.set_entry_point("fetch_users")
    g.add_edge("fetch_users", "walk_files")
    g.add_edge("walk_files",  "filter_new")
    g.add_edge("filter_new",  "call_llm")
    g.add_edge("call_llm",    "finalise")
    g.add_edge("finalise",    END)

    return g.compile()


_graph = _build_graph()


# ── Tool class ────────────────────────────────────────────────────────────────

class TagImagesTool(BaseTool):
    name = "tag_images"
    description = (
        "Walks every user's storage, sends untagged/updated images to the "
        "local Gemma 4 vision model, and saves descriptive tags to Postgres."
    )

    def run(self) -> JobResult:
        started = datetime.now(tz=timezone.utc)
        result = JobResult(tool_name=self.name, started_at=started)
        initial_state: TaggingState = {
            "users": [],
            "pending": [],
            "result": result,
            "deadline": datetime.now(tz=timezone.utc),  # overwritten by node_fetch_users
        }
        final_state = _graph.invoke(initial_state)
        return final_state["result"]
