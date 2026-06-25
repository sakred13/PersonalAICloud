import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_react_agent
from langchain.agents.output_parsers import ReActSingleInputOutputParser
from langchain_core.agents import AgentAction, AgentFinish
from langchain_core.exceptions import OutputParserException
from langchain_core.prompts import PromptTemplate
from ..config import settings
from ..tools.conversion_tools import get_conversion_tools

logger = logging.getLogger(__name__)

class CustomReActSingleInputOutputParser(ReActSingleInputOutputParser):
    def parse(self, text: str):
        try:
            return super().parse(text)
        except OutputParserException as e:
            if "Action:" not in text and "Final Answer:" not in text:
                cleaned_text = text
                if cleaned_text.startswith("Thought:"):
                    cleaned_text = cleaned_text[len("Thought:"):].strip()
                return AgentFinish({"output": cleaned_text}, text)
            raise e

router = APIRouter(prefix="/api/agent", tags=["agent"])

_TEMPLATE = """You are the AI Cloud Assistant. You have access to the user's storage root folder.
You help users manage, audit, and convert their files (DNG images, JPEGs, PNGs, MP4 videos, Excel worksheets, PDFs, etc.). Speak naturally as an assistant without mentioning your tools, APIs, or inner workings (e.g. say "I don't have that ability right now" instead of "My tools don't support it").

If a user asks about what conversions they can perform in a folder, check what files are in the target directory using list_directory, and recommend formats they can convert to:
- RAW Images (DNG, NEF, CR2, CR3, ARW, RAF, etc.) can be converted to JPEG, PNG, or WEBP.
- Standard Images (JPEG, PNG, WEBP, BMP, etc.) can be converted to JPEG, PNG, or WEBP.
- Videos (MP4, MOV, MKV, AVI, WebM) can be transcoded to other video formats (like MP4, WebM).
- Excel worksheets (XLSX, XLS) can be converted to CSV.
- PDFs can be stitched together with selected page ranges.

You have access to the following tools:

{tools}

Use the following format strictly:

Thought: you should always think about what to do and list out the tools you would need to achieve it, and fetch the contracts of only those tools that you need to use.
Action: the action to take, should be exactly one of [{tool_names}]. Do NOT put "Final Answer" here.
Action Input: the input to the action (must be formatted exactly as required by the tool, e.g., JSON list of files or folder string)
Observation: the result of the action
... (this Thought/Action/Action Input/Observation can repeat N times)
Thought: I have completed all necessary actions and know the final answer.
Final Answer: the final response to the user. This must be written as regular text, NOT as an Action Input.

Example of handling tool errors:
Thought: I need to send an email, but I don't know the schema. I will fetch the contract first.
Action: fetch_tool_contracts
Action Input: ["send_email"]
Observation: {{ "send_email": {{ "schema": {{ "to_email": "string", "subject": "string", "body": "string" }} }} }}
Thought: Now I have the schema. I will send the email.
Action: send_email
Action Input: {{"to_email": "test@example.com", "subject": "Hello", "body": "Hi"}}
Observation: Error: SMTP authentication failed.
Thought: The email failed to send due to authentication. I will inform the user.
Final Answer: I apologize, but I could not send the email because your SMTP credentials in the Secrets Vault are incorrect.

CRITICAL RULE: "Final Answer" is NOT a tool. When you are ready to respond to the user (even if a tool fails or returns an error), stop using the "Action:" line completely, and instead use the "Final Answer:" prefix.

Begin!

User Prompt: {input}
References: {references}
History: {chat_history}
{agent_scratchpad}"""

class ChatRequest(BaseModel):
    username: str
    user_id: int
    message: str
    references: list[str]
    history: list[dict]
    secrets: dict[str, str] = {}

@router.post("/chat")
async def chat_with_agent(req: ChatRequest):
    try:
        # Get tools bound to this user
        tools = get_conversion_tools(req.username, req.user_id, req.secrets)
        
        llm = ChatOpenAI(
            base_url=settings.LLM_BASE_URL,
            api_key=settings.LLM_API_KEY,
            model=settings.LLM_MODEL,
            temperature=0.1,
            max_tokens=2048,
            stop=["\nObservation:", "\n\tObservation:", "Observation:", "\nobservation:", "observation:"]
        )
        
        prompt = PromptTemplate.from_template(_TEMPLATE)
        agent = create_react_agent(llm, tools, prompt, output_parser=CustomReActSingleInputOutputParser())
        executor = AgentExecutor(
            agent=agent,
            tools=tools,
            verbose=True,
            handle_parsing_errors=True,
            max_iterations=8
        )
        
        # Format history into a string
        history_str = ""
        # Exclude last item if it's the user's latest prompt
        history_items = req.history[:-1] if len(req.history) > 0 else []
        for h in history_items:
            role = "User" if h["role"] == "user" else "Assistant"
            history_str += f"{role}: {h['content']}\n"
            
        result = executor.invoke({
            "input": req.message,
            "references": ", ".join(req.references) if req.references else "None attached",
            "chat_history": history_str,
        })
        
        reply = result.get("output", "Sorry, I encountered an issue processing your request.")
        return {"reply": reply}
    except Exception as err:
        logger.error(f"[agent/chat] Error: {err}")
        return {"reply": f"An error occurred in the agent: {err}"}
