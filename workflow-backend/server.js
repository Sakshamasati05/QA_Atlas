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
      extracted.push({ name: file.originalname, text: text.substring(0, 50000) });
    }
    res.json({ success: true, files: extracted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

// --- HELPER: ROBUST JSON PARSER ---
function parseCleanJson(rawText) {
  let jsonString = rawText.trim();
  if (jsonString.startsWith('```')) {
    jsonString = jsonString.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  }
  const firstBrace = jsonString.indexOf('{');
  const lastBrace = jsonString.lastIndexOf('}');
  const firstBracket = jsonString.indexOf('[');
  const lastBracket = jsonString.lastIndexOf(']');
  
  if (firstBrace !== -1 && lastBrace !== -1) {
    if (firstBracket === -1 || firstBrace < firstBracket) {
      jsonString = jsonString.substring(firstBrace, lastBrace + 1);
    } else {
      jsonString = jsonString.substring(firstBracket, lastBracket + 1);
    }
  } else if (firstBracket !== -1 && lastBracket !== -1) {
    jsonString = jsonString.substring(firstBracket, lastBracket + 1);
  }
  
  return JSON.parse(jsonString);
}

// --- HELPER: MOCK TEST CASES GENERATOR (FALLBACK) ---
function generateMockTestCases(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, format = 'Default', docContext = '') {
  const rawLines = [];
  if (acceptanceCriteria) rawLines.push(...acceptanceCriteria.split('\n'));
  if (userStory) rawLines.push(...userStory.slice(0, 10000).split('\n'));
  if (docContext) rawLines.push(...docContext.slice(0, 10000).split('\n'));

  // Clean lines to extract potential requirements / acceptance criteria rules
  const rules = rawLines
    .map(line => line.trim())
    .map(line => line.replace(/^[-*+\d\.\)\s]+/, '')) // remove list bullet prefixes
    .map(line => line.replace(/^\[AC\d+\]\s*/i, '')) // remove existing AC tags
    .filter(line => line.length > 12)
    .filter(line => {
      const lower = line.toLowerCase();
      return !lower.startsWith('as a') && !lower.startsWith('i want to') && !lower.startsWith('so that') && 
             !lower.includes('user story') && !lower.includes('acceptance criteria') && 
             !lower.includes('generate mock') && !lower.includes('test cases');
    });

  // Unique rules
  const uniqueRules = [...new Set(rules)];

  // If no rules could be parsed, provide logical fallbacks based on input context
  if (uniqueRules.length === 0) {
    const topic = (userStory || '').substring(0, 40).trim() || 'Requested Feature';
    uniqueRules.push(
      `user can successfully execute core operations of ${topic}`,
      `form fields reject invalid inputs or blank submissions for ${topic}`,
      `system preserves data integrity and authorization constraints during operations`
    );
  }

  const testCases = [];

  // Helper to construct a test case structure
  const makeTestCase = (title, type, preconditions, steps, expectedResult, priority) => {
    return {
      title,
      type,
      preconditions,
      steps,
      expectedResult,
      priority
    };
  };

  // 1. Generate Positive Cases
  for (let i = 0; i < positiveCount; i++) {
    const rule = uniqueRules[i % uniqueRules.length];
    const acTag = `[AC${(i % uniqueRules.length) + 1}]`;
    const ruleCap = rule.charAt(0).toUpperCase() + rule.slice(1);
    
    testCases.push(makeTestCase(
      `Verify successful execution: ${ruleCap}`,
      "Positive",
      `${acTag} User is authorized and system is initialized in default state.`,
      `1. Navigate to the target module or form section.\n2. Input valid operational parameters matching "${rule}".\n3. Trigger the submission or activation control.\n4. Verify success confirmation message.`,
      `The operation succeeds. The system processes the request immediately and displays positive confirmation status.`,
      i === 0 ? "High" : "Medium"
    ));
  }

  // 2. Generate Negative Cases
  for (let i = 0; i < negativeCount; i++) {
    const rule = uniqueRules[i % uniqueRules.length];
    const acTag = `[AC${(i % uniqueRules.length) + 1}]`;
    const ruleCap = rule.charAt(0).toUpperCase() + rule.slice(1);

    testCases.push(makeTestCase(
      `Verify error prevention: ${ruleCap} with invalid/blank parameters`,
      "Negative",
      `${acTag} User is authorized and system form is open.`,
      `1. Focus on the required inputs or controls for "${rule}".\n2. Clear required values or enter invalid format values.\n3. Attempt to save or submit the action.\n4. Observe validation highlights and error messages.`,
      `Submission is rejected. System displays inline validation errors, highlights affected fields in red, and prevents invalid transaction processing.`,
      "High"
    ));
  }

  // 3. Generate Edge Cases
  for (let i = 0; i < edgeCount; i++) {
    const rule = uniqueRules[i % uniqueRules.length];
    const acTag = `[AC${(i % uniqueRules.length) + 1}]`;
    const ruleCap = rule.charAt(0).toUpperCase() + rule.slice(1);

    testCases.push(makeTestCase(
      `Verify edge boundary limits for: ${ruleCap}`,
      "Edge",
      `${acTag} Input fields for "${rule}" are active and ready.`,
      `1. Input extreme values (e.g. maximum length limits, special characters, boundary numeric values).\n2. Submit the form.\n3. Verify database storage representation and UI output.`,
      `The system handles the boundary parameters safely without crashes, SQL errors, or text truncation.`,
      "Medium"
    ));
  }

  // 4. Generate Security Cases
  for (let i = 0; i < securityCount; i++) {
    const rule = uniqueRules[i % uniqueRules.length];
    const acTag = `[AC${(i % uniqueRules.length) + 1}]`;
    const ruleCap = rule.charAt(0).toUpperCase() + rule.slice(1);

    testCases.push(makeTestCase(
      `Verify unauthorized access constraints on: ${ruleCap}`,
      "Security",
      `${acTag} User session is expired, unauthenticated, or has insufficient privileges.`,
      `1. Direct browse to the URL path or API endpoints for "${rule}".\n2. Attempt to trigger the action.\n3. Check server response.`,
      `Access is denied immediately. Server returns 401 Unauthorized or 403 Forbidden status, redirecting user to Login page.`,
      "High"
    ));
  }

  // 5. Generate Performance Cases
  for (let i = 0; i < performanceCount; i++) {
    const rule = uniqueRules[i % uniqueRules.length];
    const acTag = `[AC${(i % uniqueRules.length) + 1}]`;
    const ruleCap = rule.charAt(0).toUpperCase() + rule.slice(1);

    testCases.push(makeTestCase(
      `Verify transaction speed under load for: ${ruleCap}`,
      "Performance",
      `${acTag} Simulated database load is active (1000+ records).`,
      `1. Open developer tools network analyzer.\n2. Trigger the action for "${rule}".\n3. Capture response latency.`,
      `The operation finishes in under 500ms, maintaining UI responsiveness at 60 FPS.`,
      "Medium"
    ));
  }

  return testCases.map((tc, idx) => mapTestCaseToFormat(tc, format, idx));
}


const MOCK_FEATURE_TESTS = {
  login: {
    title: "Login Feature",
    cases: [
      {
        customId: "TC001",
        title: "Verify login with valid credentials",
        type: "Positive",
        preconditions: "[AC1] User is on login page.",
        steps: "1. Enter valid email.\n2. Enter valid password.\n3. Click Login.",
        expectedResult: "User is authenticated and redirected to Dashboard.",
        priority: "High",
        testPath: "/Auth/Login",
        testName: "Valid Login",
        designer: "QA Team",
        category: "Authentication",
        stepName: "Submit Credentials",
        stepDescription: "1. Type valid email.\n2. Type valid password.\n3. Click Submit.",
        evidenceRequired: "Yes",
        testSummary: "Successful user authentication via credentials",
        testCaseDescription: "Verify user is successfully logged in with valid details.",
        stepsToBeFollowed: "1. Provide credentials.\n2. Submit form.",
        actualResult: "N/A",
        description: "Login with valid credentials",
        testData: "user@example.com / Pass123",
        testSteps: "1. Input credentials.\n2. Click Login.",
        status: "Pending",
        bugId: "N/A"
      },
      {
        customId: "TC002",
        title: "Verify validation error on empty fields",
        type: "Negative",
        preconditions: "[AC2] User on login screen.",
        steps: "1. Click Login button without inputs.",
        expectedResult: "Validation error 'Email and password required' is shown.",
        priority: "High",
        testPath: "/Auth/Login",
        testName: "Empty Input Check",
        designer: "QA Team",
        category: "Authentication",
        stepName: "Submit Empty Form",
        stepDescription: "1. Trigger login action without entering data.",
        evidenceRequired: "No",
        testSummary: "Fields validation on empty input submission",
        testCaseDescription: "Verify validation alerts display on empty fields.",
        stepsToBeFollowed: "1. Select Login without inputting values.",
        actualResult: "N/A",
        description: "Submit blank login inputs",
        testData: "None",
        testSteps: "1. Trigger submission.",
        status: "Pending",
        bugId: "N/A"
      },
      {
        customId: "TC003",
        title: "Verify login attempt with wrong password",
        type: "Negative",
        preconditions: "[AC1] Registered account exists.",
        steps: "1. Enter valid email.\n2. Enter invalid password.\n3. Click Login.",
        expectedResult: "Access denied; 'Invalid email or password' alert shown.",
        priority: "High",
        testPath: "/Auth/Login",
        testName: "Invalid Credential Login",
        designer: "QA Team",
        category: "Authentication",
        stepName: "Input Incorrect Password",
        stepDescription: "1. Type email.\n2. Type wrong password.\n3. Click Login.",
        evidenceRequired: "Yes",
        testSummary: "Authentication fail on wrong password",
        testCaseDescription: "Verify system shows alert for incorrect password.",
        stepsToBeFollowed: "1. Type email.\n2. Type wrong password.\n3. Click Login.",
        actualResult: "N/A",
        description: "Authentication with wrong password",
        testData: "wrongpass123",
        testSteps: "1. Type wrong credentials.\n2. Click Login.",
        status: "Pending",
        bugId: "N/A"
      },
      {
        customId: "TC004",
        title: "Verify password field masking in UI",
        type: "Security",
        preconditions: "[AC3] Password input element exists.",
        steps: "1. Type characters in password field.\n2. Verify masking.",
        expectedResult: "Input characters are masked with bullets.",
        priority: "Medium",
        testPath: "/Auth/Login",
        testName: "Password Input Masking",
        designer: "QA Team",
        category: "Authentication",
        stepName: "Observe password input",
        stepDescription: "1. Enter text in password input field.\n2. Confirm masking.",
        evidenceRequired: "No",
        testSummary: "Observe password text visibility",
        testCaseDescription: "Verify character masking for secure typing.",
        stepsToBeFollowed: "1. Type text in password input.",
        actualResult: "N/A",
        description: "Password masking check",
        testData: "SecretPass",
        testSteps: "1. Type credentials.\n2. Check mask.",
        status: "Pending",
        bugId: "N/A"
      }
    ]
  },
  payment: {
    title: "Payment Checkout Integration",
    cases: [
      {
        customId: "TC001",
        title: "Verify successful payment process using card",
        type: "Positive",
        preconditions: "[AC1] Items are ready in checkout cart.",
        steps: "1. Enter card details.\n2. Submit transaction.",
        expectedResult: "Transaction succeeds; Order confirmed screen displayed.",
        priority: "High",
        testPath: "/Cart/Payment",
        testName: "Successful Checkout",
        designer: "QA Team",
        category: "Payment Integration",
        stepName: "Pay with valid card",
        stepDescription: "1. Fill credit card details.\n2. Complete transaction.",
        evidenceRequired: "Yes",
        testSummary: "Checkout successfully with active card",
        testCaseDescription: "Verify transaction goes through with valid card.",
        stepsToBeFollowed: "1. Input card parameters.\n2. Click pay.",
        actualResult: "N/A",
        description: "Payment with valid card details",
        testData: "Card Number=4111222233334444",
        testSteps: "1. Enter card details.\n2. Click pay.",
        status: "Pending",
        bugId: "N/A"
      },
      {
        customId: "TC002",
        title: "Verify transaction fail error warning",
        type: "Negative",
        preconditions: "[AC2] Transaction processor online.",
        steps: "1. Enter credit card with insufficient funds.\n2. Trigger payment.",
        expectedResult: "Transaction failed; error message 'Insufficient funds' is shown.",
        priority: "High",
        testPath: "/Cart/Payment",
        testName: "Declined Card Handling",
        designer: "QA Team",
        category: "Payment Integration",
        stepName: "Pay with declined card",
        stepDescription: "1. Fill declined credit card details.\n2. Complete transaction.",
        evidenceRequired: "Yes",
        testSummary: "Checkout failure on declined card payment",
        testCaseDescription: "Verify system shows alert when card transaction is declined.",
        stepsToBeFollowed: "1. Input declined card parameters.\n2. Click pay.",
        actualResult: "N/A",
        description: "Payment with declined card details",
        testData: "Declined Card",
        testSteps: "1. Enter declined card details.\n2. Click pay.",
        status: "Pending",
        bugId: "N/A"
      },
      {
        customId: "TC003",
        title: "Verify security of payment details transmission",
        type: "Security",
        preconditions: "[AC3] Network listener is active.",
        steps: "1. Initiate payment.\n2. Capture payload parameters.",
        expectedResult: "Card number, CVV, and expiration date are fully encrypted.",
        priority: "High",
        testPath: "/Cart/Payment",
        testName: "Payment Encryption Audit",
        designer: "QA Team",
        category: "Payment Integration",
        stepName: "Audit transaction payload",
        stepDescription: "1. Capture payment request payload.\n2. Verify encryption.",
        evidenceRequired: "Yes",
        testSummary: "Billing information transit encryption check",
        testCaseDescription: "Verify sensitive details are encrypted in transit.",
        stepsToBeFollowed: "1. Capture POST request.\n2. Confirm security encryption.",
        actualResult: "N/A",
        description: "Card details encryption check",
        testData: "Card payloads",
        testSteps: "1. Verify network log encryption.",
        status: "Pending",
        bugId: "N/A"
      }
    ]
  },
  signup: {
    title: "Signup & Registration",
    cases: [
      {
        customId: "TC001",
        title: "Verify successful account creation with valid credentials",
        type: "Positive",
        preconditions: "[AC1] Guest user is on register view.",
        steps: "1. Enter valid email, name, and password.\n2. Accept Terms & Conditions.\n3. Click Register.",
        expectedResult: "Account is created successfully, user registered, and confirmation email sent.",
        priority: "High",
        testPath: "/Register/Signup",
        testName: "Successful Signup",
        designer: "QA Team",
        category: "Registration",
        stepName: "Fill and Submit Signup Details",
        stepDescription: "1. Provide email.\n2. Provide password.\n3. Click Submit.",
        evidenceRequired: "Yes",
        testSummary: "Create account with valid registration credentials",
        testCaseDescription: "Verify guest user can successfully create a new account.",
        stepsToBeFollowed: "1. Complete registration fields.\n2. Submit account creation.",
        actualResult: "N/A",
        description: "Create account with valid details",
        testData: "guest@example.com / Password123!",
        testSteps: "1. Enter credentials.\n2. Submit signup.",
        status: "Pending",
        bugId: "N/A"
      },
      {
        customId: "TC002",
        title: "Verify invalid email format validation warning",
        type: "Negative",
        preconditions: "[AC2] Field validations are active.",
        steps: "1. Enter invalid email (e.g. guest@com).\n2. Click Register.",
        expectedResult: "Form blocks submission and highlights email field with 'Invalid email address' error.",
        priority: "Medium",
        testPath: "/Register/Signup",
        testName: "Email Format Validation",
        designer: "QA Team",
        category: "Registration",
        stepName: "Input Bad Email",
        stepDescription: "1. Provide invalid email pattern.\n2. Click signup.",
        evidenceRequired: "No",
        testSummary: "Format validation alert on malformed email",
        testCaseDescription: "Verify signup is blocked for malformed email addresses.",
        stepsToBeFollowed: "1. Input invalid email address.\n2. Click signup.",
        actualResult: "N/A",
        description: "Email structure check",
        testData: "guest_invalid_mail",
        testSteps: "1. Try signup with invalid email format.",
        status: "Pending",
        bugId: "N/A"
      }
    ]
  },
  search: {
    title: "Search & Filtering Functionality",
    cases: [
      {
        customId: "TC001",
        title: "Verify accurate search results display",
        type: "Positive",
        preconditions: "[AC1] Product list database is loaded.",
        steps: "1. Type valid query (e.g. 'Laptop') in search input.\n2. Press Enter or click Search.",
        expectedResult: "Products matching the query are displayed correctly.",
        priority: "High",
        testPath: "/Search/SearchList",
        testName: "Successful Search Query",
        designer: "QA Team",
        category: "Search & Filter",
        stepName: "Input search term",
        stepDescription: "1. Enter valid keyword in search bar.\n2. Trigger search.",
        evidenceRequired: "Yes",
        testSummary: "Search lists products matching query",
        testCaseDescription: "Verify search returns correct matching items.",
        stepsToBeFollowed: "1. Search for keyword.\n2. Inspect results.",
        actualResult: "N/A",
        description: "Search results with valid query",
        testData: "keyword='Laptop'",
        testSteps: "1. Type search query.\n2. Confirm product results.",
        status: "Pending",
        bugId: "N/A"
      },
      {
        customId: "TC002",
        title: "Verify empty results state message",
        type: "Positive",
        preconditions: "[AC2] Search function active.",
        steps: "1. Type query with no products (e.g. 'xyz123abc').\n2. Click Search.",
        expectedResult: "Zero results returned; message 'No matching products found' is displayed.",
        priority: "Medium",
        testPath: "/Search/SearchList",
        testName: "No Matches Display",
        designer: "QA Team",
        category: "Search & Filter",
        stepName: "Search unmatched query",
        stepDescription: "1. Type unmatched key.\n2. Trigger search.",
        evidenceRequired: "No",
        testSummary: "Verify search empty state message",
        testCaseDescription: "Verify system handles non-existent queries with empty state.",
        stepsToBeFollowed: "1. Submit unmatched search term.\n2. Verify empty state text.",
        actualResult: "N/A",
        description: "Search empty results state",
        testData: "keyword='xyz123abc'",
        testSteps: "1. Type non-existent query.\n2. Check empty state display.",
        status: "Pending",
        bugId: "N/A"
      }
    ]
  },
  upload: {
    title: "File Attachment & Document Upload",
    cases: [
      {
        customId: "TC001",
        title: "Verify successful upload of supported document formats",
        type: "Positive",
        preconditions: "[AC1] User is on upload field.",
        steps: "1. Click attachment select.\n2. Select a PDF file under 10MB.\n3. Click upload.",
        expectedResult: "Upload is successful; file is visible in files list.",
        priority: "High",
        testPath: "/Upload/Files",
        testName: "Successful PDF Upload",
        designer: "QA Team",
        category: "Uploads",
        stepName: "Attach valid file",
        stepDescription: "1. Choose valid PDF.\n2. Submit attachment.",
        evidenceRequired: "Yes",
        testSummary: "Attach supported PDF file successfully",
        testCaseDescription: "Verify PDF upload operates correctly.",
        stepsToBeFollowed: "1. Select document.\n2. Click Upload.",
        actualResult: "N/A",
        description: "PDF format attachment upload",
        testData: "sample_doc.pdf (5MB)",
        testSteps: "1. Select sample_doc.pdf.\n2. Press Upload.",
        status: "Pending",
        bugId: "N/A"
      },
      {
        customId: "TC002",
        title: "Verify warning prompt on unsupported format upload",
        type: "Negative",
        preconditions: "[AC2] Format validation active.",
        steps: "1. Select file with unsupported extension (e.g. .exe).\n2. Attempt upload.",
        expectedResult: "Upload fails; validation displays 'File type not supported' warning.",
        priority: "High",
        testPath: "/Upload/Files",
        testName: "Unsupported Type Check",
        designer: "QA Team",
        category: "Uploads",
        stepName: "Attach exe file",
        stepDescription: "1. Choose executable file.\n2. Attempt upload.",
        evidenceRequired: "No",
        testSummary: "Warning warning alert on unsupported file format",
        testCaseDescription: "Verify file uploads block unsupported extensions.",
        stepsToBeFollowed: "1. Select invalid format.\n2. Check validation alert.",
        actualResult: "N/A",
        description: "Upload unsupported format check",
        testData: "virus.exe",
        testSteps: "1. Choose virus.exe.\n2. Inspect warning alert.",
        status: "Pending",
        bugId: "N/A"
      }
    ]
  }
};

function getMockFeatureTestCases(query, format) {
  const q = query.toLowerCase();
  let matchedKey = null;
  
  if (q.includes('login') || q.includes('signin') || q.includes('sign-in')) {
    matchedKey = 'login';
  } else if (q.includes('signup') || q.includes('register') || q.includes('sign-up') || q.includes('registration')) {
    matchedKey = 'signup';
  } else if (q.includes('payment') || q.includes('checkout') || q.includes('cart') || q.includes('purchase') || q.includes('billing') || q.includes('card')) {
    matchedKey = 'payment';
  } else if (q.includes('search') || q.includes('filter') || q.includes('find')) {
    matchedKey = 'search';
  } else if (q.includes('upload') || q.includes('import') || q.includes('attachment') || q.includes('file')) {
    matchedKey = 'upload';
  }
  
  if (!matchedKey) return null;
  
  const feature = MOCK_FEATURE_TESTS[matchedKey];
  const mappedCases = feature.cases.map((tc, idx) => mapTestCaseToFormat(tc, format, idx));
  return {
    title: feature.title,
    cases: mappedCases
  };
}

function formatMockTestCasesToMarkdown(cases, format) {
  return cases.map((tc, idx) => {
    if (format === 'LLY TU') {
      return `**[${tc.type}] ${tc.customId}: ${tc.testName}**\n` +
             `*Path:* \`${tc.testPath}\` | *Designer:* ${tc.designer} | *Category:* ${tc.category}\n` +
             `*Preconditions:* ${tc.preconditions}\n` +
             `*Step (${tc.stepName}):*\n${tc.stepDescription.replace(/\n/g, '\n')}\n` +
             `*Expected:* ${tc.expectedResult}\n` +
             `*Evidence:* ${tc.evidenceRequired}`;
    } else if (format === 'LLY PBPA') {
      return `**[${tc.type}] ${tc.customId}: ${tc.testSummary}**\n` +
             `*Preconditions:* ${tc.preconditions}\n` +
             `*Description:* ${tc.testCaseDescription}\n` +
             `*Steps:* \n${tc.stepsToBeFollowed.replace(/\n/g, '\n')}\n` +
             `*Expected:* ${tc.expectedResult}`;
    } else if (format === 'DEL') {
      return `**[${tc.type}] ${tc.customId}: ${tc.description}**\n` +
             `*Preconditions:* ${tc.preconditions}\n` +
             `*Test Data:* \`${tc.testData}\` | *Status:* ${tc.status}\n` +
             `*Steps:*\n${tc.testSteps.replace(/\n/g, '\n')}\n` +
             `*Expected:* ${tc.expectedResult}`;
    } else {
      return `**[${tc.type}] ${tc.customId}: ${tc.title}**\n` +
             `*Preconditions:* ${tc.preconditions}\n` +
             `*Steps:*\n${tc.steps.replace(/\n/g, '\n')}\n` +
             `*Expected:* ${tc.expectedResult}\n` +
             `*Priority:* ${tc.priority}`;
    }
  }).join('\n\n');
}

async function generateDynamicMockChatResponse(chatId, provider, content, hasKey = false, format = 'Default') {
  const raw   = (content || '').trim();
  const query = raw.toLowerCase();
  const providerLabel = provider === 'claude'   ? 'Claude Opus 4.8' :
                        provider === 'chatgpt'  ? 'ChatGPT GPT-5.5' :
                        provider === 'copilot'  ? 'Microsoft Copilot (GPT-5.5 + multi-model)' :
                                                  'Gemini 3.5 Flash';
  const providerShort = provider === 'claude'   ? 'Claude' :
                        provider === 'chatgpt'  ? 'ChatGPT' :
                        provider === 'copilot'  ? 'Copilot' :
                                                  'Gemini';

  // Fetch context story for this chat
  let activeStory = null;
  try {
    activeStory = await prisma.userStory.findFirst({
      where: { chatId },
      include: { testCases: true, acceptanceCriteria: true }
    });
  } catch (err) {
    console.error('Error fetching context story for mock response:', err.message);
  }

  // ── 1. GREETINGS ──
  const isGreeting = /^(h+i+|h+e+l+o+|h+e+y+|yo+|howdy|what'?s up|sup|good (morning|afternoon|evening)|namaste|hola|greetings|wassup)[\.!\?]*$/.test(query);
  if (isGreeting) {
    const greetings = ['Hey there! 👋', 'Hello! 😊', 'Hi! 👋', 'Hey! Great to see you! 😄'];
    const g = greetings[Math.floor(Math.random() * greetings.length)];
    let ctx = '';
    if (activeStory) ctx = ` I see we're working on **"${activeStory.title}"** — ${activeStory.testCases.length} test case${activeStory.testCases.length !== 1 ? 's' : ''} generated so far.`;
    const note = hasKey
      ? `\n\n> ⚠️ *${providerShort} API quota exhausted — add billing credits to restore live AI.*`
      : `\n\n> 💡 *Tip: Add your ${providerShort} API key in ⚙️ Settings for real AI responses.*`;
    return `${g} I'm your **${providerLabel}** QA assistant.${ctx} What can I help you with today? You can ask me to:\n- Generate or refine test cases\n- Explain a feature or format\n- Review acceptance criteria\n- Help with Jira export or dry-run${note}`;
  }

  // ── 2. HOW ARE YOU / SMALL TALK ──
  if (/how are you|how r u|how do you do|you good|you okay|you alright/.test(query)) {
    return `I'm doing great, thanks for asking! 😊 Ready to help you build bulletproof test suites. What would you like to work on?`;
  }

  // ── 3. THANKS / THANK YOU ──
  if (/^(thanks?|thank you|ty|thx|cheers|great|awesome|perfect|got it|nice|cool)[\.!\?]*$/.test(query)) {
    return `You're welcome! 😊 Let me know if there's anything else I can help with — more test cases, edge cases, or a quick dry-run review!`;
  }

  // ── 4. WHAT CAN YOU DO / HELP ──
  if (/what can you do|what do you do|help me|how do i use|capabilities|features/.test(query)) {
    return `Here's what I can help you with as **${providerLabel}**:\n\n📝 **Test Case Generation** — Generate positive, negative, edge, security & performance test cases from your user story\n📄 **Document Analysis** — Upload a requirements document and I'll generate full test suites\n🔄 **Dry-Run Simulation** — Walk through test cases step by step and log results\n📤 **Jira / CSV Export** — Export your test suites in one click\n💬 **Chat & Refine** — Ask follow-up questions to tweak, expand, or reformat any test case\n\nJust ask me anything! 🚀`;
  }

  // ── 5. CONNECT / API KEY / ONLINE MODE ──
  if (/connect|online mode|api key|offline|how to use|activate/.test(query)) {
    return `### Connect **${providerLabel}** to Live Mode\n\n1. Click **⚙️ Settings** (bottom-left sidebar)\n2. Select **${providerLabel}** from the Model Provider dropdown\n3. Paste your API key:\n   - **Gemini** → [Google AI Studio](https://aistudio.google.com/app/apikey) *(Free tier available)*\n   - **ChatGPT / Copilot** → [OpenAI Platform](https://platform.openai.com/api-keys)\n   - **Claude** → [Anthropic Console](https://console.anthropic.com/)\n4. Click **Save Settings**\n\nThe status badge will switch to **⚡ ${providerLabel.split(' ')[0]} Connected** and you'll get real AI responses instantly!`;
  }

  // ── 6. JIRA / EXPORT / DOWNLOAD (Matches specific intent before general test cases check) ──
  if (/jira|export|csv|json|download/.test(query)) {
    return `You can export and download your test suites in multiple formats:\n\n- **💼 Jira Export** — Copies a markdown table ready to paste into a Jira description\n- **📥 JSON Export** — Full structured data export of your test cases\n- **📊 CSV Export** — Spreadsheet-compatible download format\n\nTo export, head to the **Test Cases Repository** tab, select the active user story, and click the export button of your choice!`;
  }

  // ── 7. DRY RUN ──
  if (/dry.?run|execute|simulate|run test/.test(query)) {
    return `The **Dry-Run Simulator** lets you manually execute test cases step by step:\n\n1. Go to **Test Cases Repository** tab\n2. Click **▶️ Start Dry-Run**\n3. Mark each step as ✅ Passed, ❌ Failed, or 🔶 Blocked\n4. All results are saved to the SQLite database automatically\n\nWant me to walk you through any specific test case?`;
  }

  // ── 8. FORMATS ──
  if (/format|lly tu|lly pbpa|del format|template/.test(query)) {
    return `QAutopilot supports **3 test case formats**:\n\n- **LLY TU** — Includes Test Path, Designer, Category, Step Name\n- **LLY PBPA** — Focuses on Test Summary, Steps, and Expected Result\n- **DEL** — Sequential IDs (TC001...) with Test Data and Bug ID fields\n\nSelect your format from the dropdown before generating — the entire suite adapts automatically!`;
  }

  // ── 9. FEATURE-SPECIFIC TEST CASE REQUESTS (Dynamic offline mock generator) ──
  const mockFeature = getMockFeatureTestCases(query, format);
  if (mockFeature) {
    const mdList = formatMockTestCasesToMarkdown(mockFeature.cases, format);
    const note = hasKey
      ? `\n\n> ⚠️ *${providerShort} API quota exhausted — add billing credits to restore live AI.*`
      : `\n\n> 💡 *Tip: Connect your API key in ⚙️ Settings to generate custom suites from any user story.*`;
    return `### Dynamic Mock Test Cases: ${mockFeature.title} (Format: **${format}**)\n\n${mdList}${note}`;
  }

  // ── 10. GENERAL TEST CASES FALLBACK ──
  if (/test case|testcase|scenario|write test|generate test|add test/.test(query)) {
    if (activeStory && activeStory.testCases.length > 0) {
      const list = activeStory.testCases.slice(0, 5).map(tc => `- **${tc.customId || 'TC'} (${tc.type}):** ${tc.title}`).join('\n');
      const extra = activeStory.testCases.length > 5 ? `\n...and ${activeStory.testCases.length - 5} more.` : '';
      return `Here's a summary of the test suite for **"${activeStory.title}"**:\n\n${list}${extra}\n\nWant me to add more edge cases, security checks, or reformat these into a specific template?`;
    }
    return `I'd love to help write test cases! 📝 Here's a quick example for a **Login** feature:\n\n1. **TC001 (Positive):** Login with valid credentials → Redirected to dashboard\n2. **TC002 (Negative):** Login with wrong password → Error message shown\n3. **TC003 (Edge):** Password field with 256 characters → Handled gracefully\n4. **TC004 (Security):** Password masked in UI & encrypted in transit\n5. **TC005 (Performance):** Login response within 1.5 seconds\n\nPaste your user story in the generator to create a full custom suite!`;
  }

  // ── 11. GENERAL FALLBACK — smart, contextual, not robotic ──
  const smartReplies = [
    `That's a great question! Let me help you with that.`,
    `Sure, I can help with that!`,
    `Absolutely! Here's what I know about this topic.`,
    `Great point — let me break this down for you.`
  ];
  const opener = smartReplies[Math.floor(Math.random() * smartReplies.length)];

  let ctxBlock = '';
  if (activeStory) {
    ctxBlock = `\n\nIn the context of **"${activeStory.title}"**, I'd suggest:\n1. Verify all UI fields and buttons respond as expected.\n2. Add edge cases for boundary data inputs.\n3. Include a security test for any authentication or data submission flows.\n4. Check performance under typical and peak load conditions.`;
  }

  const apiNote = hasKey
    ? `\n\n> ⚠️ *${providerShort} API quota exhausted — add billing credits to restore live AI responses.*`
    : `\n\n> 💡 *Add your ${providerShort} API key in ⚙️ Settings to unlock real AI-powered answers.*`;

  return `${opener}\n\nYou asked: *"${raw}"*${ctxBlock}${apiNote}`;
}

// --- HELPER: GEMINI API CALL WITH FALLBACKS ---
async function callGeminiApi(payload, apiKey) {
  const endpoints = [
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`
  ];

  let lastError = null;
  for (const url of endpoints) {
    try {
      console.log(`[Gemini API] Requesting endpoint: ${url.split('?')[0]}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const resText = await response.text();
      if (response.ok) {
        const resData = JSON.parse(resText);
        if (resData.candidates && resData.candidates[0] && resData.candidates[0].content && resData.candidates[0].content.parts && resData.candidates[0].content.parts[0]) {
          return resData;
        }
      }

      console.warn(`[Gemini API Warning] Endpoint failed: ${url.split('?')[0]}. Status: ${response.status}. Response: ${resText}`);
      if (response.status === 404) {
        try {
          const listUrl = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
          const listRes = await fetch(listUrl);
          if (listRes.ok) {
            const listData = await listRes.json();
            const modelNames = listData.models ? listData.models.map(m => m.name) : [];
            console.log(`[Gemini API Diagnostic] Available models for this key:`, modelNames);
          } else {
            console.warn(`[Gemini API Diagnostic] Failed to list models:`, await listRes.text());
          }
        } catch (listErr) {
          console.warn(`[Gemini API Diagnostic] Error listing models:`, listErr.message);
        }
      }
      lastError = new Error(`Gemini API Error: ${resText}`);
    } catch (err) {
      console.warn(`[Gemini API Warning] Connection failed for ${url.split('?')[0]}: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError || new Error("Failed to get response from Gemini API after trying all endpoints.");
}

// --- GLOBAL CHATBOT SYSTEM PROMPT ---
const CHATBOT_SYSTEM_PROMPT = `You are QAutopilot, a world-class QA Automation Engineer.
When users ask you to write, modify, analyze, or suggest test cases:
1. **Strict Context Adherence**: Base your responses strictly on the provided user story, acceptance criteria, or reference document. Never assume or invent functionality, fields, inputs, or system actions that are not explicitly documented.
2. **Zero Boilerplate (Faltu) Scenarios**: Absolutely exclude Visual/UI style checks, generic performance SLAs, generic server connection drops, and standard security attacks (like generic SQLi/XSS) unless the specification explicitly defines them.
3. **Structured Test Case Formatting**: Format every proposed test case clearly with:
   - **ID**: Sequential TC ID (e.g., TC001)
   - **Title**: Clear, action-oriented behavior verification
   - **Type**: Positive, Negative, Edge, Security, or Performance
   - **Preconditions**: Starting state and Acceptance Criteria mapping (e.g., [AC1])
   - **Steps**: Numbered operational steps with concrete input values (never write vague data placeholders like "enter valid details")
   - **Expected Result**: Verifiable change or specific error message
4. **Professional Tone**: Keep your responses concise, technical, direct, and focused on QA validation.`;

// --- HELPER: GEMINI CHAT COMPLETION ---
async function getGeminiChatResponse(chatId, newContent, apiKey, format = 'Default') {
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
    return await generateDynamicMockChatResponse(chatId, 'gemini', newContent, false, format);
  }

  try {
    const resData = await callGeminiApi({
      contents,
      systemInstruction: { parts: [{ text: CHATBOT_SYSTEM_PROMPT }] }
    }, apiKey);
    return resData.candidates[0].content.parts[0].text;
  } catch (err) {
    console.warn('[Gemini] API failed, falling back to mock mode:', err.message);
    return await generateDynamicMockChatResponse(chatId, 'gemini', newContent, true, format);
  }
}

// --- HELPER: OPENAI/CHATGPT CHAT COMPLETION ---
async function getOpenAiChatResponse(chatId, newContent, apiKey, format = 'Default') {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const messages = [
    { role: 'system', content: CHATBOT_SYSTEM_PROMPT }
  ];

  previousMessages.forEach(msg => {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    });
  });

  messages.push({
    role: 'user',
    content: newContent
  });

  if (!apiKey) {
    return await generateDynamicMockChatResponse(chatId, 'chatgpt', newContent, false, format);
  }

  try {
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
      throw new Error(`OpenAI API Error: ${errText}`);
    }

    const resData = await response.json();
    return resData.choices[0].message.content;
  } catch (err) {
    console.warn('[ChatGPT] API failed, falling back to mock mode:', err.message);
    return await generateDynamicMockChatResponse(chatId, 'chatgpt', newContent, true, format);
  }
}

// --- HELPER: COPILOT CHAT COMPLETION ---
async function getCopilotChatResponse(chatId, newContent, apiKey, format = 'Default') {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const messages = [
    { role: 'system', content: CHATBOT_SYSTEM_PROMPT }
  ];

  previousMessages.forEach(msg => {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    });
  });

  messages.push({
    role: 'user',
    content: newContent
  });

  if (!apiKey) {
    return await generateDynamicMockChatResponse(chatId, 'copilot', newContent, false, format);
  }

  try {
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
  } catch (err) {
    console.warn('[Copilot] API failed, falling back to mock mode:', err.message);
    return await generateDynamicMockChatResponse(chatId, 'copilot', newContent, true, format);
  }
}

// --- HELPER: COPILOT TEST CASES GENERATOR ---
async function getCopilotTestCases(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, docContext, apiKey) {
  const promptText = buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, docContext);

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
  
  const parsed = parseCleanJson(rawText);
  return parsed.testCases || [];
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
  
  const parsed = parseCleanJson(rawText);
  return parsed;
}


// --- HELPER: OPENAI/CHATGPT TEST CASES GENERATOR ---
async function getOpenAiTestCases(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, docContext, apiKey) {
  const promptText = buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, docContext);

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
    throw new Error(`OpenAI API Error: ${errText}`);
  }

  const resData = await response.json();
  const rawText = resData.choices[0].message.content;
  
  const parsed = parseCleanJson(rawText);
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
      "description": "string (clear summary description of what this test case verifies)",
      "preconditions": "string (starting with AC tag mapping, e.g. [AC1] User is logged out)",
      "stepName": "string (name of this test step, e.g. Input credentials)",
      "stepDescription": "string (detailed step actions, e.g. 1. Type email\\n2. Type password)",
      "expectedResult": "string (expected result)",
      "evidenceRequired": "string (Yes or No)",
      "priority": "string (High, Medium, or Low)"
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
      "actualResult": "string (leave blank or use N/A)",
      "priority": "string (High, Medium, or Low)"
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
      "bugId": "string (leave blank or use N/A)",
      "priority": "string (High, Medium, or Low)"
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
      "description": "string (detailed description of what this test case verifies)",
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

function buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, docContext = '') {
  const formatInst = getFormatInstructions(format);
  return `
You are an expert QA Automation Engineer.
Generate QA test cases based on the following:

**User Story / BRD Requirements:**
${userStory}

**Acceptance Criteria:**
${acceptanceCriteria}

${docContext ? `**Uploaded Reference Document Context (PDF/DOCX/Code Specs):**\n${docContext}\n` : ''}

**Required Test Cases to Generate:**
${customizeVolume === false ? `
Generate only the absolute minimum, optimal number of test cases across all necessary types (Positive, Negative, Edge, Security, Performance) to fully cover the functional scenarios. Do NOT generate unnecessary, generic, repetitive, or redundant test cases. Each scenario must provide distinct testing value.
` : `
- Generate up to ${positiveCount} Positive test cases (type: "Positive")
- Generate up to ${negativeCount} Negative test cases (type: "Negative")
- Generate up to ${edgeCount} Edge test cases (type: "Edge")
- Generate up to ${securityCount} Security test cases (type: "Security")
- Generate up to ${performanceCount} Performance test cases (type: "Performance")
(Note: Do NOT generate redundant, generic, or filler test cases to meet these counts if the reference context does not support them. Quality and distinct coverage are paramount. If the specification only supports fewer high-value cases, output only those and skip the rest.)
`}

${existingTitles && existingTitles.length > 0 ? `**Existing Test Cases in Database (DO NOT DUPLICATE THESE):**\n${existingTitles.map((t, idx) => `${idx + 1}. ${t}`).join('\n')}\nYou must ensure all newly generated test cases are distinct from these existing ones.` : ''}

**CRITICAL QUALITY & ACCURACY INSTRUCTIONS:**
1. **Strict Core Alignment & Realism:** Every generated test case must map directly, precisely, and exclusively to the features, rules, parameters, validation thresholds, buttons, status transitions, and data fields described in the User Story, Acceptance Criteria, and Uploaded Reference Document Context. Do NOT invent or assume any functionality, fields, components, buttons, or workflows that are not explicitly specified in the reference context.
2. **STRICT REQUIREMENT BOUNDARY (MANDATORY):** You are strictly forbidden from writing test cases for any buttons, pages, fields, menus, inputs, user roles, or system actions that are not explicitly documented in the reference text. Treat all non-specified parameters and items as non-existent. Do not extend the scope, do not add best-practice features, and do not invent validation rules (e.g. if the document does not specify a length or formatting rule for a field, do not test validation limits for it; only verify that the field accepts input).
3. **EXCLUDED JUNK/BOILERPLATE (FALTU) SCENARIOS (STRICTLY PROHIBITED):**
   You MUST NOT generate any of the following boilerplate/filler scenarios under any circumstances unless they are explicitly and literally written in the document:
   - NO Visual/UI layout checks (e.g., verifying button color, hover effect, cursor type, margin, alignment, font sizes, or screen responsive layouts).
   - NO Generic Performance SLAs (e.g., verifying that page loads in under 2 seconds, TTFB, or general speed checks).
   - NO Generic Security scenarios (e.g., SQL injection, XSS inputs, CSRF, standard authentication timeouts) unless the document defines explicit security algorithms/keys.
   - NO Generic Network/Server errors (e.g., checking 500 internal server errors, internet disconnection, database connection failures).
   - NO Trivial navigation/clicks (e.g., verifying that clicking a Cancel button closes a popup or redirects to dashboard) unless there is complex conditional permission logic.
   - NO Invented form limits (e.g., do not test "Verify error when name is 100 characters" if the document does not mention name character limits).
4. **No Redundant or Split Validations:** Do NOT split identical form field validation flows into multiple test cases (e.g., do NOT generate "Verify error when field A is empty" and "Verify error when field B is empty" as separate scenarios). Group them into a single comprehensive test case: "Verify form validation errors when required fields are empty".
5. **Concrete Test Data & Precise Verification:** Never use vague placeholders like "enter valid data". Specify precise test inputs (e.g., exact emails, specific numerical values, boundaries) and the exact expected outputs (e.g., specific error texts like "Invalid Email Address format").
6. **Accurate BRD Mapping & Exhaustive Depth:** Every test case must be highly specific and map directly to a functional rule, button, validation check, or status transition described in the requirements. Write test cases with deep, comprehensive coverage and exhaustive details, including specific test inputs, data states, and navigation paths.
7. **Explicit Step Action Sequence:** Do NOT use single-sentence placeholder steps like "Perform actions." Instead, provide explicit, logical, step-by-step operational steps containing full action details.
8. **Boundary Value Analysis (BVA) & Equivalence Partitioning (EP) Values:** For every input field, you must explicitly inject concrete fuzzed values representing both valid and invalid partitions. For example, instead of writing "Enter invalid mobile number", write "Enter '+1-555' (invalid length)" or "Enter '9999999999' (valid number)".
9. **State Transition Testing (STT) Scenarios:** If the requirements define a workflow state machine (e.g. Draft -> Pending -> Approved), you must write specific scenarios verifying every valid status transition path, blocked invalid transition attempts (e.g. transition directly from Draft to Approved), and check that only authorized roles can trigger specific transitions.
10. **Verifiable Assertions in Expected Results:** Specify the exact visual or functional changes expected (e.g. specific error messages shown, status code transition, page redirects, field highlighting) rather than generic success descriptors.
11. **Zero Filler Scenarios:** Quality and functional depth are paramount. If the story only warrants 2 high-value test cases, generate ONLY those 2. Never generate junk scenarios just to reach requested counts.
12. **Acceptance Criteria Mapping:** You MUST map each test case to the Acceptance Criteria it validates by placing the matching AC tag (e.g. "[AC1]" or "[AC2]") at the very beginning of the "preconditions" field. For example: "preconditions": "[AC1] User is logged out." If no specific AC exists or the document is generic, use "[AC1]" as default. Do not make up fake AC numbers that do not correspond to the actual requirements.
13. **Sequential ID:** Generate sequential custom ID (e.g. "TC001", "TC002"...) for the test cases within this set, stored in the "customId" field.

**Strict Formatting & Speed Optimization Guidelines:**
${formatInst}
Return ONLY a valid, raw JSON object matching the schema. To optimize response speed and ensure successful parsing:
- Do NOT include any introductory or concluding text, explanations, or notes.
- Do NOT wrap the JSON block in markdown code block ticks (\`\`\`json or \`\`\`).
- Output the raw JSON directly as a single object.
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
      description: tc.description || tc.title || tc.testName || 'Verify the scenario.',
      preconditions: tc.preconditions || 'N/A',
      stepName: tc.stepName || 'Perform Action',
      stepDescription: tc.stepDescription || tc.steps || '1. Action.',
      expectedResult: tc.expectedResult || 'Expected Result.',
      evidenceRequired: tc.evidenceRequired || 'No',
      priority: tc.priority || 'Medium'
    };
  } else if (format === 'LLY PBPA') {
    return {
      customId: tc.customId || sequentialId,
      testSummary: tc.testSummary || tc.title || 'Generated Scenario',
      type: tc.type || 'Positive',
      preconditions: tc.preconditions || 'N/A',
      testCaseDescription: tc.testCaseDescription || tc.description || tc.title || tc.testSummary || 'Verify function.',
      description: tc.testCaseDescription || tc.description || tc.title || tc.testSummary || 'Verify function.',
      stepsToBeFollowed: tc.stepsToBeFollowed || tc.steps || '1. Action.',
      expectedResult: tc.expectedResult || 'Expected Result.',
      actualResult: tc.actualResult || 'N/A',
      priority: tc.priority || 'Medium'
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
      bugId: tc.bugId || 'N/A',
      priority: tc.priority || 'Medium'
    };
  } else {
    return {
      customId: tc.customId || sequentialId,
      title: tc.title || 'Generated Scenario',
      description: tc.description || tc.title || 'Verify function.',
      type: tc.type || 'Positive',
      preconditions: tc.preconditions || 'N/A',
      steps: tc.steps || '1. Action.',
      expectedResult: tc.expectedResult || 'Expected Result.',
      priority: tc.priority || 'Medium'
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
      description: tc.description || tc.title || tc.testName || 'Verify the functional flow of this test case.',
      stepName: tc.stepName || 'N/A',
      evidenceRequired: tc.evidenceRequired || 'No'
    };
  } else if (format === 'LLY PBPA') {
    title = tc.testSummary || tc.title || 'Generated Scenario';
    steps = tc.stepsToBeFollowed || tc.steps || '1. Action.';
    customFieldsObj = {
      testCaseDescription: tc.testCaseDescription || tc.description || tc.title || tc.testSummary || 'Verify the functional flow of this test case.',
      description: tc.testCaseDescription || tc.description || tc.title || tc.testSummary || 'Verify the functional flow of this test case.',
      actualResult: tc.actualResult || 'N/A'
    };
  } else if (format === 'DEL') {
    title = tc.description || tc.title || 'Generated Scenario';
    steps = tc.testSteps || tc.steps || '1. Action.';
    customFieldsObj = {
      testData: tc.testData || 'N/A',
      actualResult: tc.actualResult || 'N/A',
      bugId: tc.bugId || 'N/A',
      description: tc.description || tc.title || 'Verify the functional flow of this test case.'
    };
    if (tc.status) {
      // Use status if present, otherwise default to Pending
      priority = 'Medium';
    }
  } else {
    customFieldsObj = {
      description: tc.description || tc.title || 'Verify the functional flow of this test case.'
    };
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

// --- HELPER: CLAUDE CHAT COMPLETION (with model fallback chain) ---
async function getClaudeChatResponse(chatId, newContent, apiKey, format = 'Default') {
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
    return await generateDynamicMockChatResponse(chatId, 'claude', newContent, false, format);
  }

  const claudeModels = [
    'claude-3-5-sonnet-latest',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-latest',
    'claude-3-opus-latest'
  ];

  const url = 'https://api.anthropic.com/v1/messages';
  let lastErr = null;

  for (const model of claudeModels) {
    try {
      console.log(`[Claude] Trying model: ${model}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model, max_tokens: 2000, system: CHATBOT_SYSTEM_PROMPT, messages })
      });

      if (response.ok) {
        const resData = await response.json();
        return resData.content[0].text;
      }

      const errText = await response.text();
      console.warn(`[Claude] Model ${model} failed (${response.status}): ${errText}`);
      lastErr = new Error(errText);

      // Only try next model for 404 (not found) or 400 (bad model)
      if (response.status !== 404 && response.status !== 400) break;
    } catch (err) {
      lastErr = err;
      console.warn(`[Claude] Model ${model} threw error:`, err.message);
    }
  }

  console.warn('[Claude] All models failed, falling back to mock mode.');
  return await generateDynamicMockChatResponse(chatId, 'claude', newContent, true, format);
}

