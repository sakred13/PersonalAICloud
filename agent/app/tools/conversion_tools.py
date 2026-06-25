import os
import subprocess
from pathlib import Path
from PIL import Image
from io import BytesIO
import pypdf
import pandas as pd
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage
from ..config import settings
from .media_processor import (
    get_llm,
    encode_image,
    transcribe_audio,
    get_video_metadata,
    extract_keyframes,
    extract_audio,
    extract_text_from_pdf,
    extract_text_from_txt,
)

def get_conversion_tools(username: str, user_id: int, secrets: dict[str, str] = None) -> list:
    if secrets is None:
        secrets = {}
    user_root = Path(settings.STORAGE_ROOT) / username

    def resolve_input_files(file_list: list[str]) -> list[str]:
        resolved = []
        for f in file_list:
            if isinstance(f, str) and f.startswith(".manifest_") and f.endswith(".json"):
                manifest_path = (user_root / f).resolve()
                if manifest_path.exists() and str(manifest_path).startswith(str(user_root.resolve())):
                    try:
                        import json
                        paths = json.loads(manifest_path.read_text())
                        if isinstance(paths, list):
                            resolved.extend(paths)
                            continue
                    except Exception:
                        pass
            resolved.append(f)
        return resolved

    
    @tool
    def search_by_topic(keyword: str) -> str:
        """
        Search for files in user storage related to a specific topic.
        Writes the matching files to a unique manifest file and returns a summary to avoid overflowing context window.
        Example inputs (Always singular): 'cat', 'plant', 'dog', 'vacation'
        """
        import uuid
        import json
        from ..db import search_tags
        
        try:
            results = search_tags(user_id, keyword)
            paths = [r["file_path"] for r in results]
            
            if not paths:
                return f"No files found matching the search query '{keyword}'."
                
            # Create a unique manifest file in user's root storage
            manifest_name = f".manifest_{uuid.uuid4().hex[:8]}.json"
            manifest_abs = (user_root / manifest_name).resolve()
            
            # Ensure safety
            if not str(manifest_abs).startswith(str(user_root.resolve())):
                return "Error: Access denied (path traversal prevented)."
                
            manifest_abs.write_text(json.dumps(paths))
            
            # Clean up paths to display first 5
            preview = ", ".join(paths[:5])
            if len(paths) > 5:
                preview += f" and {len(paths) - 5} more files"
                
            return f"Found {len(paths)} file(s) matching '{keyword}' ({preview}). The full list has been saved to the manifest file '{manifest_name}' (has a period at the start of the name). You can pass this manifest file to other tools."
        except Exception as e:
            return f"Error executing tag search: {e}"

    @tool
    def list_directory(path: str = "") -> str:
        """
        List files and directories in a specific path inside your private cloud storage.
        The path parameter must be relative to the storage root (e.g., "", "Photos", "Documents").
        Returns a textual description of the folder contents.
        """
        target_dir = (user_root / path.strip("/")).resolve()
        # Path safety check
        try:
            if not str(target_dir).startswith(str(user_root.resolve())):
                return "Error: Access denied (directory traversal prevented)."
        except Exception:
            return "Error: Invalid path."

        if not target_dir.exists():
            return f"Error: Path '{path}' does not exist."
        if not target_dir.is_dir():
            return f"Error: Path '{path}' is a file, not a directory."

        try:
            entries = os.listdir(target_dir)
            files = []
            folders = []
            for entry in entries:
                if entry.startswith("."):
                    continue
                entry_path = target_dir / entry
                if entry_path.is_dir():
                    folders.append(entry)
                else:
                    files.append(entry)
            
            display_path = path if path else "root"
            output = [f"Contents of '{display_path}':"]
            if folders:
                output.append("Folders:")
                for f in sorted(folders):
                    output.append(f"  - {f}/")
            if files:
                output.append("Files:")
                for f in sorted(files):
                    size = (target_dir / f).stat().st_size
                    output.append(f"  - {f} ({size} bytes)")
            if not folders and not files:
                output.append("  (empty directory)")
            return "\n".join(output)
        except Exception as e:
            return f"Error listing directory: {e}"

    @tool
    def convert_files(arguments: str) -> str:
        """
        Convert multiple files of a specific source format/extension to a target format/extension in batch.
        The input parameter must be a JSON string. If you do not know the JSON schema contract, you MUST call fetch_tool_contracts first to retrieve it.
        """
        import json
        try:
            cleaned = arguments.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            data = json.loads(cleaned)
            file_paths = data.get("file_paths", [])
            source_extension = data.get("source_extension", "")
            target_extension = data.get("target_extension", "")
        except Exception as e:
            return f"Error: Action Input must be a valid JSON string. Details: {e}. Provided input: {arguments}"

        results = []
        success_count = 0
        
        # Normalize extensions
        src_ext = source_extension.lower().strip()
        if not src_ext.startswith("."):
            src_ext = "." + src_ext
        tgt_ext = target_extension.lower().strip()
        if not tgt_ext.startswith("."):
            tgt_ext = "." + tgt_ext

        for rel_path in resolve_input_files(file_paths):
            src_abs = (user_root / rel_path.strip("/")).resolve()
            # Path safety check
            if not str(src_abs).startswith(str(user_root.resolve())):
                results.append(f"{rel_path}: Access denied (path traversal).")
                continue
            if not src_abs.exists():
                results.append(f"{rel_path}: File does not exist.")
                continue

            # Compute output path
            parent_dir = src_abs.parent
            filename = src_abs.stem
            dest_abs = parent_dir / f"{filename}{tgt_ext}"
            dest_rel = str(dest_abs.relative_to(user_root)).replace("\\", "/")

            if src_abs == dest_abs:
                results.append(f"{rel_path}: Source and destination are identical.")
                continue

            try:
                # ─── Image Conversion ───
                if src_ext in [".dng", ".nef", ".cr2", ".cr3", ".arw", ".raf"] and tgt_ext in [".jpg", ".jpeg", ".png", ".webp"]:
                    import rawpy
                    with rawpy.imread(str(src_abs)) as raw:
                        rgb = raw.postprocess()
                    img = Image.fromarray(rgb)
                    # Convert to RGB mode if target is jpeg
                    if tgt_ext in [".jpg", ".jpeg"] and img.mode != "RGB":
                        img = img.convert("RGB")
                    img.save(str(dest_abs))
                    results.append(f"{rel_path} → {dest_rel} (Successfully converted RAW to Image)")
                    success_count += 1
                elif src_ext in [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"] and tgt_ext in [".jpg", ".jpeg", ".png", ".webp"]:
                    img = Image.open(str(src_abs))
                    if tgt_ext in [".jpg", ".jpeg"] and img.mode != "RGB":
                        img = img.convert("RGB")
                    img.save(str(dest_abs))
                    results.append(f"{rel_path} → {dest_rel} (Successfully converted)")
                    success_count += 1
                
                # ─── Video Conversion ───
                elif src_ext in [".mp4", ".mov", ".mkv", ".avi", ".webm"] and tgt_ext in [".mp4", ".mov", ".mkv", ".avi", ".webm"]:
                    # Limit threads to 2 and run ffmpeg
                    cmd = [
                        "ffmpeg", "-y", "-i", str(src_abs),
                        "-threads", "2", "-c:v", "libx264",
                        "-preset", "superfast", str(dest_abs)
                    ]
                    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    results.append(f"{rel_path} → {dest_rel} (Successfully transcoded video)")
                    success_count += 1

                # ─── Document Conversion (Excel to CSV) ───
                elif src_ext in [".xlsx", ".xls"] and tgt_ext == ".csv":
                    df = pd.read_excel(str(src_abs))
                    df.to_csv(str(dest_abs), index=False)
                    results.append(f"{rel_path} → {dest_rel} (Successfully converted Excel to CSV)")
                    success_count += 1
                else:
                    results.append(f"{rel_path}: Unsupported conversion from {src_ext} to {tgt_ext}.")
            except Exception as e:
                results.append(f"{rel_path}: Failed conversion ({e}).")

        return f"Converted {success_count}/{len(file_paths)} files.\nDetails:\n" + "\n".join(results)

    @tool
    def stitch_pdfs(arguments: str) -> str:
        """
        Merge/Stitch specific pages from multiple PDF files into a single output PDF.
        The input parameter must be a JSON string. If you do not know the JSON schema contract, you MUST call fetch_tool_contracts first to retrieve it.
        """
        import json
        try:
            cleaned = arguments.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            data = json.loads(cleaned)
            file_paths = data.get("file_paths", [])
            output_name = data.get("output_name", "")
        except Exception as e:
            return f"Error: Action Input must be a valid JSON string. Details: {e}. Provided input: {arguments}"

        if not output_name.lower().endswith(".pdf"):
            output_name += ".pdf"
            
        output_abs = (user_root / output_name.strip("/")).resolve()
        # Path safety check
        if not str(output_abs).startswith(str(user_root.resolve())):
            return "Error: Access denied (output path traversal prevented)."

        try:
            merger = pypdf.PdfWriter()
            details = []
            
            for item in file_paths:
                rel_file = item.get("file", item.get("file_path", ""))
                pages = item.get("pages", item.get("page_range", []))
                
                # Normalize pages to list
                if isinstance(pages, str):
                    if "," in pages:
                        pages = [p.strip() for p in pages.split(",")]
                    else:
                        pages = [pages]
                elif isinstance(pages, int):
                    pages = [pages]
                elif not isinstance(pages, list):
                    pages = []
                
                src_abs = (user_root / rel_file.strip("/")).resolve()
                if not str(src_abs).startswith(str(user_root.resolve())):
                    details.append(f"{rel_file}: Access denied (path traversal). Skipping.")
                    continue
                if not src_abs.exists():
                    details.append(f"{rel_file}: File does not exist. Skipping.")
                    continue
                if not src_abs.suffix.lower() == ".pdf":
                    details.append(f"{rel_file}: File is not a PDF. Skipping.")
                    continue

                if pages and len(pages) > 0:
                    reader = pypdf.PdfReader(str(src_abs))
                    writer = pypdf.PdfWriter()
                    added_pages = []
                    for p_num in pages:
                        idx = int(p_num) - 1 # Convert to 0-indexed
                        if 0 <= idx < len(reader.pages):
                            writer.add_page(reader.pages[idx])
                            added_pages.append(p_num)
                    
                    if len(added_pages) > 0:
                        temp_bio = BytesIO()
                        writer.write(temp_bio)
                        temp_bio.seek(0)
                        merger.append(temp_bio)
                        details.append(f"{rel_file} (Pages: {added_pages})")
                    else:
                        details.append(f"{rel_file} (No valid pages found. Skipping)")
                else:
                    merger.append(str(src_abs))
                    details.append(f"{rel_file} (All pages)")

            os.makedirs(output_abs.parent, exist_ok=True)
            merger.write(str(output_abs))
            merger.close()
            
            dest_rel = str(output_abs.relative_to(user_root)).replace("\\", "/")
            return f"Stitched PDFs successfully to '{dest_rel}'.\nStitch Order:\n" + "\n".join(details)
        except Exception as e:
            return f"Error stitching PDFs: {e}"

    @tool
    def describe_photo(file_path: str) -> str:
        """
        Analyse and describe the contents of a photo/image file in detail.
        Supports standard images (JPEG, PNG, WEBP, BMP, etc.) and RAW formats (DNG, NEF, CR2, CR3, ARW, RAF).
        The file_path parameter must be relative to the storage root (e.g., "Photos/Mom Bday/IMG_5731.dng").
        Returns a detailed description of the photo's subjects, actions, colors, and overall scene.
        """
        target_path = (user_root / file_path.strip("/")).resolve()
        # Path safety check
        try:
            if not str(target_path).startswith(str(user_root.resolve())):
                return "Error: Access denied (path traversal prevented)."
        except Exception:
            return "Error: Invalid path."

        if not target_path.exists():
            return f"Error: File '{file_path}' does not exist."
        if target_path.is_dir():
            return f"Error: Path '{file_path}' is a directory, not a file."

        ext = target_path.suffix.lower()
        if ext not in settings.IMAGE_EXTENSIONS:
            return f"Error: File extension '{ext}' is not supported for photos. Supported: {', '.join(settings.IMAGE_EXTENSIONS)}"

        try:
            b64 = encode_image(str(target_path))
            prompt = (
                "Describe this photo in detail. Identify the main subjects, people, "
                "objects, colors, setting (e.g. indoor/outdoor, place), mood, and "
                "any visible text or signs. Be comprehensive, descriptive, and return a clean paragraph."
            )
            message = HumanMessage(
                content=[
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                    },
                ]
            )
            response = get_llm().invoke([message])
            return response.content.strip()
        except Exception as e:
            return f"Error analyzing photo: {e}"

    @tool
    def describe_audio(file_path: str) -> str:
        """
        Analyse and describe the contents of an audio or music file in detail.
        Supports audio formats (MP3, WAV, M4A, FLAC, OGG, AAC).
        The file_path parameter must be relative to the storage root (e.g., "Audio/lecture.mp3").
        Returns a detailed transcription and summary/description of the spoken content and topics.
        """
        target_path = (user_root / file_path.strip("/")).resolve()
        # Path safety check
        try:
            if not str(target_path).startswith(str(user_root.resolve())):
                return "Error: Access denied (path traversal prevented)."
        except Exception:
            return "Error: Invalid path."

        if not target_path.exists():
            return f"Error: File '{file_path}' does not exist."
        if target_path.is_dir():
            return f"Error: Path '{file_path}' is a directory, not a file."

        ext = target_path.suffix.lower()
        if ext not in settings.AUDIO_EXTENSIONS:
            return f"Error: File extension '{ext}' is not supported for audio. Supported: {', '.join(settings.AUDIO_EXTENSIONS)}"

        try:
            transcript = transcribe_audio(str(target_path))
            if not transcript:
                return "No spoken words could be detected or transcribed in the audio file."

            prompt = (
                "Below is the transcript of an audio recording/file. "
                "Provide a detailed summary and description of what is being discussed, "
                "the main topics, the tone or context of the conversation, and any key takeaways. "
                "Format your description in a clean, conversational paragraph.\n\n"
                f"Transcript:\n{transcript}"
            )
            message = HumanMessage(content=prompt)
            response = get_llm().invoke([message])
            return f"Audio Transcript:\n\"{transcript}\"\n\nAnalysis/Description:\n{response.content.strip()}"
        except Exception as e:
            return f"Error analyzing audio: {e}"

    @tool
    def describe_video(file_path: str) -> str:
        """
        Analyse and describe the contents of a video file in detail by processing both visual keyframes and audio.
        Supports video formats (MP4, MOV, MKV, AVI, M4V, WEBM, FLV).
        The file_path parameter must be relative to the storage root (e.g., "Videos/vacation.mp4").
        Returns a detailed summary of both visual scenes and spoken audio content.
        """
        target_path = (user_root / file_path.strip("/")).resolve()
        # Path safety check
        try:
            if not str(target_path).startswith(str(user_root.resolve())):
                return "Error: Access denied (path traversal prevented)."
        except Exception:
            return "Error: Invalid path."

        if not target_path.exists():
            return f"Error: File '{file_path}' does not exist."
        if target_path.is_dir():
            return f"Error: Path '{file_path}' is a directory, not a file."

        ext = target_path.suffix.lower()
        if ext not in settings.VIDEO_EXTENSIONS:
            return f"Error: File extension '{ext}' is not supported for videos. Supported: {', '.join(settings.VIDEO_EXTENSIONS)}"

        try:
            # Metadata checks/guardrails
            duration, file_size = get_video_metadata(str(target_path))
            if file_size > settings.MAX_VIDEO_SIZE:
                return f"Error: Video file size ({file_size // 1024 // 1024} MB) exceeds the maximum limit of {settings.MAX_VIDEO_SIZE // 1024 // 1024} MB."
            if duration > settings.MAX_VIDEO_DURATION:
                return f"Error: Video duration ({int(duration)} seconds) exceeds the maximum limit of {settings.MAX_VIDEO_DURATION} seconds."

            # 1. Process visual track by describing keyframes
            keyframe_paths = extract_keyframes(str(target_path), duration)
            frame_descriptions = []
            for i, kf in enumerate(keyframe_paths):
                try:
                    b64 = encode_image(kf)
                    prompt = f"Describe the visual details of this keyframe (Frame {i+1} of {len(keyframe_paths)}) from a video."
                    message = HumanMessage(
                        content=[
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                            },
                        ]
                    )
                    res = get_llm().invoke([message])
                    frame_descriptions.append(f"Frame {i+1}: {res.content.strip()}")
                except Exception as kf_err:
                    frame_descriptions.append(f"Frame {i+1}: (failed to analyze: {kf_err})")
                finally:
                    if os.path.exists(kf):
                        try:
                            os.remove(kf)
                        except Exception:
                            pass

            # 2. Process audio track by transcribing and summarizing
            audio_path = extract_audio(str(target_path))
            transcript = ""
            if audio_path:
                try:
                    transcript = transcribe_audio(audio_path)
                finally:
                    if os.path.exists(audio_path):
                        try:
                            os.remove(audio_path)
                        except Exception:
                            pass

            # 3. Combine visual descriptions and transcript to get a unified summary
            frames_str = "\n".join(frame_descriptions)
            transcript_str = transcript if transcript else "(No spoken words detected or transcribed)"
            
            prompt = (
                "You are analyzing a video. We have extracted keyframes and described them, "
                "and transcribed the audio track. Combine these sources of information to "
                "provide a cohesive, detailed description of the video. Summarize what happens "
                "visually, what is discussed or heard in the audio, and what the overall "
                "topic, setting, and flow of the video are. Format your response in a clean, conversational layout.\n\n"
                f"Keyframe Visual Descriptions:\n{frames_str}\n\n"
                f"Audio Transcript:\n{transcript_str}"
            )
            message = HumanMessage(content=prompt)
            response = get_llm().invoke([message])
            return response.content.strip()
        except Exception as e:
            return f"Error analyzing video: {e}"

    @tool
    def describe_document(file_path: str) -> str:
        """
        Analyse and describe the contents of a document file in detail.
        Supports document formats (PDF, TXT, MD, CSV, JSON, XML).
        The file_path parameter must be relative to the storage root (e.g., "Documents/invoice.pdf").
        Returns a detailed description and summary of the document's key subjects, points, and findings.
        """
        target_path = (user_root / file_path.strip("/")).resolve()
        # Path safety check
        try:
            if not str(target_path).startswith(str(user_root.resolve())):
                return "Error: Access denied (path traversal prevented)."
        except Exception:
            return "Error: Invalid path."

        if not target_path.exists():
            return f"Error: File '{file_path}' does not exist."
        if target_path.is_dir():
            return f"Error: Path '{file_path}' is a directory, not a file."

        ext = target_path.suffix.lower()
        if ext not in settings.DOCUMENT_EXTENSIONS:
            return f"Error: File extension '{ext}' is not supported for documents. Supported: {', '.join(settings.DOCUMENT_EXTENSIONS)}"

        try:
            if ext == ".pdf":
                text = extract_text_from_pdf(str(target_path))
            else:
                text = extract_text_from_txt(str(target_path))
            
            if not text:
                return "The document is empty or text could not be extracted."

            # Truncate text to a safe context size (e.g., 2000 characters / ~500 tokens)
            truncated_text = text[:2000]
            
            prompt = (
                "Below is the text extracted from a document. "
                "Provide a detailed summary and description of what the document is about, "
                "its key points, subjects, and any important entities, names, or numbers mentioned. "
                "Format your description in a clean, conversational paragraph.\n\n"
                f"Document text:\n{truncated_text}"
            )
            message = HumanMessage(content=prompt)
            response = get_llm().invoke([message])
            return response.content.strip()
        except Exception as e:
            return f"Error analyzing document: {e}"

    @tool
    def zip_files(arguments: str) -> str:
        """
        Create a ZIP archive of specified files and/or folders recursively.
        The input parameter must be a JSON string. If you do not know the JSON schema contract, you MUST call fetch_tool_contracts first to retrieve it.
        """
        import json
        import zipfile
        try:
            cleaned = arguments.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            data = json.loads(cleaned)
            file_paths = data.get("file_paths", [])
            output_zip_path = data.get("output_zip_path", "")
        except Exception as e:
            return f"Error: Action Input must be a valid JSON string. Details: {e}. Provided input: {arguments}"

        if not output_zip_path:
            return "Error: output_zip_path is required."

        if not output_zip_path.lower().endswith(".zip"):
            output_zip_path += ".zip"

        output_abs = (user_root / output_zip_path.strip("/")).resolve()
        # Path safety check
        if not str(output_abs).startswith(str(user_root.resolve())):
            return "Error: Access denied (output path traversal prevented)."

        # Ensure parent directory exists
        os.makedirs(output_abs.parent, exist_ok=True)

        success_files = []
        failed_files = []

        try:
            with zipfile.ZipFile(output_abs, 'w', zipfile.ZIP_DEFLATED) as zip_file:
                for rel_path in resolve_input_files(file_paths):
                    src_abs = (user_root / rel_path.strip("/")).resolve()
                    # Path safety check
                    if not str(src_abs).startswith(str(user_root.resolve())):
                        failed_files.append(f"{rel_path} (Access denied)")
                        continue
                    if not src_abs.exists():
                        failed_files.append(f"{rel_path} (File/folder does not exist)")
                        continue

                    if src_abs.is_file():
                        arcname = str(src_abs.relative_to(user_root)).replace("\\", "/")
                        zip_file.write(src_abs, arcname)
                        success_files.append(rel_path)
                    elif src_abs.is_dir():
                        for root, dirs, files in os.walk(src_abs):
                            for file in files:
                                file_abs = Path(root) / file
                                arcname = str(file_abs.relative_to(user_root)).replace("\\", "/")
                                zip_file.write(file_abs, arcname)
                        success_files.append(f"{rel_path}/ (Directory zipped recursively)")

            dest_rel = str(output_abs.relative_to(user_root)).replace("\\", "/")
            summary = f"Successfully created ZIP archive at '{dest_rel}' containing {len(success_files)} item(s)."
            if failed_files:
                summary += "\nFailed items:\n" + "\n".join(failed_files)
            return summary
        except Exception as e:
            return f"Error creating ZIP archive: {e}"

    @tool
    def fetch_tool_contracts(tools: str) -> str:
        """
        Fetch the detailed JSON argument schema contracts for specific tools.
        Use this tool when you need to call convert_files, stitch_pdfs, or zip_files,
        but do not know their required JSON fields.
        The input parameter must be a JSON list of strings (e.g., ["convert_files", "zip_files"]) or a comma-separated list of tool names.
        Returns a JSON object mapping each tool name to its required argument schema.
        """
        import json
        
        contracts = {
            "convert_files": {
                "description": "Convert multiple files of a specific source format/extension to a target format/extension in batch.",
                "argument_format": "JSON string",
                "schema": {
                    "file_paths": "list of strings (paths relative to storage root, e.g. ['Photos/Mom Bday/IMG_5731.dng'])",
                    "source_extension": "string (the extension to convert from, e.g. '.dng')",
                    "target_extension": "string (the extension to convert to, e.g. '.jpg')"
                }
            },
            "stitch_pdfs": {
                "description": "Merge/Stitch specific pages from multiple PDF files into a single output PDF.",
                "argument_format": "JSON string",
                "schema": {
                    "file_paths": "list of dicts, each with 'file' (string path) and 'pages' (list of page numbers, e.g., [1,2,3])",
                    "output_name": "string (path to output PDF relative to storage root, e.g., 'Documents/stitched.pdf')"
                }
            },
            "zip_files": {
                "description": "Create a ZIP archive of specified files and/or folders recursively.",
                "argument_format": "JSON string",
                "schema": {
                    "file_paths": "list of strings (paths of files/folders relative to storage root, e.g., ['Photos/Mom Bday/IMG_5731.dng', 'Documents/work_folder'])",
                    "output_zip_path": "string (path to output zip relative to storage root, e.g., 'Archives/photos_backup.zip')"
                }
            },
            "send_email": {
                "description": "Send an email to a recipient.",
                "argument_format": "JSON string",
                "schema": {
                    "to_email": "string (recipient email address, e.g., 'recipient@example.com')",
                    "subject": "string (email subject line)",
                    "body": "string (detailed email body text)",
                    "attachments": "list of strings (optional, paths of files in your storage root to attach to the email, e.g., ['Documents/report.pdf'])"
                }
            },
            "search_by_topic": {
                "description": "Search for files related to a specific topic and save them to a manifest file.",
                "argument_format": "plain string keyword (e.g. 'animal') Keep the keyword singular ('animal' and not 'animals' ) to get the right results",
            }
        }
        
        resolved_tools = []
        if isinstance(tools, str):
            try:
                cleaned = tools.strip()
                if cleaned.startswith("[") and cleaned.endswith("]"):
                    resolved_tools = json.loads(cleaned)
                elif "," in cleaned:
                    resolved_tools = [x.strip() for x in cleaned.split(",")]
                else:
                    resolved_tools = [cleaned]
            except Exception:
                resolved_tools = [tools]
        elif isinstance(tools, list):
            resolved_tools = tools
        else:
            resolved_tools = []

        result = {}
        for t in resolved_tools:
            name = t.strip()
            if name in contracts:
                result[name] = contracts[name]
            else:
                result[name] = "No detailed JSON contract required or tool not found."
                
        return json.dumps(result, indent=2)

    @tool
    def send_email(arguments: str) -> str:
        """
        Send an email to a recipient.
        The input parameter must be a JSON string. If you do not know the JSON schema contract, you MUST call fetch_tool_contracts first to retrieve it.
        """
        import json
        import smtplib
        import os
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart
        from email.mime.base import MIMEBase
        from email import encoders
        from email.header import Header

        try:
            cleaned = arguments.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            data = json.loads(cleaned)
            to_email = data.get("to_email", "")
            subject = data.get("subject", "")
            body = data.get("body", "")
            attachments = data.get("attachments", [])
        except Exception as e:
            return f"Error: Action Input must be a valid JSON string. Details: {e}. Provided input: {arguments}"

        if not to_email or not subject or not body:
            return "Error: to_email, subject, and body are all required."

        if isinstance(attachments, str):
            attachments = [attachments]
        elif not isinstance(attachments, list):
            attachments = []

        gmail_email = secrets.get("GMAIL_EMAIL")
        gmail_password = secrets.get("GMAIL_APP_PASSWORD")

        if not gmail_email or not gmail_password:
            return "Error: Gmail credentials (GMAIL_EMAIL and GMAIL_APP_PASSWORD) are not configured in your Secrets Vault. Please configure them in the Secrets Vault configuration panel first."

        try:
            # Set up SMTP connection
            smtp_server = "smtp.gmail.com"
            port = 587

            # Create message container
            msg = MIMEMultipart()
            msg["Subject"] = Header(subject, "utf-8")
            msg["From"] = gmail_email
            msg["To"] = to_email

            # Attach text body
            msg.attach(MIMEText(body, "plain", "utf-8"))

            # Process attachments
            failed_attachments = []
            for rel_path in resolve_input_files(attachments):
                file_abs = (user_root / rel_path.strip("/")).resolve()
                # Path safety check
                if not str(file_abs).startswith(str(user_root.resolve())):
                    failed_attachments.append(f"{rel_path} (Access denied)")
                    continue
                if not file_abs.exists():
                    failed_attachments.append(f"{rel_path} (File does not exist)")
                    continue
                if file_abs.is_dir():
                    failed_attachments.append(f"{rel_path} (Is a directory, please zip it first)")
                    continue

                try:
                    attachment = MIMEBase("application", "octet-stream")
                    attachment.set_payload(file_abs.read_bytes())
                    encoders.encode_base64(attachment)
                    attachment.add_header(
                        "Content-Disposition",
                        f"attachment; filename={file_abs.name}",
                    )
                    msg.attach(attachment)
                except Exception as file_err:
                    failed_attachments.append(f"{rel_path} (Error reading/encoding: {file_err})")

            server = smtplib.SMTP(smtp_server, port)
            server.starttls()
            server.login(gmail_email, gmail_password)
            server.sendmail(gmail_email, [to_email], msg.as_string())
            server.quit()

            success_msg = f"Successfully sent email to '{to_email}' with subject '{subject}'."
            if attachments:
                success_msg += f" Attached {len(attachments) - len(failed_attachments)} file(s)."
            if failed_attachments:
                success_msg += "\nFailed to attach items:\n" + "\n".join(failed_attachments)
            return success_msg
        except smtplib.SMTPAuthenticationError:
            return "Error: SMTP authentication failed. The Gmail address or App Password in your Secrets Vault is incorrect."
        except Exception as e:
            return f"Error: Failed to send email: {e}"

    return [list_directory, convert_files, stitch_pdfs, describe_photo, describe_audio, describe_video, describe_document, zip_files, fetch_tool_contracts, send_email, search_by_topic]


