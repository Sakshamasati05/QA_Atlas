const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { PrismaClient } = require('@prisma/client');

// Load environment variables from .env manually
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.substring(1, value.length - 1);
        }
        process.env[key] = value.trim();
      }
    });
  }
} catch (e) {
  console.warn('Could not parse .env file:', e.message);
}

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

// Ensure upload dirs exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer setup — store to disk with original name
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// In-memory store for uploaded document text (per session)
const projectDocuments = {}; // chatId -> extracted text

// GET all workorders
app.get('/api/workorders', async (req, res) => {
  try {
    const workorders = await prisma.workorder.findMany({
      include: {
        groups: { include: { items: true } },
        auditTrail: true
      }
    });
    
    // Parse JSON strings back to arrays/mixed types for the frontend
    const formatted = workorders.map(wo => ({
      ...wo,
      groups: wo.groups.map(g => ({
        ...g,
        items: g.items.map(i => ({
          ...i,
          options: i.options ? JSON.parse(i.options) : [],
          value: i.value === 'true' ? true : (i.value === 'false' ? false : i.value)
        }))
      }))
    }));
    
    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to read data' });
  }
});

// POST new workorder
app.post('/api/workorders', async (req, res) => {
  try {
    const data = req.body;
    
    const newWo = await prisma.workorder.create({
      data: {
        id: data.id,
        name: data.name,
        description: data.description,
        status: data.status,
        createdBy: data.createdBy,
        createdAt: data.createdAt,
        rejectionComment: data.rejectionComment,
        cancellationComment: data.cancellationComment,
        auditTrail: {
          create: data.auditTrail?.map(a => ({
            id: a.id,
            timestamp: a.timestamp,
            user: a.user,
            action: a.action,
            details: a.details
          })) || []
        }
      },
      include: {
        groups: { include: { items: true } },
        auditTrail: true
      }
    });
    
    res.status(201).json(newWo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create workorder' });
  }
});

// PUT (Update) workorder
app.put('/api/workorders/:id', async (req, res) => {
  try {
    const data = req.body;
    
    // To handle complex nested updates easily, we delete and recreate the deeply nested object.
    // The Cascade delete in schema.prisma ensures old groups/items/audits are removed safely.
    await prisma.workorder.delete({ where: { id: req.params.id } });
    
    const updatedWo = await prisma.workorder.create({
      data: {
        id: data.id,
        name: data.name,
        description: data.description,
        status: data.status,
        createdBy: data.createdBy,
        createdAt: data.createdAt,
        rejectionComment: data.rejectionComment,
        cancellationComment: data.cancellationComment,
        auditTrail: {
          create: data.auditTrail?.map(a => ({
            id: a.id,
            timestamp: a.timestamp,
            user: a.user,
            action: a.action,
            details: a.details
          })) || []
        },
        groups: {
          create: data.groups?.map(g => ({
            id: g.id,
            name: g.name,
            items: {
              create: g.items?.map(i => ({
                id: i.id,
                name: i.name,
                category: i.category,
                type: i.type,
                options: JSON.stringify(i.options || []),
                lowerLimit: i.lowerLimit,
                upperLimit: i.upperLimit,
                status: i.status,
                value: i.value !== null && i.value !== undefined ? String(i.value) : null,
                executionStatus: i.executionStatus,
                undoneComment: i.undoneComment
              })) || []
            }
          })) || []
        }
      },
      include: {
        groups: { include: { items: true } },
        auditTrail: true
      }
    });
    
    res.json(updatedWo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update workorder' });
  }
});

// --- FILE UPLOAD ENDPOINTS ---

// POST upload a document (returns extracted text)
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
  try {
    const extracted = [];
    for (const file of req.files) {
      let text = '';
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.pdf') {
        const dataBuffer = fs.readFileSync(file.path);
        const data = await pdf(dataBuffer);
        text = data.text;
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: file.path });
        text = result.value;
      } else if (['.txt', '.md', '.csv', '.json', '.js', '.ts', '.jsx', '.tsx', '.py', '.java'].includes(ext)) {
        text = fs.readFileSync(file.path, 'utf8');
      } else {
        text = `[Binary file: ${file.originalname}]`;
      }
      extracted.push({ name: file.originalname, text: text.substring(0, 5000) });
    }
    res.json({ success: true, files: extracted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

// --- HELPER: MOCK TEST CASES GENERATOR (FALLBACK) ---
function generateMockTestCases(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, format = 'Default') {
  const cleanStory = (userStory || '').toLowerCase();
  const cleanAc = (acceptanceCriteria || '').toLowerCase();
  const combinedText = cleanStory + ' ' + cleanAc;

  // Heuristic extraction
  const buttonKeywords = ['button', 'click', 'select', 'press', 'add', 'create', 'edit', 'delete', 'copy', 'save', 'clear'];
  const extractedButtons = [];
  buttonKeywords.forEach(keyword => {
    if (combinedText.includes(keyword)) {
      // Find what follows or precedes the keyword
      const regex = new RegExp(`(?:${keyword})\\s+(?:on|to|for|a|new)?\\s*['"“]?([a-zA-Z0-9_-]{3,15})['"”]?`, 'g');
      let match;
      while ((match = regex.exec(combinedText)) !== null) {
        if (match[1] && !buttonKeywords.includes(match[1])) {
          extractedButtons.push(match[1].trim());
        }
      }
      extractedButtons.push(keyword);
    }
  });
  const buttons = [...new Set(extractedButtons)].slice(0, 6);

  const sectionKeywords = ['section', 'panel', 'sidebar', 'table', 'grid', 'page', 'form', 'view', 'header', 'footer'];
  const extractedSections = [];
  sectionKeywords.forEach(keyword => {
    if (combinedText.includes(keyword)) {
      const regex = new RegExp(`([a-zA-Z0-9_-]{3,15})\\s+(?:${keyword})`, 'g');
      let match;
      while ((match = regex.exec(combinedText)) !== null) {
        if (match[1] && !sectionKeywords.includes(match[1])) {
          extractedSections.push(match[1].trim() + ' ' + keyword);
        }
      }
      extractedSections.push(keyword);
    }
  });
  const sections = [...new Set(extractedSections)].slice(0, 6);

  const fieldKeywords = ['input', 'enter', 'field', 'drop down', 'dropdown', 'value', 'text', 'image', 'barcode', 'date', 'status'];
  const extractedFields = [];
  fieldKeywords.forEach(keyword => {
    if (combinedText.includes(keyword)) {
      const regex = new RegExp(`(?:${keyword})\\s+(?:of|for|name|with)?\\s*['"“]?([a-zA-Z0-9_-]{3,15})['"”]?`, 'g');
      let match;
      while ((match = regex.exec(combinedText)) !== null) {
        if (match[1] && !fieldKeywords.includes(match[1])) {
          extractedFields.push(match[1].trim());
        }
      }
      extractedFields.push(keyword);
    }
  });
  const fields = [...new Set(extractedFields)].slice(0, 6);

  // Fallbacks if lists are empty
  if (buttons.length === 0) buttons.push('action', 'submit');
  if (sections.length === 0) sections.push('main dashboard', 'layout section');
  if (fields.length === 0) fields.push('input field', 'status dropdown');

  const testCases = [];
  let pIdx = 1, nIdx = 1, eIdx = 1, sIdx = 1, pfIdx = 1;

  // Generate Positive Scenarios
  for (let i = 0; i < positiveCount; i++) {
    const btn = buttons[i % buttons.length];
    const sec = sections[i % sections.length];
    const fld = fields[i % fields.length];
    
    if (i === 0) {
      testCases.push({
        title: `Verify visual layout, alignment, and navigation of the ${sec}`,
        type: "Positive",
        preconditions: `The application is loaded and user is on the main landing view.`,
        steps: `1. Observe the ${sec}.\n2. Verify all elements (buttons, inputs) are positioned correctly according to specifications.`,
        expectedResult: `The ${sec} renders correctly with no visual displacement or overlapping elements.`,
        priority: "High"
      });
    } else if (i === 1 && buttons.length > 1) {
      testCases.push({
        title: `Verify that clicking the "${btn}" action triggers the expected form or redirect`,
        type: "Positive",
        preconditions: `The ${sec} containing the "${btn}" option is open.`,
        steps: `1. Click on the "${btn}" action element.\n2. Observe page transition or modal opening.`,
        expectedResult: `The "${btn}" operation runs successfully, launching the appropriate interface.`,
        priority: "High"
      });
    } else {
      testCases.push({
        title: `Verify user can successfully set or input a valid "${fld}" value`,
        type: "Positive",
        preconditions: `Form is initialized.`,
        steps: `1. Select or type a valid value into the "${fld}" field.\n2. Save the changes.`,
        expectedResult: `The "${fld}" value is accepted, saved, and displays correctly in the repository.`,
        priority: "Medium"
      });
    }
    pIdx++;
  }

  // Generate Negative Scenarios
  for (let i = 0; i < negativeCount; i++) {
    const btn = buttons[i % buttons.length];
    const fld = fields[i % fields.length];
    const sec = sections[i % sections.length];

    if (i === 0) {
      testCases.push({
        title: `Verify field validation error when required "${fld}" is left blank`,
        type: "Negative",
        preconditions: `Data entry form is open.`,
        steps: `1. Leave the required "${fld}" field empty.\n2. Attempt to click "${btn}".`,
        expectedResult: `Validation fails; error message displayed next to the "${fld}" field, and save is blocked.`,
        priority: "High"
      });
    } else {
      testCases.push({
        title: `Verify system error prevention when triggering invalid "${btn}" flow on ${sec}`,
        type: "Negative",
        preconditions: `System state is initialized.`,
        steps: `1. Navigate to the ${sec}.\n2. Input conflicting or invalid parameters.\n3. Click "${btn}".`,
        expectedResult: `System handles the error gracefully, shows a validation warning, and does not throw a 500 error.`,
        priority: "Medium"
      });
    }
    nIdx++;
  }

  // Generate Edge Scenarios
  for (let i = 0; i < edgeCount; i++) {
    const fld = fields[i % fields.length];
    const sec = sections[i % sections.length];

    if (i === 0) {
      testCases.push({
        title: `Verify safety and input sanitization of "${fld}" with special characters`,
        type: "Edge",
        preconditions: `Field "${fld}" is active.`,
        steps: `1. Type special characters (e.g. !@#$%^&*()_+{}|:"<>?) and SQL script text into "${fld}".\n2. Submit the record.`,
        expectedResult: `Input is encoded or sanitized successfully, preventing cross-site scripting (XSS) or database errors.`,
        priority: "Medium"
      });
    } else {
      testCases.push({
        title: `Verify ${sec} behavior during a sudden network disconnection`,
        type: "Edge",
        preconditions: `User is actively working on the ${sec}.`,
        steps: `1. Disable the network connection.\n2. Click any action link or try saving.`,
        expectedResult: `Application displays a friendly offline banner/warning and caches data or prompts user to reconnect.`,
        priority: "Medium"
      });
    }
    eIdx++;
  }

  // Generate Security Scenarios
  for (let i = 0; i < securityCount; i++) {
    const sec = sections[i % sections.length];
    const btn = buttons[i % buttons.length];

    if (i === 0) {
      testCases.push({
        title: `Verify unauthorized access prevention to ${sec} data endpoints`,
        type: "Security",
        preconditions: `User is logged out or lacks necessary role permissions.`,
        steps: `1. Send a direct API request to fetch or manipulate ${sec} data.`,
        expectedResult: `Server blocks the request with HTTP 401 Unauthorized or HTTP 403 Forbidden.`,
        priority: "High"
      });
    } else {
      testCases.push({
        title: `Verify sensitive session details are masked when clicking "${btn}"`,
        type: "Security",
        preconditions: `User is logged in.`,
        steps: `1. Click "${btn}".\n2. Inspect browser query params and local storage.`,
        expectedResult: `No plain credentials or sensitive session tokens are leaked in URL patterns.`,
        priority: "High"
      });
    }
    sIdx++;
  }

  // Generate Performance Scenarios
  for (let i = 0; i < performanceCount; i++) {
    const sec = sections[i % sections.length];
    testCases.push({
      title: `Verify loading speed of ${sec} remains under SLA limits`,
      type: "Performance",
      preconditions: `Database is populated with test data records.`,
      steps: `1. Navigate to the ${sec} and trigger load.\n2. Measure API response and screen paint timing.`,
      expectedResult: `Data loads and UI fully renders in less than 1.5 seconds.`,
      priority: "Medium"
    });
    pfIdx++;
  }

  return testCases.map((tc, idx) => mapTestCaseToFormat(tc, format, idx));
}


// --- HELPER: GEMINI CHAT COMPLETION ---
async function getGeminiChatResponse(chatId, newContent, apiKey) {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const contents = previousMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: newContent }]
  });

  if (!apiKey) {
    return "I am the QAtlas AI Assistant. Please configure your Gemini API Key in the settings panel to get real-time intelligent responses.\n\n*Note: Running in offline/mock mode.*";
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error: ${errText}`);
  }

  const resData = await response.json();
  return resData.candidates[0].content.parts[0].text;
}

// --- HELPER: OPENAI/CHATGPT CHAT COMPLETION ---
async function getOpenAiChatResponse(chatId, newContent, apiKey) {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const messages = previousMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content
  }));

  messages.push({
    role: 'user',
    content: newContent
  });

  if (!apiKey) {
    return "I am the QAtlas AI Assistant. Please configure your OpenAI API Key in the settings panel to get real-time intelligent responses.\n\n*Note: Running in offline/mock mode.*";
  }

  const url = 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API Error: ${errText}`);
  }

  const resData = await response.json();
  return resData.choices[0].message.content;
}