// --- HELPER: CLAUDE TEST CASES GENERATOR ---
async function getClaudeTestCases(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, docContext, apiKey) {
  const promptText = buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, docContext);

  const url = 'https://api.anthropic.com/v1/messages';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-latest',
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
  
  const parsed = parseCleanJson(rawText);
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
    const format = req.headers['x-format'] || 'Default';
    const apiKey = req.headers['x-api-key'] || (provider === 'claude' ? process.env.CLAUDE_API_KEY : provider === 'chatgpt' ? process.env.OPENAI_API_KEY : provider === 'copilot' ? process.env.COPILOT_API_KEY : process.env.GEMINI_API_KEY);

    console.log(`[CHAT_MESSAGE_REQUEST] Provider: ${provider} | Format: ${format} | Has Header Key: ${!!req.headers['x-api-key']} | Resolved Key Source: ${req.headers['x-api-key'] ? 'Client Header' : 'Backend Env'} | Key Length: ${apiKey ? apiKey.length : 0}`);

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
        aiResponseContent = await getClaudeChatResponse(chatId, content, apiKey, format);
      } else if (provider === 'chatgpt') {
        aiResponseContent = await getOpenAiChatResponse(chatId, content, apiKey, format);
      } else if (provider === 'copilot') {
        aiResponseContent = await getCopilotChatResponse(chatId, content, apiKey, format);
      } else {
        aiResponseContent = await getGeminiChatResponse(chatId, content, apiKey, format);
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
    const chat = await prisma.chat.findUnique({ where: { id: req.params.chatId } });
    if (chat) {
      await prisma.chat.delete({ where: { id: req.params.chatId } });
    }
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
      docContext = '',
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

    console.log(`[USER_STORY_REQUEST] Story Length: ${userStory ? userStory.length : 0} | AC Length: ${acceptanceCriteria ? acceptanceCriteria.length : 0} | Format: ${format} | Provider: ${req.headers['x-provider'] || 'gemini'}`);

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
      // Set existingTitles = [] so LLM generates a complete fresh set
      existingTitles = [];
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
    let usedMock = false;

    if (!apiKey) {
      console.log(`No API key for ${provider}. Using high-fidelity mock generator.`);
      usedMock = true;
      generatedRaw = generateMockTestCases(
        userStory,
        acceptanceCriteria,
        positiveCount,
        negativeCount,
        edgeCount,
        securityCount,
        performanceCount,
        format,
        docContext
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
          docContext,
          apiKey
        );
      } catch (err) {
        console.error('Claude API failed, falling back to mock:', err.message);
        usedMock = true;
        generatedRaw = generateMockTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format,
          docContext
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
          docContext,
          apiKey
        );
      } catch (err) {
        console.error('OpenAI API failed, falling back to mock:', err.message);
        usedMock = true;
        generatedRaw = generateMockTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format,
          docContext
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
          docContext,
          apiKey
        );
      } catch (err) {
        console.error('Copilot API failed, falling back to mock:', err.message);
        usedMock = true;
        generatedRaw = generateMockTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format,
          docContext
        );
      }
    } else {
      // Build prompt with context for Gemini
      const promptText = buildPromptText(userStory, acceptanceCriteria, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, docContext);

      try {
        const resData = await callGeminiApi({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { responseMimeType: 'application/json' }
        }, apiKey);

        const rawJsonText = resData.candidates[0].content.parts[0].text;
        const parsed = parseCleanJson(rawJsonText);
        generatedRaw = parsed.testCases || [];
      } catch (err) {
        console.error('Gemini API failed, falling back to mock:', err.message);
        usedMock = true;
        generatedRaw = generateMockTestCases(
          userStory,
          acceptanceCriteria,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          format,
          docContext
        );
      }
    }

    // 3. WIPE old test cases and acceptance criteria if matchedStory exists to allow fresh overwrite
    if (matchedStory) {
      await prisma.testCase.deleteMany({ where: { userStoryId: storyId } });
      await prisma.acceptanceCriterion.deleteMany({ where: { userStoryId: storyId } });
      await prisma.userStory.update({
        where: { id: storyId },
        data: {
          description: userStory || ''
        }
      });
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

    const savedTestCases = [];
    let duplicateCount = 0;

    for (const tc of generatedRaw) {
      const cleanedTitle = (tc.title || tc.testName || tc.testSummary || tc.description || '').toLowerCase().trim();
      const isDuplicate = savedTestCases.some(saved => saved.title.toLowerCase().trim() === cleanedTitle);
      
      if (isDuplicate) {
        duplicateCount++;
        continue;
      }

      const idx = savedTestCases.length;
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
            title: 'QAutopilot: ' + (userStory.substring(0, 20) || 'Test Cases'),
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

      let prefix = '';
      if (usedMock) {
        prefix = `⚠️ **Notice: Offline Heuristic Mode Active.** No API Key was detected (or API request failed). QAutopilot has generated template test cases based on keyword matches. To generate accurate, custom test cases from your document, please save your API Key in Settings.\n\n`;
      }
      const aiResponseContent = prefix + `**Generated ${savedTestCases.length} Test Cases successfully.**` + 
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
${documentText.substring(0, 50000)}

Tasks:
1. Extract a clear, concise User Story summarizing the primary features described in the document (format as: "As a..., I want to..., so that...").
2. Extract the Acceptance Criteria (list at least 3-5 criteria, newline separated).
3. ${customizeVolume === false ? `Generate only the absolute minimum, optimal number of test cases across all necessary types (Positive, Negative, Edge, Security, Performance) to fully cover the requirements. Do NOT generate unnecessary, generic, repetitive, or redundant test cases. Each scenario must provide distinct testing value.` : `Generate up to ${positiveCount} Positive, up to ${negativeCount} Negative, up to ${edgeCount} Edge, up to ${securityCount} Security, and up to ${performanceCount} Performance test cases. Do NOT generate filler or redundant test cases to meet these counts if the reference context does not support them.`}

**CRITICAL ACCURACY & COMPREHENSIVENESS INSTRUCTIONS:**
- **Exhaustive Page-by-Page Coverage:** You MUST perform a thorough analysis of the entire uploaded document context. Do not skip any section, functional parameter, business logic, error condition, or edge limit mentioned in the text. Ensure test cases cover features described in the later sections of the document, not just the beginning.
- **Accurate Functional Traceability:** Every test case must map directly, precisely, and exclusively to features, rules, validation limits, user actions, buttons, and status transitions stated in the document. Do not invent any field or workflow that is not in the text, and do not ignore any specification that is.

**CRITICAL QUALITY & ACCURACY INSTRUCTIONS:**
1. **Strict Core Alignment & Realism:** Every generated test case must map directly, precisely, and exclusively to the features, rules, parameters, validation thresholds, buttons, status transitions, and data fields described in the Reference Document. Do NOT invent or assume any functionality, fields, components, buttons, or workflows that are not explicitly specified in the document text.
2. **STRICT REQUIREMENT BOUNDARY (MANDATORY):** You are strictly forbidden from writing test cases for any buttons, pages, fields, menus, inputs, user roles, or system actions that are not explicitly documented in the reference text. Treat all non-specified parameters and items as non-existent. Do not extend the scope, do not add best-practice features, and do not invent validation rules (e.g. if the document does not specify a length or formatting rule for a field, do not test validation limits for it; only verify that the field accepts input).
3. **EXCLUDED JUNK/BOILERPLATE (FALTU) SCENARIOS (STRICTLY PROHIBITED):**
   You MUST NOT generate any of the following boilerplate/filler scenarios under any circumstances unless they are explicitly and literally written in the document:
   - NO Visual/UI layout checks (e.g., verifying button color, hover effect, cursor type, margin, alignment, font sizes, or screen responsive layouts).
   - NO Generic Performance SLAs (e.g., verifying that page loads in under 2 seconds, TTFB, or general speed checks).
   - NO Generic Security scenarios (e.g., SQL injection, XSS inputs, CSRF, standard authentication timeouts) unless the document defines explicit security algorithms/keys.
   - NO Generic Network/Server errors (e.g., checking 500 internal server errors, internet disconnection, database connection failures).
   - NO Trivial navigation/clicks (e.g., verifying that clicking a Cancel button closes a popup or redirects to dashboard) unless there is complex conditional permission logic.
   - NO Invented form limits (e.g., do not test "Verify error when name is 100 characters" if the document does not mention name character limits).
4. **No Redundant or Split Validations:** Do NOT split identical form field validation flows into multiple test cases (e.g., do NOT generate "Verify error when field A is empty" and "Verify error when field B is empty" as separate scenarios). Group them into a single comprehensive test case: "Verify form validation errors when required fields are empty".
5. **Concrete Test Data & Precise Verification:** Never use vague placeholders like "enter valid data". Specify precise test inputs (e.g., exact emails, specific numerical values, boundaries) and the exact expected outputs (e.g., specific error texts like "Invalid Email Address format").
6. **Accurate BRD Mapping & Exhaustive Depth:** Every test case must be highly specific and map directly to a functional rule, button, validation check, or status transition described in the requirements. Write test cases with deep, comprehensive coverage and exhaustive details, including specific test inputs, data states, and navigation paths.
7. **Explicit Step Action Sequence:** Do NOT use single-sentence placeholder steps like "Perform actions." Instead, provide explicit, logical, step-by-step operational steps containing full action details.
8. **Boundary Value Analysis (BVA) & Equivalence Partitioning (EP):** For edge cases, specify the exact testing boundaries (e.g. minimum and maximum string lengths, negative numerical bounds, special character values) and the exact data parameters.
8. **Verifiable Assertions in Expected Results:** Specify the exact visual or functional changes expected (e.g. specific error messages shown, status code transition, page redirects, field highlighting) rather than generic success descriptors.
9. **Zero Filler Scenarios:** Quality and functional depth are paramount. If the story only warrants 2 high-value test cases, generate ONLY those 2. Never generate junk scenarios just to reach requested counts.
10. **Acceptance Criteria Mapping:** You MUST map each test case to the Acceptance Criteria it validates by placing the matching AC tag (e.g. "[AC1]" or "[AC2]") at the very beginning of the "preconditions" field. For example: "preconditions": "[AC1] User is logged out." If no specific AC exists or the document is generic, use "[AC1]" as default. Do not make up fake AC numbers that do not correspond to the actual requirements.
11. **Sequential ID:** Generate sequential custom ID (e.g. "TC001", "TC002"...) for the test cases within this set, stored in the "customId" field.

**Strict Formatting & Speed Optimization Guidelines:**
Response must be a valid, raw JSON object matching this schema:
{
  "userStory": "string",
  "acceptanceCriteria": "string",
  "testCases": [
    // List generated test case objects conforming to format schema below:
    // ${formatInst.trim().replace(/\n/g, '\n    // ')}
  ]
}

To optimize response speed and ensure successful parsing:
- Do NOT include any introductory or concluding text, explanations, or notes.
- Do NOT wrap the JSON block in markdown code block ticks (\`\`\`json or \`\`\`).
- Output the raw JSON directly as a single object.
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
      model: 'gpt-4o',
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
  
  return parseCleanJson(rawText);
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
      model: 'claude-3-5-sonnet-latest',
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
  
  return parseCleanJson(rawText);
}

async function getGeminiTestCasesFromDoc(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format, apiKey) {
  const promptText = buildDocPromptText(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, existingTitles, customizeVolume, format);

  const resData = await callGeminiApi({
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: { responseMimeType: 'application/json' }
  }, apiKey);

  const rawJsonText = resData.candidates[0].content.parts[0].text;
  return parseCleanJson(rawJsonText);
}

function generateMockTestCasesFromDoc(documentName, documentText, positiveCount, negativeCount, edgeCount, securityCount, performanceCount, format = 'Default') {
  const words = documentText.replace(/[^\w\s]/g, '').split(/\s+/).slice(0, 15).join(' ');
  const userStory = `As a QAutopilot analyst, I want to execute business features from "${documentName}" so that we verify system specs: ${words}...`;
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
      // Set existingTitles = [] so LLM generates a complete fresh set
      existingTitles = [];
      finalStoryId = matchedStory.id;
      isNewStory = false;
      console.log(`Matched existing story ${finalStoryId} for doc ${documentName}. Generating fresh test cases.`);
    }

    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || 
      (provider === 'claude' ? process.env.CLAUDE_API_KEY : 
       provider === 'chatgpt' ? process.env.OPENAI_API_KEY : 
       provider === 'copilot' ? process.env.COPILOT_API_KEY : 
       process.env.GEMINI_API_KEY);

    let result;
    let usedMock = false;
    if (!apiKey) {
      console.log('No API key. Generating mock from document.');
      usedMock = true;
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
        usedMock = true;
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
        usedMock = true;
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
        usedMock = true;
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
        usedMock = true;
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

    // 2. WIPE old test cases and acceptance criteria if not new to allow fresh overwrite
    if (!isNewStory) {
      await prisma.testCase.deleteMany({ where: { userStoryId: finalStoryId } });
      await prisma.acceptanceCriterion.deleteMany({ where: { userStoryId: finalStoryId } });
      await prisma.userStory.update({
        where: { id: finalStoryId },
        data: {
          description: storyText
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

    const savedTestCases = [];
    let duplicateCount = 0;

    for (const tc of parsedTestCases) {
      const cleanedTitle = (tc.title || tc.testName || tc.testSummary || tc.description || '').toLowerCase().trim();
      const isDuplicate = savedTestCases.some(saved => saved.title.toLowerCase().trim() === cleanedTitle);
      
      if (isDuplicate) {
        duplicateCount++;
        continue;
      }

      const idx = savedTestCases.length;
      const newTc = await saveGeneratedTestCase(tc, finalStoryId, format, idx);
      savedTestCases.push(newTc);
    }

    let allTestCases = savedTestCases;

    let aiMessage = null;
    if (chatId) {
      let chat = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chat) {
        chat = await prisma.chat.create({
          data: {
            id: chatId,
            title: 'QAutopilot Doc: ' + documentName,
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

      let prefix = '';
      if (usedMock) {
        prefix = `⚠️ **Notice: Offline Heuristic Mode Active.** No API Key was detected (or API request failed). QAutopilot has extracted template user stories/criteria and generated template test cases based on keyword matches. To get accurate test cases derived from your document, please save your API Key in Settings.\n\n`;
      }
      const aiResponseContent = prefix + `**Generated ${savedTestCases.length} new Test Cases from document "${documentName}".**` + 
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

// --- NEW QAUTOPILOT ADVANCED API ENDPOINTS ---

// HELPER: Call AI Generic
async function callAiGeneric(promptText, provider, apiKey, isJson = false) {
  if (!apiKey) {
    throw new Error('API Key is missing');
  }
  if (provider === 'claude') {
    const url = 'https://api.anthropic.com/v1/messages';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        messages: [{ role: 'user', content: promptText }]
      })
    });
    if (!response.ok) {
      throw new Error(`Claude API error: ${response.statusText}`);
    }
    const resObj = await response.json();
    return resObj.content[0].text;
  } else if (provider === 'chatgpt') {
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
        response_format: isJson ? { type: 'json_object' } : undefined
      })
    });
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }
    const resObj = await response.json();
    return resObj.choices[0].message.content;
  } else {
    // Default to Gemini
    const payload = {
      contents: [{ parts: [{ text: promptText }] }]
    };
    if (isJson) {
      payload.generationConfig = { responseMimeType: 'application/json' };
    }
    const resData = await callGeminiApi(payload, apiKey);
    return resData.candidates[0].content.parts[0].text;
  }
}

// POST Optimize test suite
app.post('/api/optimize-suite', async (req, res) => {
  try {
    const { storyId } = req.body;
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;

    const story = await prisma.userStory.findUnique({
      where: { id: storyId },
      include: { acceptanceCriteria: true, testCases: true }
    });

    if (!story) {
      return res.status(404).json({ error: 'User Story not found' });
    }

    const acText = story.acceptanceCriteria.map(ac => ac.content).join('\n');
    let updatedCases = [];

    if (!apiKey) {
      // Offline fallback: slightly optimize current test cases by appending mock verification
      updatedCases = story.testCases.map(tc => ({
        ...tc,
        title: tc.title + ' [AI Optimized]',
        steps: tc.steps + '\n*. Verify input bounds and edge values.'
      }));
    } else {
      const promptText = `You are a world-class QA Optimization Engineer. You are given a User Story, its Acceptance Criteria, and a set of manual test cases.
Please optimize, self-heal, and refine these test cases to:
1. Inject explicit, specific boundary values and equivalence class test data (BVA/EP) into the test steps (e.g. replace placeholders like "enter valid name" with realistic values like "Johnathan").
2. Ensure preconditions and expected results contain exact verifications.
3. Absolutely exclude any visual/UI formatting checks, generic performance SLAs, or default connectivity warnings.
4. Keep the original ID mapping if updating existing cases.

User Story:
${story.description}

Acceptance Criteria:
${acText}

Current Test Cases (JSON):
${JSON.stringify(story.testCases)}

Output optimized test cases as a JSON object containing a "testCases" array matching this exact schema:
{
  "testCases": [
    {
      "id": "TC...",
      "customId": "TC001",
      "title": "...",
      "type": "Positive" | "Negative" | "Edge" | "Security" | "Performance",
      "preconditions": "...",
      "steps": "1. ...\n2. ...",
      "expectedResult": "...",
      "priority": "High" | "Medium" | "Low"
    }
  ]
}`;

      const resText = await callAiGeneric(promptText, provider, apiKey, true);
      const parsed = parseCleanJson(resText);
      updatedCases = parsed.testCases || [];
    }

    if (updatedCases.length > 0) {
      // Overwrite database cases
      await prisma.testCase.deleteMany({ where: { userStoryId: storyId } });
      const saved = [];
      for (const tc of updatedCases) {
        const newTc = await prisma.testCase.create({
          data: {
            id: tc.id && tc.id.startsWith('TC-') ? tc.id : 'TC-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
            customId: tc.customId || 'TC001',
            title: tc.title,
            type: tc.type || 'Positive',
            preconditions: tc.preconditions || 'N/A',
            steps: tc.steps,
            expectedResult: tc.expectedResult,
            priority: tc.priority || 'Medium',
            userStoryId: storyId
          }
        });
        saved.push(newTc);
      }
      return res.json({ success: true, testCases: saved });
    }

    res.json({ success: true, testCases: story.testCases });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to optimize test suite' });
  }
});

// POST Generate Master Test Strategy
app.post('/api/generate-strategy', async (req, res) => {
  try {
    const { storyId } = req.body;
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;

    const story = await prisma.userStory.findUnique({
      where: { id: storyId },
      include: { acceptanceCriteria: true }
    });

    if (!story) {
      return res.status(404).json({ error: 'User Story not found' });
    }

    if (!apiKey) {
      return res.json({
        strategy: `# Master Test Plan & Strategy: ${story.title}\n\n*Note: Running in offline heuristic mode.*\n\n## 1. Scope\n- Validate requirement: "${story.title}"\n- Environment: QA Sandbox\n\n## 2. Test Execution Criteria\n- Functional validations must pass.\n- Boundary checking for all fields.`
      });
    }

    const acText = story.acceptanceCriteria.map(ac => ac.content).join('\n');
    const promptText = `Write a comprehensive, professional Master Test Strategy & Test Plan document for the following User Story and Acceptance Criteria.
Use clean, beautiful Markdown with professional headers, sections, bullet points, and tables where applicable.
Include:
1. Document Scope & Summary
2. Out-of-scope Items
3. Environment Setup & Prerequisites
4. Detailed Test Methodology (Positive, Negative, Edge, Security, and Performance boundaries)
5. Entry, Suspension, and Exit Criteria
6. Test Deliverables (Automated Scripts, Dry Run Reports)

User Story:
${story.description}

Acceptance Criteria:
${acText}
`;

    const strategyMarkdown = await callAiGeneric(promptText, provider, apiKey, false);
    res.json({ strategy: strategyMarkdown });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to generate test strategy' });
  }
});

