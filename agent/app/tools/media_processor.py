import os
import base64
import logging
import tempfile
from io import BytesIO
from pathlib import Path
from PIL import Image

from langchain_openai import ChatOpenAI
from ..config import settings

logger = logging.getLogger(__name__)

# ── Shared LLM Client ─────────────────────────────────────────────────────────
_llm: ChatOpenAI | None = None

def get_llm() -> ChatOpenAI:
    """Lazily initialise the LLM client (once per process)."""
    global _llm
    if _llm is None:
        _llm = ChatOpenAI(
            base_url=settings.LLM_BASE_URL,
            api_key=settings.LLM_API_KEY,
            model=settings.LLM_MODEL,
            temperature=0.1,
            max_tokens=2048,
        )
    return _llm

# ── Image Encoding ────────────────────────────────────────────────────────────
def encode_image(abs_path: str) -> str:
    """
    Resize the image to MAX_IMAGE_SIZE on the longest axis (to keep token
    usage reasonable) and return a base64-encoded JPEG string.
    Supports standard formats via PIL and RAW formats via rawpy.
    """
    ext = Path(abs_path).suffix.lower()
    close_img = False
    if ext in [".dng", ".nef", ".cr2", ".cr3", ".arw", ".raf"]:
        import rawpy
        with rawpy.imread(abs_path) as raw:
            rgb = raw.postprocess()
        img = Image.fromarray(rgb)
        close_img = True
    else:
        img = Image.open(abs_path)
        close_img = True

    try:
        img = img.convert("RGB")
        max_px = settings.MAX_IMAGE_SIZE
        w, h = img.size
        if w > max_px or h > max_px:
            ratio = min(max_px / w, max_px / h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode("utf-8")
    finally:
        if close_img and hasattr(img, "close"):
            try:
                img.close()
            except Exception:
                pass

# ── Text Extraction ───────────────────────────────────────────────────────────
def extract_text_from_pdf(abs_path: str) -> str:
    """Extract up to Settings.MAX_TEXT_CHARS characters from a PDF file."""
    import pypdf
    try:
        reader = pypdf.PdfReader(abs_path)
        text = []
        chars_left = settings.MAX_TEXT_CHARS
        for page in reader.pages:
            t = page.extract_text()
            if t:
                if len(t) > chars_left:
                    text.append(t[:chars_left])
                    break
                else:
                    text.append(t)
                    chars_left -= len(t)
        return "\n".join(text).strip()
    except Exception as exc:
        logger.warning("[media_processor] PDF extraction error on %s: %s", abs_path, exc)
        return ""

def extract_text_from_txt(abs_path: str) -> str:
    """Read up to Settings.MAX_TEXT_CHARS from a plain text/markdown file."""
    try:
        with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read(settings.MAX_TEXT_CHARS).strip()
    except Exception as exc:
        logger.warning("[media_processor] Text extraction error on %s: %s", abs_path, exc)
        return ""

# ── Whisper Transcription ──────────────────────────────────────────────────────
_whisper_model = None

def get_whisper_model():
    """Lazily load the Whisper model on CPU."""
    global _whisper_model
    if _whisper_model is None:
        import whisper
        import torch
        logger.info("[media_processor] Setting PyTorch CPU threads limit to 2 ...")
        torch.set_num_threads(2)
        logger.info("[media_processor] Loading Whisper model '%s' (device=cpu) ...", settings.WHISPER_MODEL)
        _whisper_model = whisper.load_model(settings.WHISPER_MODEL, device="cpu")
    return _whisper_model

def transcribe_audio(abs_path: str) -> str:
    """Transcribe an audio file using Whisper on CPU."""
    try:
        model = get_whisper_model()
        result = model.transcribe(abs_path)
        return result.get("text", "").strip()[:settings.MAX_TEXT_CHARS]
    except Exception as exc:
        logger.warning("[media_processor] Audio transcription error on %s: %s", abs_path, exc)
        return ""

# ── Video & Audio Processing ──────────────────────────────────────────────────
def get_video_metadata(abs_path: str) -> tuple[float, int]:
    """Get video duration in seconds and file size in bytes using ffprobe and os.path."""
    import subprocess
    try:
        file_size = os.path.getsize(abs_path)
        cmd = [
            "ffprobe", "-v", "error", 
            "-show_entries", "format=duration", 
            "-of", "default=noprint_wrappers=1:nokey=1", 
            abs_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        duration = float(result.stdout.strip())
        return duration, file_size
    except Exception as exc:
        logger.warning("[media_processor] Error reading video metadata for %s: %s", abs_path, exc)
        return 0.0, 0

def extract_keyframes(abs_path: str, duration: float) -> list[str]:
    """Extract keyframes as temporary JPEG files and return their paths."""
    import subprocess
    keyframe_paths = []
    if duration <= 0:
        return keyframe_paths
        
    num_frames = settings.VIDEO_KEYFRAMES_COUNT
    timestamps = [duration * (i + 1) / (num_frames + 1) for i in range(num_frames)]
    
    for i, ts in enumerate(timestamps):
        try:
            tmp_fd, tmp_name = tempfile.mkstemp(suffix=f"_frame_{i}.jpg")
            os.close(tmp_fd)
            cmd = [
                "ffmpeg", "-y", 
                "-ss", f"{ts:.3f}", 
                "-i", abs_path, 
                "-frames:v", "1", 
                "-q:v", "2", 
                tmp_name
            ]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            if os.path.exists(tmp_name) and os.path.getsize(tmp_name) > 0:
                keyframe_paths.append(tmp_name)
            else:
                logger.warning("[media_processor] FFmpeg extracted empty keyframe at %s for %s", ts, abs_path)
        except Exception as exc:
            logger.warning("[media_processor] Failed to extract keyframe at %s for %s: %s", ts, abs_path, exc)
    return keyframe_paths

def extract_audio(abs_path: str) -> str:
    """Extract audio track to a temporary MP3 file and return the path."""
    import subprocess
    try:
        tmp_fd, tmp_name = tempfile.mkstemp(suffix="_extracted_audio.mp3")
        os.close(tmp_fd)
        cmd = [
            "ffmpeg", "-y", 
            "-i", abs_path, 
            "-vn", 
            "-acodec", "libmp3lame", 
            "-ar", "16000", 
            "-ac", "1", 
            tmp_name
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        if os.path.exists(tmp_name) and os.path.getsize(tmp_name) > 0:
            return tmp_name
    except Exception as exc:
        logger.warning("[media_processor] Failed to extract audio track from %s: %s", abs_path, exc)
    return ""