// --- HELPER: COPILOT CHAT COMPLETION ---
async function getCopilotChatResponse(chatId, newContent, apiKey) {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const messages = previousMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content
  }));

  messages.push({
    role: 'user',
    content: newContent
  });

  if (!apiKey) {
    return "I am the QAtlas AI Assistant. Please configure your Copilot API Key in the settings panel to get real-time intelligent responses.\\n\\n*Note: Running in offline/mock mode.*";
  }

  const url = 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Copilot API Error: ${errText}`);
  }

  const resData = await response.json();
  return resData.choices[0].message.content;
}

// --- HELPER: COPILOT TEST CASES GENERATOR ---
async function getCopilotTestCases(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, apiKey) {
  const promptText = buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

  if (!apiKey) {
    throw new Error("No Copilot API key found.");
  }

  const url = 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: promptText }],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Copilot API Error: ${errText}`);
  }

  const resData = await response.json();
  const rawText = resData.choices[0].message.content;
  
  let jsonString = rawText.trim();
  if (jsonString.startsWith('```')) {
    jsonString = jsonString.replace(/^```json\\s*/, '').replace(/```$/, '').trim();
  }
  
  return JSON.parse(jsonString);
}

// --- HELPER: COPILOT GENERATION FROM DOCUMENTS ---
async function getCopilotTestCasesFromDoc(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, apiKey) {
  const promptText = buildDocPromptText(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

  if (!apiKey) {
    throw new Error("No Copilot API key found.");
  }

  const url = 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: promptText }],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Copilot API Error: ${errText}`);
  }

  const resData = await response.json();
  const rawText = resData.choices[0].message.content;
  
  let jsonString = rawText.trim();
  if (jsonString.startsWith('```')) {
    jsonString = jsonString.replace(/^```json\\s*/, '').replace(/```$/, '').trim();
  }
  
  return JSON.parse(jsonString);
}


