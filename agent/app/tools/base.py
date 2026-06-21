"""
Base interface for all agent tools.

A "tool" in this system is a self-contained unit of work that can be:
  - scheduled via cron (batch job)
  - triggered on demand via the /jobs API
  - eventually wired into a conversational agent graph

To add a new tool:
  1. Create a new file under app/tools/
  2. Subclass BaseTool and implement run()
  3. Register it in app/routers/jobs.py

The LangGraph graph for each tool is built *inside* that tool's run() method,
keeping each tool fully encapsulated while still benefiting from LangGraph's
state management, retry logic, and future branching capabilities.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class JobResult:
    """Standardised return value for any tool run."""
    tool_name: str
    started_at: datetime
    finished_at: datetime | None = None
    files_processed: int = 0
    files_skipped: int = 0
    errors: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def success(self) -> bool:
        return len(self.errors) == 0

    def to_dict(self) -> dict:
        return {
            "tool_name": self.tool_name,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "files_processed": self.files_processed,
            "files_skipped": self.files_skipped,
            "success": self.success,
            "errors": self.errors,
            **self.extra,
        }


class BaseTool(ABC):
    """
    Abstract base class for all agent tools.

    Subclasses must implement:
      - name (str class attribute)
      - description (str class attribute)
      - run() -> JobResult
    """

    name: str = ""
    description: str = ""

    @abstractmethod
    def run(self) -> JobResult:
        """Execute the tool and return a structured result."""
        ...