// POST Generate Targeted Test Case for specific AC
app.post('/api/generate-targeted-tc', async (req, res) => {
  try {
    const { storyId, acContent } = req.body;
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;

    const story = await prisma.userStory.findUnique({ where: { id: storyId } });
    if (!story) {
      return res.status(404).json({ error: 'User story not found' });
    }

    let tcs = [];
    if (!apiKey) {
      // Mock generation
      tcs = [{
        customId: 'TC' + Math.floor(Math.random() * 1000),
        title: 'Verify targeted flow for: ' + acContent.substring(0, 30),
        type: 'Positive',
        preconditions: 'System default state',
        steps: '1. Navigate to target field.\n2. Perform operation relating to: ' + acContent + '\n3. Submit.',
        expectedResult: 'Acceptance Criterion is fully verified and matches system specs.',
        priority: 'High'
      }];
    } else {
      const promptText = `You are a world-class QA Automation Engineer. Generate exactly 2 high-quality, targeted manual test cases that validate the following specific Acceptance Criterion. Do not write test cases for any other requirements.

User Story:
${story.description}

Target Acceptance Criterion to Cover:
${acContent}

Output fuzzed validation scenarios as a JSON object containing a "testCases" array matching this exact schema:
{
  "testCases": [
    {
      "customId": "TC001",
      "title": "...",
      "type": "Positive" | "Negative" | "Edge" | "Security" | "Performance",
      "preconditions": "...",
      "steps": "1. ...\n2. ...",
      "expectedResult": "...",
      "priority": "High" | "Medium" | "Low"
    }
  ]
}`;

      const resText = await callAiGeneric(promptText, provider, apiKey, true);
      const parsed = parseCleanJson(resText);
      tcs = parsed.testCases || [];
    }

    const saved = [];
    for (const tc of tcs) {
      const newTc = await prisma.testCase.create({
        data: {
          id: 'TC-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
          customId: tc.customId || 'TC001',
          title: tc.title,
          type: tc.type || 'Positive',
          preconditions: tc.preconditions || 'N/A',
          steps: tc.steps,
          expectedResult: tc.expectedResult,
          priority: tc.priority || 'Medium',
          userStoryId: storyId
        }
      });
      saved.push(newTc);
    }

    res.status(201).json({ success: true, testCases: saved });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to generate targeted test cases' });
  }
});