// --- HELPER: OPENAI/CHATGPT TEST CASES GENERATOR ---
async function getOpenAiTestCases(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, apiKey) {
  const promptText = buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

  const url = 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: promptText }],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API Error: ${errText}`);
  }

  const resData = await response.json();
  const rawText = resData.choices[0].message.content;
  
  let jsonString = rawText.trim();
  if (jsonString.startsWith('```')) {
    jsonString = jsonString.replace(/^```json\s*/, '').replace(/```$/, '').trim();
  }
  
  const parsed = JSON.parse(jsonString);
  return parsed.testCases || [];
}

// --- HELPERS: CUSTOM FORMATS & PROMPT BUILDERS ---
function getFormatInstructions(format) {
  if (format === 'LLY TU') {
    return `
You MUST generate test cases exactly in the "LLY TU" format.
Return a JSON object with this EXACT schema:
{
  "testCases": [
    {
      "customId": "TC001",
      "testPath": "string (logical folder path, e.g. /Login/Validation)",
      "type": "string (Positive, Negative, Edge, Security, or Performance)",
      "testName": "string (name of the test case)",
      "designer": "string (designer name, e.g. QA Team)",
      "category": "string (functional category, e.g. Authentication)",
      "preconditions": "string (starting with AC tag mapping, e.g. [AC1] User is logged out)",
      "stepName": "string (name of this test step, e.g. Input credentials)",
      "stepDescription": "string (detailed step actions, e.g. 1. Type email\\n2. Type password)",
      "expectedResult": "string (expected result)",
      "evidenceRequired": "string (Yes or No)"
    }
  ]
}
`;
  } else if (format === 'LLY PBPA') {
    return `
You MUST generate test cases exactly in the "LLY PBPA" format.
Return a JSON object with this EXACT schema:
{
  "testCases": [
    {
      "customId": "TC001",
      "testSummary": "string (summary/title of the test)",
      "type": "string (Positive, Negative, Edge, Security, or Performance)",
      "preconditions": "string (starting with AC tag mapping, e.g. [AC1] User is logged out)",
      "testCaseDescription": "string (detailed Test case description)",
      "stepsToBeFollowed": "string (Steps to be followed)",
      "expectedResult": "string (expected result)",
      "actualResult": "string (leave blank or use N/A)"
    }
  ]
}
`;
  } else if (format === 'DEL') {
    return `
You MUST generate test cases exactly in the "DEL" format.
Return a JSON object with this EXACT schema:
{
  "testCases": [
    {
      "customId": "TC001",
      "description": "string (clear summary of what is tested)",
      "type": "string (Positive, Negative, Edge, Security, or Performance)",
      "preconditions": "string (starting with AC tag mapping, e.g. [AC1] User is logged out)",
      "testData": "string (inputs or test data needed, e.g. Valid username/password)",
      "testSteps": "string (Test Steps description)",
      "expectedResult": "string (Expected Result)",
      "actualResult": "string (leave blank or use N/A)",
      "status": "string (default: Pending)",
      "bugId": "string (leave blank or use N/A)"
    }
  ]
}
`;
  } else {
    return `
You MUST generate test cases in the Default format.
Return a JSON object with this EXACT schema:
{
  "testCases": [
    {
      "customId": "TC001",
      "title": "string (Test Case Title)",
      "type": "string (Positive, Negative, Edge, Security, or Performance)",
      "preconditions": "string (starting with AC tag mapping, e.g. [AC1] User is logged out)",
      "steps": "string (step-by-step actions)",
      "expectedResult": "string (Expected Result)",
      "priority": "string (High, Medium, or Low)"
    }
  ]
}
`;
  }
}

function buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format) {
  const formatInst = getFormatInstructions(format);
  return `
You are an expert QA Automation Engineer.
Generate QA test cases based on the following:

**User Story / BRD Requirements:**
${userStory}

**Acceptance Criteria:**
${acceptanceCriteria}

**Required Test Cases to Generate:**
${customizeVolume === false ? `
Generate only the optimal number of test cases across all necessary types (Positive, Negative, Edge, Security, Performance) to fully cover the functional scenarios. Do NOT generate unnecessary, generic, or redundant test cases.
` : `
- Generate ${positiveCount} Positive test cases (type: "Positive")
- Generate ${negativeCount} Negative test cases (type: "Negative")
- Generate ${edgeCount} Edge test cases (type: "Edge")
- Generate ${securityCount} Security test cases (type: "Security")
- Generate ${performanceCount} Performance test cases (type: "Performance")
`}

${existingTitles && existingTitles.length > 0 ? `**Existing Test Cases in Database (DO NOT DUPLICATE THESE):**\n${existingTitles.map((t, idx) => `${idx + 1}. ${t}`).join('\n')}\nYou must ensure all newly generated test cases are distinct from these existing ones.` : ''}

**CRITICAL QUALITY INSTRUCTIONS:**
1. **Accurate BRD Mapping:** Every test case must be highly specific and map directly to a functional rule, button, validation check, or status transition described in the User Story/BRD requirements.
2. **Zero Redundancy:** Do NOT generate duplicate, generic, or filler test cases. Each scenario must test a completely distinct logical feature path.
3. **Descriptive Titles:** Every test case title/description must be clear and descriptive of the exact condition. Do NOT use placeholder text or generic titles.
4. **Acceptance Criteria Mapping:** You MUST map each test case to the Acceptance Criteria it validates by placing the matching AC tag (e.g. "[AC1]" or "[AC2]") at the very beginning of the "preconditions" field. For example: "preconditions": "[AC1] User is logged out." If no specific AC exists or the document is generic, use "[AC1]" as default.
5. **Sequential ID:** Generate sequential custom ID (e.g. "TC001", "TC002"...) for the test cases within this set, stored in the "customId" field.

**Formatting Guidelines:**
${formatInst}
Return ONLY a valid JSON object matching the schema. Do not include markdown code block syntax (like \`\`\`json) or any conversational text.
`;
}

function mapTestCaseToFormat(tc, format, index) {
  const sequentialId = 'TC' + String(index + 1).padStart(3, '0');
  if (format === 'LLY TU') {
    return {
      customId: tc.customId || sequentialId,
      testPath: tc.testPath || '/DefaultPath/Section',
      type: tc.type || 'Positive',
      testName: tc.testName || tc.title || 'Generated Scenario',
      designer: tc.designer || 'QA Team',
      category: tc.category || 'General',
      preconditions: tc.preconditions || 'N/A',
      stepName: tc.stepName || 'Perform Action',
      stepDescription: tc.stepDescription || tc.steps || '1. Action.',
      expectedResult: tc.expectedResult || 'Expected Result.',
      evidenceRequired: tc.evidenceRequired || 'No'
    };
  } else if (format === 'LLY PBPA') {
    return {
      customId: tc.customId || sequentialId,
      testSummary: tc.testSummary || tc.title || 'Generated Scenario',
      type: tc.type || 'Positive',
      preconditions: tc.preconditions || 'N/A',
      testCaseDescription: tc.testCaseDescription || tc.description || 'Verify function.',
      stepsToBeFollowed: tc.stepsToBeFollowed || tc.steps || '1. Action.',
      expectedResult: tc.expectedResult || 'Expected Result.',
      actualResult: tc.actualResult || 'N/A'
    };
  } else if (format === 'DEL') {
    return {
      customId: tc.customId || sequentialId,
      description: tc.description || tc.title || 'Generated Scenario',
      type: tc.type || 'Positive',
      preconditions: tc.preconditions || 'N/A',
      testData: tc.testData || 'Valid credentials',
      testSteps: tc.testSteps || tc.steps || '1. Action.',
      expectedResult: tc.expectedResult || 'Expected Result.',
      actualResult: tc.actualResult || 'N/A',
      status: tc.status || 'Pending',
      bugId: tc.bugId || 'N/A'
    };
  } else {
    return {
      ...tc,
      customId: tc.customId || sequentialId
    };
  }
}

async function saveGeneratedTestCase(tc, storyId, format, index) {
  const sequentialId = tc.customId || ('TC' + String(index + 1).padStart(3, '0'));
  let title = tc.title || 'Generated Scenario';
  let type = tc.type || 'Positive';
  let preconditions = tc.preconditions || 'N/A';
  let steps = tc.steps || '1. Action.';
  let expectedResult = tc.expectedResult || 'Expected Result.';
  let priority = tc.priority || 'Medium';
  let customFieldsObj = {};

  if (format === 'LLY TU') {
    title = tc.testName || tc.title || 'Generated Scenario';
    steps = tc.stepDescription || tc.steps || '1. Action.';
    customFieldsObj = {
      testPath: tc.testPath || 'N/A',
      designer: tc.designer || 'QA Team',
      category: tc.category || 'N/A',
      description: tc.description || 'N/A',
      stepName: tc.stepName || 'N/A',
      evidenceRequired: tc.evidenceRequired || 'No'
    };
  } else if (format === 'LLY PBPA') {
    title = tc.testSummary || tc.title || 'Generated Scenario';
    steps = tc.stepsToBeFollowed || tc.steps || '1. Action.';
    customFieldsObj = {
      testCaseDescription: tc.testCaseDescription || tc.description || 'N/A',
      actualResult: tc.actualResult || 'N/A'
    };
  } else if (format === 'DEL') {
    title = tc.description || tc.title || 'Generated Scenario';
    steps = tc.testSteps || tc.steps || '1. Action.';
    customFieldsObj = {
      testData: tc.testData || 'N/A',
      actualResult: tc.actualResult || 'N/A',
      bugId: tc.bugId || 'N/A'
    };
    if (tc.status) {
      // Use status if present, otherwise default to Pending
      priority = 'Medium';
    }
  }

  return await prisma.testCase.create({
    data: {
      id: 'TC-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      customId: sequentialId,
      format: format,
      title,
      type,
      preconditions,
      steps,
      expectedResult,
      priority,
      customFields: Object.keys(customFieldsObj).length > 0 ? JSON.stringify(customFieldsObj) : null,
      userStoryId: storyId
    }
  });
}

