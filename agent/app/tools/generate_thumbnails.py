import os
import logging
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image

from ..config import settings
from ..db import fetch_all_users
from .base import BaseTool, JobResult

logger = logging.getLogger(__name__)

RAW_EXTENSIONS = {".dng", ".nef", ".cr2", ".cr3", ".arw", ".raf", ".rw2", ".orf", ".pef", ".srw"}

class GenerateThumbnailsTool(BaseTool):
    name = "generate_thumbnails"
    description = (
        "Walks every user's storage directory and generates thumbnails "
        "for images and videos that do not have them."
    )

    def run(self) -> JobResult:
        started = datetime.now(tz=timezone.utc)
        result = JobResult(tool_name=self.name, started_at=started)
        
        try:
            users = fetch_all_users()
            logger.info("[generate_thumbnails] Starting thumbnail generation for %d users", len(users))
            
            for user in users:
                username = user["username"]
                user_root = Path(settings.STORAGE_ROOT) / username
                if not user_root.exists():
                    continue
                
                for root, dirs, files in os.walk(user_root):
                    # Skip hidden directories (including .thumbnails)
                    dirs[:] = [d for d in dirs if not d.startswith(".")]
                    
                    for fname in files:
                        if fname.startswith("."):
                            continue
                        
                        file_path = Path(root) / fname
                        ext = file_path.suffix.lower()
                        
                        is_image = ext in settings.IMAGE_EXTENSIONS
                        is_video = ext in settings.VIDEO_EXTENSIONS
                        
                        if not (is_image or is_video):
                            continue
                        
                        # Compute relative path and expected thumbnail path
                        try:
                            rel_path = file_path.relative_to(user_root)
                        except ValueError:
                            continue
                            
                        thumb_dir = user_root / ".thumbnails" / rel_path.parent
                        thumb_path = thumb_dir / f"{file_path.name}.thumb.jpg"
                        
                        if thumb_path.exists():
                            result.files_skipped += 1
                            continue
                            
                        # Generate thumbnail
                        os.makedirs(thumb_dir, exist_ok=True)
                        success = False
                        try:
                            if is_image:
                                if ext in RAW_EXTENSIONS:
                                    import rawpy
                                    with rawpy.imread(str(file_path)) as raw:
                                        rgb = raw.postprocess()
                                    img = Image.fromarray(rgb)
                                else:
                                    img = Image.open(str(file_path))
                                
                                img = img.convert("RGB")
                                w, h = img.size
                                if w > 400:
                                    ratio = 400 / w
                                    new_h = int(h * ratio)
                                    img = img.resize((400, new_h), Image.LANCZOS)
                                img.save(str(thumb_path), "JPEG", quality=82)
                                success = True
                            elif is_video:
                                cmd = [
                                    "ffmpeg", "-y",
                                    "-ss", "00:00:00.000",
                                    "-i", str(file_path),
                                    "-vframes", "1",
                                    "-vf", "scale=400:-1",
                                    "-f", "image2",
                                    str(thumb_path)
                                ]
                                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                                success = True
                                
                            if success:
                                result.files_processed += 1
                                logger.debug("[generate_thumbnails] Created thumbnail for %s", rel_path)
                        except Exception as e:
                            err_msg = f"Failed to generate thumbnail for {rel_path}: {e}"
                            result.errors.append(err_msg)
                            logger.warning("[generate_thumbnails] %s", err_msg)
                            
        except Exception as e:
            result.errors.append(f"Fatal error in thumbnail generation: {e}")
            logger.error("[generate_thumbnails] Fatal: %s", e)
            
        result.finished_at = datetime.now(tz=timezone.utc)
        logger.info(
            "[generate_thumbnails] Finished — processed=%d skipped=%d errors=%d",
            result.files_processed,
            result.files_skipped,
            len(result.errors),
        )
        return result