// POST Explore Boundaries
app.post('/api/explore-boundaries', async (req, res) => {
  try {
    const { storyId } = req.body;
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;

    const story = await prisma.userStory.findUnique({
      where: { id: storyId },
      include: { acceptanceCriteria: true }
    });

    if (!story) {
      return res.status(404).json({ error: 'User Story not found' });
    }

    const acText = story.acceptanceCriteria.map(ac => ac.content).join('\n');
    let boundaryData = null;

    if (!apiKey) {
      // Mock boundary suggestions
      boundaryData = {
        inputs: [
          {
            fieldName: 'General Form Submission',
            boundaries: ['Null/Empty state inputs', 'Long overflow values (e.g. 500+ characters)'],
            securityPayloads: ["' OR '1'='1 -- (SQL Injection)", "<script>alert('XSS')</script>"]
          }
        ]
      };
    } else {
      const promptText = `Analyze the following User Story and Acceptance Criteria. Extract all input fields, select boxes, dates, or numbers mentioned in the workflow. For each field, identify exact boundary limits (Equivalence Partitioning and Boundary Value Analysis) and suggest specific, custom SQL injection and Cross-Site Scripting (XSS) fuzzer payloads mapped to that field's type.

User Story:
${story.description}

Acceptance Criteria:
${acText}

Output the suggestion as a JSON object containing an "inputs" array matching this exact schema:
{
  "inputs": [
    {
      "fieldName": "name of field",
      "boundaries": ["suggested BVA length/limit boundary description", "..."],
      "securityPayloads": ["suggested SQLi payload or XSS scripting injection payload", "..."]
    }
  ]
}`;

      const resText = await callAiGeneric(promptText, provider, apiKey, true);
      boundaryData = parseCleanJson(resText);
    }

    res.json(boundaryData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to explore boundaries' });
  }
});

// POST Generate Fuzzed Data CSV
app.post('/api/generate-fuzzed-data', async (req, res) => {
  try {
    const { storyId } = req.body;
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;

    const story = await prisma.userStory.findUnique({ where: { id: storyId } });
    if (!story) {
      return res.status(404).json({ error: 'User Story not found' });
    }

    if (!apiKey) {
      // Mock CSV
      const mockCsv = `ID,FieldName,InputType,TestValue,ExpectedResult\n1,GeneralInput,Valid,ValidData,Successful validation\n2,GeneralInput,Empty,,Field required error\n3,GeneralInput,SQLi,"' OR 1=1--",Rejected payload\n4,GeneralInput,XSS,"<script>alert(1)</script>",Escaped successfully`;
      return res.send(mockCsv);
    }

    const promptText = `Identify the input fields and validation parameters described in the User Story below.
Generate 100 rows of custom fuzzed boundary value dataset in raw CSV format.
The CSV must contain realistic and fuzzed values matching the fields (e.g. columns like name, email, input_type, value, expected_result).
Include boundary edge cases, SQL injections, XSS payloads, unicode strings, date limits, and empty parameters.

User Story:
${story.description}

Return ONLY the raw CSV text. Do not wrap in markdown code blocks.`;

    const csvText = await callAiGeneric(promptText, provider, apiKey, false);
    res.type('text/csv').send(csvText.replace(/^```csv\n|```$/g, '').trim());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to generate fuzzed data' });
  }
});

// POST Enhance & Refine User Story Draft
app.post('/api/enhance-story', async (req, res) => {
  try {
    const { userStory, acceptanceCriteria } = req.body;
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;

    if (!userStory && !acceptanceCriteria) {
      return res.status(400).json({ error: 'User story or criteria is required' });
    }

    if (!apiKey) {
      return returnMockEnhancedStory(res, userStory, acceptanceCriteria);
    }

    try {
      const promptText = `You are a Lead Product Owner and Business Analyst.
Your task is to analyze the following draft user story and acceptance criteria, and refine/expand them into an industry-grade, highly precise, and complete Agile specification.

User Story Draft:
${userStory}

Acceptance Criteria Draft:
${acceptanceCriteria}

Generate a JSON object containing:
1. "enhancedStory": A fully structured user story with:
   - "As a [role]"
   - "I want to [action]"
   - "So that [benefit]"
   - "Detailed Description" listing functional rules, parameters, validation states, and roles.
2. "enhancedCriteria": An array of strings, where each string represents a clear, testable, and numbered Acceptance Criterion (e.g. "[AC1] Verify password field rejects inputs shorter than 8 characters"). Ensure you extract and add standard edge boundaries, validation rules, and error conditions based on the story.

Output must be ONLY a valid raw JSON object matching the schema. Do not include markdown code block ticks.
{
  "enhancedStory": "...",
  "enhancedCriteria": ["...", "..."]
}`;

      const resText = await callAiGeneric(promptText, provider, apiKey, true);
      let parsed;
      try {
        parsed = parseCleanJson(resText);
      } catch (e) {
        parsed = {
          enhancedStory: resText,
          enhancedCriteria: acceptanceCriteria ? acceptanceCriteria.split('\n') : []
        };
      }
      res.json({
        enhancedStory: parsed.enhancedStory || userStory,
        enhancedCriteria: parsed.enhancedCriteria || (acceptanceCriteria ? acceptanceCriteria.split('\n') : [])
      });
    } catch (aiError) {
      console.warn("AI enhancement failed, falling back to mock:", aiError);
      return returnMockEnhancedStory(res, userStory, acceptanceCriteria);
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to enhance user story requirements' });
  }
});

function returnMockEnhancedStory(res, userStory, acceptanceCriteria) {
  const mockEnhancedStory = `As a Registered User\nI want to navigate and submit the form\nSo that my validation details are recorded in the database.\n\n### Functional Rules:\n1. All fields marked required must be filled.\n2. Email must match standard RFC format.\n3. State workflow shifts on successful save.\n\n(Draft requirements fallback):\n${userStory || ''}`;
  const mockEnhancedCriteria = [
    `[AC1] Verify form cannot be submitted when required fields are blank.`,
    `[AC2] Verify standard validation error displays for invalid email formatting.`,
    `[AC3] Verify success logs are saved to database matching the state transition.`
  ];
  return res.json({ enhancedStory: mockEnhancedStory, enhancedCriteria: mockEnhancedCriteria });
}

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Backend server (SQL) running on http://localhost:${PORT}`);
});