// --- HELPER: CLAUDE CHAT COMPLETION ---
async function getClaudeChatResponse(chatId, newContent, apiKey) {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const messages = previousMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content
  }));

  messages.push({
    role: 'user',
    content: newContent
  });

  if (!apiKey) {
    return "I am the QAtlas AI Assistant. Please configure your Claude API Key in the settings panel to get real-time intelligent responses.\n\n*Note: Running in offline/mock mode.*";
  }

  const url = 'https://api.anthropic.com/v1/messages';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API Error: ${errText}`);
  }

  const resData = await response.json();
  return resData.content[0].text;
}

// --- HELPER: CLAUDE TEST CASES GENERATOR ---
async function getClaudeTestCases(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, apiKey) {
  const promptText = buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

  const url = 'https://api.anthropic.com/v1/messages';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 4000,
      messages: [{ role: 'user', content: promptText }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API Error: ${errText}`);
  }

  const resData = await response.json();
  const rawText = resData.content[0].text;
  
  let jsonString = rawText.trim();
  if (jsonString.startsWith('```')) {
    jsonString = jsonString.replace(/^```json\s*/, '').replace(/```$/, '').trim();
  }
  
  const parsed = JSON.parse(jsonString);
  return parsed.testCases || [];
}


// --- CHAT API ENDPOINTS ---

// GET all chats (history) for user
app.get('/api/chats', async (req, res) => {
  try {
    const userId = req.query.userId || 'default-user';
    const chats = await prisma.chat.findMany({
      where: { userId },
      include: { messages: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(chats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// POST a new chat message (and create chat if doesn't exist)
app.post('/api/chats/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { role, content, title, userId = 'default-user' } = req.body;
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || (provider === 'claude' ? process.env.CLAUDE_API_KEY : provider === 'chatgpt' ? process.env.OPENAI_API_KEY : provider === 'copilot' ? process.env.COPILOT_API_KEY : process.env.GEMINI_API_KEY);

    let chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          id: chatId,
          title: title || content.substring(0, 25) || 'New Chat',
          userId: userId,
          createdAt: new Date().toISOString()
        }
      });
    }

    const userMessage = await prisma.message.create({
      data: {
        id: 'MSG-' + Date.now(),
        role: role || 'user',
        content: content,
        timestamp: new Date().toISOString(),
        chatId: chatId
      }
    });

    let aiResponseContent = '';
    try {
      if (provider === 'claude') {
        aiResponseContent = await getClaudeChatResponse(chatId, content, apiKey);
      } else if (provider === 'chatgpt') {
        aiResponseContent = await getOpenAiChatResponse(chatId, content, apiKey);
      } else if (provider === 'copilot') {
        aiResponseContent = await getCopilotChatResponse(chatId, content, apiKey);
      } else {
        aiResponseContent = await getGeminiChatResponse(chatId, content, apiKey);
      }
    } catch (apiErr) {
      console.error(`${provider} Chat API Error:`, apiErr.message);
      aiResponseContent = `Failed to get response from ${provider === 'claude' ? 'Claude' : provider === 'chatgpt' ? 'ChatGPT' : provider === 'copilot' ? 'Copilot' : 'Gemini'} API: ${apiErr.message}. Please verify your API Key and internet connection.`;
    }

    const aiMessage = await prisma.message.create({
      data: {
        id: 'MSG-' + (Date.now() + 1),
        role: 'ai',
        content: aiResponseContent,
        timestamp: new Date().toISOString(),
        chatId: chatId
      }
    });

    res.status(201).json({ userMessage, aiMessage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});


// DELETE a chat
app.delete('/api/chats/:chatId', async (req, res) => {
  try {
    await prisma.chat.delete({ where: { id: req.params.chatId } });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// --- QATLAS USER STORIES & TEST CASES ENDPOINTS ---

// GET all user stories (segregated by userId)
app.get('/api/user-stories', async (req, res) => {
  try {
    const userId = req.query.userId || 'default-user';
    const stories = await prisma.userStory.findMany({
      where: { userId },
      include: {
        acceptanceCriteria: true,
        testCases: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(stories);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch user stories' });
  }
});

// POST (create user story and generate test cases with duplicate checking)
app.post('/api/user-stories', async (req, res) => {
  try {
    const {
      userStory,
      acceptanceCriteria,
      positiveCount = 3,
      negativeCount = 3,
      edgeCount = 3,
      securityCount = 3,
      performanceCount = 3,
      customizeVolume = true,
      userId = 'default-user',
      chatId,
      format = 'Default'
    } = req.body;

    if (!userStory && !acceptanceCriteria) {
      return res.status(400).json({ error: 'User Story or Acceptance Criteria is required.' });
    }

    const title = userStory.substring(0, 50) || 'Untitled User Story';
    const cleanStory = (userStory || '').toLowerCase().trim();

    // 1. Identify existing UserStories for Duplicate Checking
    const existingStories = await prisma.userStory.findMany({
      where: { userId },
      include: { testCases: true }
    });

    let matchedStory = existingStories.find(story => {
      const dbTitle = story.title.toLowerCase().trim();
      const dbDesc = story.description.toLowerCase().trim();
      return cleanStory.includes(dbTitle) || 
             dbTitle.includes(cleanStory) ||
             (cleanStory.length > 50 && dbDesc.substring(0, 50) === cleanStory.substring(0, 50));
    });

    let storyId;
    let existingTitles = [];
    if (matchedStory) {
      storyId = matchedStory.id;
      existingTitles = matchedStory.testCases.map(tc => tc.title.toLowerCase().trim());
    } else {
      storyId = 'US-' + Date.now();
      if (chatId) {
        const chatExists = await prisma.chat.findUnique({ where: { id: chatId } });
        if (!chatExists) {
          await prisma.chat.create({
            data: {
              id: chatId,
              title: title || 'New Chat',
              userId: userId,
              createdAt: new Date().toISOString()
            }
          });
        }
      }
      matchedStory = await prisma.userStory.create({
        data: {
          id: storyId,
          title: title,
          description: userStory || '',
          userId: userId,
          createdAt: new Date().toISOString(),
          chatId: chatId || null
        }
      });
      // Save acceptance criteria if provided
      if (acceptanceCriteria) {
        const criteriaLines = acceptanceCriteria.split('\n').filter(line => line.trim().length > 0);
        for (const line of criteriaLines) {
          await prisma.acceptanceCriterion.create({
            data: {
              id: 'AC-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
              content: line.trim(),
              userStoryId: storyId
            }
          });
        }
      }
    }

    // 2. Generate Test Cases using Gemini, Claude, ChatGPT or Mock
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || 
      (provider === 'claude' ? process.env.CLAUDE_API_KEY : 
       provider === 'chatgpt' ? process.env.OPENAI_API_KEY : 
       provider === 'copilot' ? process.env.COPILOT_API_KEY : 
       process.env.GEMINI_API_KEY);
    let generatedRaw = [];

    if (!apiKey) {
      console.log(`No API key for ${provider}. Using high-fidelity mock generator.`);
      generatedRaw = generateMockTestCases(
        userStory,
        acceptanceCriteria,
        positiveCount,
        negativeCount,
        edgeCount,
        securityCount,
        performanceCount,
        format
      );
    } else if (provider === 'claude') {
      try {
        generatedRaw = await getClaudeTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          existingTitles,
          customizeVolume,
          format,
          apiKey
        );
      } catch (err) {
        console.error('Claude API failed, falling back to mock:', err.message);
        generatedRaw = generateMockTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format
        );
      }
    } else if (provider === 'chatgpt') {
      try {
        generatedRaw = await getOpenAiTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          existingTitles,
          customizeVolume,
          format,
          apiKey
        );
      } catch (err) {
        console.error('OpenAI API failed, falling back to mock:', err.message);
        generatedRaw = generateMockTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format
        );
      }
    } else if (provider === 'copilot') {
      try {
        generatedRaw = await getCopilotTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          existingTitles,
          customizeVolume,
          format,
          apiKey
        );
      } catch (err) {
        console.error('Copilot API failed, falling back to mock:', err.message);
        generatedRaw = generateMockTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format
        );
      }
    } else {
      // Build prompt with context for Gemini
      const promptText = buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        });

        if (response.ok) {
          const resData = await response.json();
          const rawJsonText = resData.candidates[0].content.parts[0].text;
          const parsed = JSON.parse(rawJsonText);
          generatedRaw = parsed.testCases || [];
        } else {
          const errText = await response.text();
          console.error('Gemini API failed, falling back to mock:', errText);
          generatedRaw = generateMockTestCases(
            userStory,
            acceptanceCriteria,
            positiveCount,
            negativeCount,
            edgeCount,
            securityCount,
            performanceCount,
            format
          );
        }
      } catch (err) {
        console.error('Gemini connection error, falling back to mock:', err.message);
        generatedRaw = generateMockTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format
        );
      }
    }

    // 3. Duplicate check - filter out duplicates programmatically
    const savedTestCases = [];
    let duplicateCount = 0;

    for (const tc of generatedRaw) {
      const cleanedTitle = (tc.title || tc.testName || tc.testSummary || tc.description || '').toLowerCase().trim();
      const isDuplicate = existingTitles.includes(cleanedTitle) || 
                          savedTestCases.some(saved => saved.title.toLowerCase().trim() === cleanedTitle);
      
      if (isDuplicate) {
        duplicateCount++;
        continue;
      }

      const idx = existingTitles.length + savedTestCases.length;
      const newTc = await saveGeneratedTestCase(tc, storyId, format, idx);
      savedTestCases.push(newTc);
    }

    // 4. Create AI Chat message if chatId is provided
    let aiMessage = null;
    if (chatId) {
      let chat = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chat) {
        chat = await prisma.chat.create({
          data: {
            id: chatId,
            title: 'QAtlas: ' + (userStory.substring(0, 20) || 'Test Cases'),
            userId: userId,
            createdAt: new Date().toISOString()
          }
        });
      }

      const userMsgCount = await prisma.message.count({ where: { chatId, role: 'user' } });
      if (userMsgCount === 0) {
        await prisma.message.create({
          data: {
            id: 'MSG-' + Date.now(),
            role: 'user',
            content: `Generate test cases for User Story:\n${userStory}\n\nAcceptance Criteria:\n${acceptanceCriteria}`,
            timestamp: new Date().toISOString(),
            chatId: chatId
          }
        });
      }

      const aiResponseContent = `**Generated ${savedTestCases.length} Test Cases successfully.**` + 
        (duplicateCount > 0 ? ` (Deduplicated and skipped ${duplicateCount} duplicate scenarios)` : '') +
        `\n\n` + 
        savedTestCases.map((tc, idx) => `**[${tc.type}] ${tc.id}: ${tc.title}**\n*Preconditions:* ${tc.preconditions}\n*Steps:*\n${tc.steps}\n*Expected:* ${tc.expectedResult}\n*Priority:* ${tc.priority}`).join('\n\n');

      aiMessage = await prisma.message.create({
        data: {
          id: 'MSG-' + (Date.now() + 1),
          role: 'ai',
          content: aiResponseContent,
          timestamp: new Date().toISOString(),
          chatId: chatId
        }
      });
    }

    const fullStory = await prisma.userStory.findUnique({
      where: { id: storyId },
      include: {
        acceptanceCriteria: true,
        testCases: true
      }
    });

    res.status(201).json({
      success: true,
      storyId,
      duplicateCount,
      testCases: savedTestCases,
      aiMessage,
      story: fullStory
    });

  } catch (error) {
    console.error('Error generating user story/test cases:', error);
    res.status(500).json({ error: 'Failed to process user story generation' });
  }
});

