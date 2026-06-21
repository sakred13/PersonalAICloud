# PersonalAICloud

PersonalAICloud is a secure, private cloud storage web application featuring modern dark-glassmorphism aesthetics, responsive multi-select layouts, folder sharing, and an **AI-powered nightly tagging agent** that processes your images, documents, audio, and videos locally.

---

## 🚀 Features

### 📂 File Management & Collaboration
- **Modern UI**: Styled with premium HSL custom gradients, Outfit typography, and responsive grid/list views.
- **Bulk Actions**: Checkbox-based multi-selection supporting bulk **Delete, Copy, Move, and Download** actions.
- **On-the-Fly Zipping**: Downloading a directory or multiple files dynamically streams them packed inside a `.zip` archive.
- **File/Folder Rename**: Instantly renames files or directories, updating recursive sharing records and AI tag mappings in the database.
- **Folder Sharing**: Secure folder sharing between users with read-only badges for shared folders.
- **Upload Status Indicator**: High-performance progress tracking panel that condenses into a single status when uploading more than 5 files.

### 🤖 Nightly AI Agent (Local Inference)
- **Timezone-Aligned Job**: Configured to run nightly at 2:00 AM (default) local Pacific Time (`America/Los_Angeles`).
- **Vision Model Tagging**: Processes images and PDF document fallbacks using local LLM vision models (e.g. Gemma 4) via an OpenAI-compatible API (LM Studio).
- **Document Tagging**: Selects and parses text from PDF/text documents, feeding the context to the model to generate descriptive tags.
- **Audio Transcribing**: Automatically extracts audio tracks and transcribes speech using a local CPU-optimized Whisper model.
- **Video Tagging & Guardrails**:
  - Automatically skips large videos (>1.5 GB) or long durations (>30 mins) to prevent resource hogging.
  - Spacially extracts keyframe snapshots and transcribes voice to form visual/verbal composite tags.
  - Whisper threads are restricted to prevent WSL2/host machine freezing.
- **AI-Powered Search**: Natural language case-insensitive substring matching against file paths and generated tag arrays.

---

## 🛠 Tech Stack
- **Frontend**: Vite + React, Vanilla CSS, Lucide Icons
- **Backend**: Node.js, Express, Archiver, Multer, pg (PostgreSQL Client)
- **AI Agent**: Python, FastAPI, LangGraph, PyPDF, ffmpeg, Whisper
- **Database**: PostgreSQL (Dockerized)
- **Containerization**: Docker Compose

---

## ⚙️ Project Structure

```
PersonalAICloud/
├── backend/            # Express API Server (Authentication, CRUD, Zipping)
├── frontend/           # Vite + React Client (Glassmorphism layout, multi-select)
├── agent/              # Python FastAPI AI Agent (Nightly batch cron scheduler)
├── db/                 # DB schema (init.sql)
├── storage/            # Root folder for local storage (mounted as volumes)
├── docker-compose.yml  # Docker environment config
└── .env.sample         # Configuration environment variables template
```

---

## 🏁 Getting Started

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [LM Studio](https://lmstudio.ai/) (for hosting local models, or equivalent OpenAI-compatible endpoint)

### Setup & Configuration

1. **Clone the repository** and navigate to the project root:
   ```bash
   git clone https://github.com/your-username/PersonalAICloud.git
   cd PersonalAICloud
   ```

2. **Setup environment variables**:
   Copy `.env.sample` to `.env` and fill in your values:
   ```bash
   cp .env.sample .env
   ```
   *Modify `DB_PASSWORD`, `JWT_SECRET`, and ensure `LLM_BASE_URL` points to your host-running LM Studio instance (defaults to `http://host.docker.internal:1234/v1`).*

3. **LM Studio Model**:
   Load a vision-enabled model (e.g., `google/gemma-4-e4b`) in LM Studio and start the local server on port `1234`.

4. **Build and start the services**:
   ```bash
   docker compose up -d --build
   ```

5. **Access the application**:
   Open [http://localhost](http://localhost) in your browser. Register your primary account or log in to start uploading.

---

## 🌐 Remote Access (Tailscale Self-Hosting)
You can easily transform PersonalAICloud into an actual private cloud accessible securely from anywhere in the world (phone, tablet, laptop) using **Tailscale**:

1. **Install Tailscale** on your host machine (where Docker runs) and your remote devices (e.g. phone, laptop).
2. Keep `COOKIE_SECURE=false` in your `.env` configuration (required for secure session cookies to work over plain HTTP Tailscale URLs).
3. Access your private cloud from any of your devices by navigating to `http://<your-machine-tailscale-ip>` or its Tailscale MagicDNS address.

---

## 🧪 Development & Rebuilds
If you modify source code components, rebuild and restart the Docker containers to apply updates:
```bash
# Rebuild the backend and frontend containers
docker compose build backend frontend

# Restart services in background
docker compose up -d backend frontend
```

---

## 🔒 Security & Privacy
All media processing, file storage, database storage, and AI inference take place **100% locally** on your machine. No data or telemetry leaves your computer.
