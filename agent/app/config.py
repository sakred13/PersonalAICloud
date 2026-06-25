"""
Centralised configuration for the agent service.
All values come from environment variables so the container can be
reconfigured without a rebuild.
"""
import os


class Settings:
    # ── LLM ─────────────────────────────────────────────────────────────────
    # Base URL of the OpenAI-compatible API (LM Studio on host machine)
    LLM_BASE_URL: str = os.environ.get(
        "LLM_BASE_URL", "http://host.docker.internal:1234/v1"
    )
    # Model identifier as shown in LM Studio
    LLM_MODEL: str = os.environ.get("LLM_MODEL", "google/gemma-4-e4b")
    # LM Studio accepts any non-empty string as an API key
    LLM_API_KEY: str = os.environ.get("LLM_API_KEY", "lm-studio")

    # ── Database ─────────────────────────────────────────────────────────────
    DATABASE_URL: str = os.environ.get(
        "DATABASE_URL",
        "postgresql://clouduser:password@db:5432/personalcloud",
    )

    # ── Storage ──────────────────────────────────────────────────────────────
    STORAGE_ROOT: str = os.environ.get("STORAGE_ROOT", "/storage")

    # ── Scheduler ────────────────────────────────────────────────────────────
    # Standard cron expression for the nightly tag job (default: 2 AM UTC)
    AGENT_CRON: str = os.environ.get("AGENT_CRON", "0 9 * * *")
    # Timezone for the scheduler and deadline checks
    TIMEZONE: str = os.environ.get("TIMEZONE", "America/Los_Angeles")

    # ── Image tagging ────────────────────────────────────────────────────────
    # File extensions the tagger will process
    IMAGE_EXTENSIONS: frozenset = frozenset(
        {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
         ".heic", ".heif", ".dng", ".nef", ".cr2", ".cr3", ".arw", ".raf"}
    )
    DOCUMENT_EXTENSIONS: frozenset = frozenset(
        {".txt", ".md", ".csv", ".json", ".xml", ".pdf"}
    )
    AUDIO_EXTENSIONS: frozenset = frozenset(
        {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"}
    )
    VIDEO_EXTENSIONS: frozenset = frozenset(
        {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm", ".flv"}
    )
    # Max image dimension sent to the LLM (keeps token cost low)
    MAX_IMAGE_SIZE: int = int(os.environ.get("MAX_IMAGE_SIZE", "1024"))
    # Max text characters extracted from documents/transcripts to send to LLM
    MAX_TEXT_CHARS: int = int(os.environ.get("MAX_TEXT_CHARS", "6000"))
    # Whisper model type (tiny, base, etc.)
    WHISPER_MODEL: str = os.environ.get("WHISPER_MODEL", "tiny")
    # Max video duration in seconds to process (default: 30 minutes)
    MAX_VIDEO_DURATION: int = int(os.environ.get("MAX_VIDEO_DURATION", "1800"))
    # Max video size in bytes to process (default: 1.5 GB)
    MAX_VIDEO_SIZE: int = int(os.environ.get("MAX_VIDEO_SIZE", "1610612736"))
    # Number of keyframes to extract from the video for visual tagging
    VIDEO_KEYFRAMES_COUNT: int = int(os.environ.get("VIDEO_KEYFRAMES_COUNT", "3"))
    # Hour at which the batch job must stop (exclusive).
    # The job finishes whatever file it is currently on, then exits.
    # Default: 2:30 AM Pacific → job window is 02:00–02:30 AM Pacific.
    JOB_END_HOUR: int = int(os.environ.get("JOB_END_HOUR", "2"))
    JOB_END_MINUTE: int = int(os.environ.get("JOB_END_MINUTE", "30"))



settings = Settings()