function buildDocPromptText(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format) {
  const formatInst = getFormatInstructions(format);
  return `
Analyze this requirement/specification document:
--- Document Name: ${documentName} ---
${documentText.substring(0, 10000)}

Tasks:
1. Extract a clear, concise User Story summarizing the primary features described in the document (format as: "As a..., I want to..., so that...").
2. Extract the Acceptance Criteria (list at least 3-5 criteria, newline separated).
3. ${customizeVolume === false ? `Generate only the optimal number of test cases across all necessary types (Positive, Negative, Edge, Security, Performance) to fully cover the requirements. Do NOT generate unnecessary, generic, or redundant test cases.` : `Generate ${positiveCount} Positive, ${negativeCount} Negative, ${edgeCount} Edge, ${securityCount} Security, and ${performanceCount} Performance test cases.`}

${existingTitles && existingTitles.length > 0 ? `**Existing Test Cases in Database (DO NOT DUPLICATE THESE):**\n${existingTitles.map((t, idx) => `${idx + 1}. ${t}`).join('\n')}\nYou must ensure all newly generated test cases are distinct from these existing ones.` : ''}

**CRITICAL QUALITY INSTRUCTIONS:**
1. **Accurate BRD Mapping:** Every test case must be highly specific and map directly to a functional rule, button, validation check, or status transition described in the User Story/BRD requirements.
2. **Zero Redundancy:** Do NOT generate duplicate, generic, or filler test cases. Each scenario must test a completely distinct logical feature path.
3. **Descriptive Titles:** Every test case title/description must be clear and descriptive of the exact condition. Do NOT use placeholder text or generic titles.
4. **Acceptance Criteria Mapping:** You MUST map each test case to the Acceptance Criteria it validates by placing the matching AC tag (e.g. "[AC1]" or "[AC2]") at the very beginning of the "preconditions" field. For example: "preconditions": "[AC1] User is logged out." If no specific AC exists or the document is generic, use "[AC1]" as default.
5. **Sequential ID:** Generate sequential custom ID (e.g. "TC001", "TC002"...) for the test cases within this set, stored in the "customId" field.

Response must be valid JSON matching this schema:
{
  "userStory": "string",
  "acceptanceCriteria": "string",
  "testCases": [
    // List generated test case objects conforming to format schema below:
    // ${formatInst.trim().replace(/\n/g, '\n    // ')}
  ]
}
`;
}

