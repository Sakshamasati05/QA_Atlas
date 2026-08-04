# QAtlas Architecture Documentation

This document describes the system architecture, database models, and communication flows of the QAtlas QA Test Case Generator.

## 1. System Architecture Diagram

Below is the high-level architecture diagram showing the relationship between the React frontend, the Node.js Express backend, the SQLite database layer (via Prisma), and the external AI service integrations.

```mermaid
graph TD
    %% Styling
    classDef frontend fill:#3b82f6,stroke:#1d4ed8,stroke-width:2px,color:#fff;
    classDef backend fill:#8b5cf6,stroke:#6d28d9,stroke-width:2px,color:#fff;
    classDef database fill:#10b981,stroke:#047857,stroke-width:2px,color:#fff;
    classDef ai fill:#f59e0b,stroke:#d97706,stroke-width:2px,color:#fff;
    classDef fallback fill:#ef4444,stroke:#b91c1c,stroke-width:2px,color:#fff;

    %% Nodes
    subgraph Frontend ["React Client (Port 5173)"]
        UI["ChatAssistant Component"]:::frontend
        LS["localStorage (API Keys, Settings)"]:::frontend
        Upload["File Uploader (PDF, DOCX, Code)"]:::frontend
    end

    subgraph Backend ["Node.js & Express Server (Port 5000)"]
        API["API Gateway (server.js)"]:::backend
        DocProc["Document Parser (pdf-parse, mammoth)"]:::backend
        PromptEng["Prompt Engine (buildPromptText)"]:::backend
        Fallback["Heuristic Generator (Offline Fallback)"]:::fallback
    end

    subgraph Database ["SQLite Database Layer"]
        DB["SQLite DB (via Prisma ORM)"]:::database
        Schema["schema.prisma (Workorders, Chats, TestCases)"]:::database
    end

    subgraph AI_Services ["External AI APIs"]
        Gemini["Google Gemini API (free-chatbot)"]:::ai
        Claude["Anthropic Claude API"]:::ai
        GPT["OpenAI ChatGPT API"]:::ai
        Copilot["Microsoft Copilot API"]:::ai
    end

    %% Connections
    UI -->|POST /api/user-stories | API
    Upload -->|Upload Files| DocProc
    DocProc -->|Extracted Text Context| UI
    
    API -->|Read/Write Data| DB
    DB --> Schema
    
    API -->|Prompt & API Key| PromptEng
    PromptEng -->|Provider-specific Calls| Gemini
    PromptEng -->|Provider-specific Calls| Claude
    PromptEng -->|Provider-specific Calls| GPT
    PromptEng -->|Provider-specific Calls| Copilot
    
    %% Fallback Link
    API -->|Fallback if APIs fail / no key| Fallback
    Fallback -->|Regex Heuristic Test Cases| DB
    
    Gemini -.->|JSON Test Cases| API
    Claude -.->|JSON Test Cases| API
    GPT -.->|JSON Test Cases| API
    Copilot -.->|JSON Test Cases| API
```

---

## 2. Component Directory Structure

The repository is divided into two primary workspaces: the React client and the Express server.

*   [start-qatlas.bat](file:///C:/Users/saksham.asati/.gemini/antigravity/scratch/start-qatlas.bat): Startup script configured to spawn both servers concurrently.
*   **React Frontend** [ai-assistant](file:///C:/Users/saksham.asati/.gemini/antigravity/scratch/ai-assistant):
    *   [App.jsx](file:///C:/Users/saksham.asati/.gemini/antigravity/scratch/ai-assistant/src/App.jsx): Root entry point rendering the main UI.
    *   [ChatAssistant.jsx](file:///C:/Users/saksham.asati/.gemini/antigravity/scratch/ai-assistant/src/ChatAssistant.jsx): Orchestrates settings, chat logs, repositories, exports, and manual execution dry-runs.
*   **Express Backend** [workflow-backend](file:///C:/Users/saksham.asati/.gemini/antigravity/scratch/workflow-backend):
    *   [server.js](file:///C:/Users/saksham.asati/.gemini/antigravity/scratch/workflow-backend/server.js): API routing, LLM API client interfaces, local heuristic failover, and PDF/DOCX document text extraction.
    *   [schema.prisma](file:///C:/Users/saksham.asati/.gemini/antigravity/scratch/workflow-backend/prisma/schema.prisma): SQLite structural schema definition.

---

## 3. Database Schema Layout

The relational mapping defined in [schema.prisma](file:///C:/Users/saksham.asati/.gemini/antigravity/scratch/workflow-backend/prisma/schema.prisma) handles two distinct workflows: **Workorder Records Execution** and **AI Chat Test Case Generation**.

```mermaid
erDiagram
    Chat ||--o{ Message : contains
    Chat ||--o{ UserStory : associates
    UserStory ||--o{ AcceptanceCriterion : lists
    UserStory ||--o{ TestCase : generates

    Workorder ||--|{ Group : groups
    Group ||--|{ Item : executes
    Workorder ||--o{ AuditLog : audits

    Chat {
        string id PK
        string title
        string createdAt
        string userId
    }
    Message {
        string id PK
        string role
        string content
        string timestamp
        string chatId FK
    }
    UserStory {
        string id PK
        string title
        string description
        string userId
        string createdAt
        string chatId FK
    }
    AcceptanceCriterion {
        string id PK
        string content
        string userStoryId FK
    }
    TestCase {
        string id PK
        string customId
        string format
        string title
        string type
        string preconditions
        string steps
        string expectedResult
        string priority
        string executionStatus
        string customFields
        string userStoryId FK
    }
```

---

## 4. Key AI Processing Workflows

### 4.1 Test Case Generation Flow
1. **User Requirement Input**: The QA Engineer enters a user story, acceptance criteria, selects the output format (`Default`, `LLY TU`, `LLY PBPA`, `DEL`), and specifies test type ratios.
2. **Context Enrichment**: Uploaded attachments are read. The backend extracts text using `pdf-parse` (for PDFs) or `mammoth` (for Word documents) and appends this as document context.
3. **API Routing**: The frontend forwards the selected provider settings (Gemini, ChatGPT, Claude, Copilot) and API key in headers to the Express server.
4. **Prompt Construction**: `buildPromptText()` injects quality instructions (Boundary Value Analysis, Equivalence Partitioning), the target JSON schema layout, and details of existing test cases to prevent duplication.
5. **Execution & Storage**: The chosen LLM parses the prompt and generates structured JSON test cases. The server creates entries in the database and returns them to the React client.

### 4.2 Offline Fallback Mechanism
If the AI API fails (due to key expiration, rate limits, or network connectivity issues) or if the user requests heuristic generation:
1. The Express route catches the rejection and routes to `generateMockTestCases()`.
2. Heuristics extract common entities (e.g. Buttons, Inputs, Navigation links) from the requirement text using RegExp.
3. Template test cases covering typical actions (e.g. "Click Button", "Validate Input boundaries") are generated.
4. The test cases are saved in the sqlite database and returned to the UI marked with custom formats, ensuring zero-interruption workflow for the QA engineer.