async function getOpenAiTestCasesFromDoc(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, apiKey) {
  const promptText = buildDocPromptText(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

  const url = 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: promptText }],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API Error: ${errText}`);
  }

  const resData = await response.json();
  const rawText = resData.choices[0].message.content;
  
  let jsonString = rawText.trim();
  if (jsonString.startsWith('```')) {
    jsonString = jsonString.replace(/^```json\s*/, '').replace(/```$/, '').trim();
  }
  
  return JSON.parse(jsonString);
}

// --- HELPERS: GENERATION FROM DOCUMENTS ---
async function getClaudeTestCasesFromDoc(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, apiKey) {
  const promptText = buildDocPromptText(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

  const url = 'https://api.anthropic.com/v1/messages';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 4000,
      messages: [{ role: 'user', content: promptText }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API Error: ${errText}`);
  }

  const resData = await response.json();
  const rawText = resData.content[0].text;
  
  let jsonString = rawText.trim();
  if (jsonString.startsWith('```')) {
    jsonString = jsonString.replace(/^```json\s*/, '').replace(/```$/, '').trim();
  }
  
  return JSON.parse(jsonString);
}

async function getGeminiTestCasesFromDoc(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, apiKey) {
  const promptText = buildDocPromptText(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error: ${errText}`);
  }

  const resData = await response.json();
  const rawJsonText = resData.candidates[0].content.parts[0].text;
  return JSON.parse(rawJsonText);
}

function generateMockTestCasesFromDoc(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, format = 'Default') {
  const words = documentText.replace(/[^\w\s]/g, '').split(/\s+/).slice(0, 15).join(' ');
  const userStory = `As a QAtlas analyst, I want to execute business features from "${documentName}" so that we verify system specs: ${words}...`;
  const acceptanceCriteria = `AC1: The system must enforce validation rules in ${documentName}.\nAC2: Navigation and actions defined in ${documentName} must respond correctly.`;
  
  const testCases = generateMockTestCases(
    documentText,
    acceptanceCriteria,
    positiveCount,
    negativeCount,
    edgeCount,
    securityCount,
    performanceCount,
    format
  );
  
  return {
    userStory,
    acceptanceCriteria,
    testCases
  };
}

// POST generate from document
app.post('/api/user-stories/generate-from-doc', async (req, res) => {
  try {
    const {
      documentName,
      documentText,
      positiveCount = 3,
      negativeCount = 3,
      edgeCount = 3,
      securityCount = 2,
      performanceCount = 2,
      customizeVolume = true,
      userId = 'default-user',
      chatId,
      format = 'Default'
    } = req.body;

    if (!documentText) {
      return res.status(400).json({ error: 'Document text is required.' });
    }

    // 1. Identify if an existing story exists for this user containing documentName
    const docBaseName = documentName.replace(/\.[^/.]+$/, "");
    const matchedStory = await prisma.userStory.findFirst({
      where: {
        userId,
        OR: [
          { title: { contains: documentName } },
          { title: { contains: docBaseName } }
        ]
      },
      include: { testCases: true }
    });

    let existingTitles = [];
    let finalStoryId = null;
    let isNewStory = true;

    if (matchedStory) {
      existingTitles = matchedStory.testCases.map(tc => tc.title.toLowerCase().trim());
      finalStoryId = matchedStory.id;
      isNewStory = false;
      console.log(`Matched existing story ${finalStoryId} for doc ${documentName}. Found ${existingTitles.length} existing test cases.`);
    }

    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || 
      (provider === 'claude' ? process.env.CLAUDE_API_KEY : 
       provider === 'chatgpt' ? process.env.OPENAI_API_KEY : 
       provider === 'copilot' ? process.env.COPILOT_API_KEY : 
       process.env.GEMINI_API_KEY);

    let result;
    if (!apiKey) {
      console.log('No API key. Generating mock from document.');
      result = generateMockTestCasesFromDoc(
        documentName,
        documentText,
        positiveCount,
        negativeCount,
        edgeCount,
        securityCount,
        performanceCount,
        format
      );
    } else if (provider === 'claude') {
      try {
        result = await getClaudeTestCasesFromDoc(
          documentName,
          documentText,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          existingTitles,
          customizeVolume,
          format,
          apiKey
        );
      } catch (err) {
        console.error('Claude API generate-from-doc error, falling back to mock:', err.message);
        result = generateMockTestCasesFromDoc(
          documentName,
          documentText,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format
        );
      }
    } else if (provider === 'chatgpt') {
      try {
        result = await getOpenAiTestCasesFromDoc(
          documentName,
          documentText,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          existingTitles,
          customizeVolume,
          format,
          apiKey
        );
      } catch (err) {
        console.error('OpenAI API generate-from-doc error, falling back to mock:', err.message);
        result = generateMockTestCasesFromDoc(
          documentName,
          documentText,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format
        );
      }
    } else if (provider === 'copilot') {
      try {
        result = await getCopilotTestCasesFromDoc(
          documentName,
          documentText,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          existingTitles,
          customizeVolume,
          format,
          apiKey
        );
      } catch (err) {
        console.error('Copilot API generate-from-doc error, falling back to mock:', err.message);
        result = generateMockTestCasesFromDoc(
          documentName,
          documentText,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format
        );
      }
    } else {
      try {
        result = await getGeminiTestCasesFromDoc(
          documentName,
          documentText,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          existingTitles,
          customizeVolume,
          format,
          apiKey
        );
      } catch (err) {
        console.error('Gemini API generate-from-doc error, falling back to mock:', err.message);
        result = generateMockTestCasesFromDoc(
          documentName,
          documentText,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format
        );
      }
    }

    const storyText = result.userStory || `As a user, I want to perform actions based on ${documentName}.`;
    const acText = result.acceptanceCriteria || `AC1: Behavior must match ${documentName}.`;
    const parsedTestCases = result.testCases || [];

    if (isNewStory) {
      finalStoryId = 'US-' + Date.now();
      const storyTitle = `Story from ${documentName}`;
      if (chatId) {
        const chatExists = await prisma.chat.findUnique({ where: { id: chatId } });
        if (!chatExists) {
          await prisma.chat.create({
            data: {
              id: chatId,
              title: `Doc: ${documentName}`,
              userId: userId,
              createdAt: new Date().toISOString()
            }
          });
        }
      }
      await prisma.userStory.create({
        data: {
          id: finalStoryId,
          title: storyTitle,
          description: storyText,
          userId,
          createdAt: new Date().toISOString(),
          chatId: chatId || null
        }
      });

      if (acText) {
        const acLines = acText.split('\n').filter(l => l.trim().length > 0);
        for (const line of acLines) {
          await prisma.acceptanceCriterion.create({
            data: {
              id: 'AC-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
              content: line.trim(),
              userStoryId: finalStoryId
            }
          });
        }
      }
    }

    // 2. Programmatic deduplication check
    const savedTestCases = [];
    let duplicateCount = 0;

    for (const tc of parsedTestCases) {
      const cleanedTitle = (tc.title || tc.testName || tc.testSummary || tc.description || '').toLowerCase().trim();
      const isDuplicate = existingTitles.includes(cleanedTitle) || 
                          savedTestCases.some(saved => saved.title.toLowerCase().trim() === cleanedTitle);
      
      if (isDuplicate) {
        duplicateCount++;
        continue;
      }

      const idx = existingTitles.length + savedTestCases.length;
      const newTc = await saveGeneratedTestCase(tc, finalStoryId, format, idx);
      savedTestCases.push(newTc);
    }

    // If it's an existing story, retrieve the full list of test cases (both old and new) to return to the frontend
    let allTestCases = savedTestCases;
    if (!isNewStory) {
      allTestCases = await prisma.testCase.findMany({
        where: { userStoryId: finalStoryId }
      });
    }

    let aiMessage = null;
    if (chatId) {
      let chat = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chat) {
        chat = await prisma.chat.create({
          data: {
            id: chatId,
            title: 'QAtlas Doc: ' + documentName,
            userId: userId,
            createdAt: new Date().toISOString()
          }
        });
      }

      await prisma.message.create({
        data: {
          id: 'MSG-' + Date.now(),
          role: 'user',
          content: `Generate test cases from document: ${documentName}`,
          timestamp: new Date().toISOString(),
          chatId: chatId
        }
      });

      const aiResponseContent = `**Generated ${savedTestCases.length} new Test Cases from document "${documentName}".**` + 
        (duplicateCount > 0 ? ` (Deduplicated and skipped ${duplicateCount} duplicate scenarios)` : '') +
        `\n\n` +
        `**Extracted User Story:**\n${storyText}\n\n` +
        `**Extracted Acceptance Criteria:**\n${acText}\n\n` +
        savedTestCases.map((tc, idx) => `**[${tc.type}] ${tc.id}: ${tc.title}**\n*Steps:*\n${tc.steps}\n*Expected:* ${tc.expectedResult}`).join('\n\n');

      aiMessage = await prisma.message.create({
        data: {
          id: 'MSG-' + (Date.now() + 1),
          role: 'ai',
          content: aiResponseContent,
          timestamp: new Date().toISOString(),
          chatId: chatId
        }
      });
    }

    const fullStory = await prisma.userStory.findUnique({
      where: { id: finalStoryId },
      include: {
        acceptanceCriteria: true,
        testCases: true
      }
    });

    res.status(201).json({
      success: true,
      storyId: finalStoryId,
      userStory: storyText,
      acceptanceCriteria: acText,
      duplicateCount,
      testCases: allTestCases,
      aiMessage,
      story: fullStory
    });

  } catch (error) {
    console.error('Error generating from document:', error);
    res.status(500).json({ error: 'Failed to process document generation' });
  }
});


// GET all test cases for a specific user story
app.get('/api/user-stories/:id/test-cases', async (req, res) => {
  try {
    const { id } = req.params;
    const testCases = await prisma.testCase.findMany({
      where: { userStoryId: id }
    });
    res.json(testCases);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch test cases' });
  }
});

// PUT (update) a test case (inline editing & dry run execution)
app.put('/api/test-cases/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, type, preconditions, steps, expectedResult, priority, executionStatus, executionComments, customId, format, customFields } = req.body;
    
    let dbCustomFields = customFields;
    if (customFields && typeof customFields === 'object') {
      dbCustomFields = JSON.stringify(customFields);
    }

    const updated = await prisma.testCase.update({
      where: { id },
      data: { 
        title, 
        type, 
        preconditions, 
        steps, 
        expectedResult, 
        priority, 
        executionStatus, 
        executionComments,
        customId,
        format,
        customFields: dbCustomFields
      }
    });
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update test case' });
  }
});

// DELETE a single test case
app.delete('/api/test-cases/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.testCase.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete test case' });
  }
});

// DELETE a user story (and its test cases cascade)
app.delete('/api/user-stories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.userStory.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete user story' });
  }
});

// POST import test cases to a user story
app.post('/api/user-stories/:id/import-test-cases', async (req, res) => {
  try {
    const { id } = req.params;
    const { testCases } = req.body;
    if (!Array.isArray(testCases)) {
      return res.status(400).json({ error: 'testCases must be an array' });
    }
    
    const created = [];
    for (const tc of testCases) {
      const newTc = await prisma.testCase.create({
        data: {
          id: 'TC-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
          title: tc.title || 'Untitled Test Case',
          type: tc.type || 'Positive',
          preconditions: tc.preconditions || 'N/A',
          steps: typeof tc.steps === 'string' ? tc.steps : (Array.isArray(tc.steps) ? tc.steps.join('\n') : '1. Open page.'),
          expectedResult: tc.expectedResult || 'System works.',
          priority: tc.priority || 'Medium',
          userStoryId: id
        }
      });
      created.push(newTc);
    }
    
    res.status(201).json({ success: true, count: created.length, testCases: created });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to import test cases' });
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Backend server (SQL) running on http://localhost:${PORT}`);
});
