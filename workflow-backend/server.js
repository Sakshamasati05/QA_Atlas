const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const officeParser = require('officeparser');

// Auto-Bootstrap Prisma Database & Client on Startup
const { execSync } = require('child_process');
try {
  console.log('[Prisma Bootstrap] Syncing database schema to local SQLite database...');
  execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit', cwd: __dirname });
  console.log('[Prisma Bootstrap] Generating Prisma Client locally...');
  execSync('npx prisma generate', { stdio: 'inherit', cwd: __dirname });
  console.log('[Prisma Bootstrap] Auto-bootstrapping completed successfully!');
} catch (err) {
  console.error('[Prisma Bootstrap Warning] Auto-bootstrap failed (will attempt standard loading):', err.message);
}

const { PrismaClient } = require('./node_modules/@prisma/client');

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
const crypto = require('crypto');

function hashPassword(password) {
  const salt = 'qautopilot_salt_123!';
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

const app = express();
app.use(cors());
app.use(express.json());

// Auth Endpoints
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Name, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();

    const existingUser = await prisma.user.findUnique({
      where: { email: cleanEmail }
    });

    if (existingUser) {
      return res.status(400).json({ success: false, error: 'A user with this email address already exists.' });
    }

    const hashedPassword = hashPassword(password);

    const newUser = await prisma.user.create({
      data: {
        id: 'USR-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        email: cleanEmail,
        name: cleanName,
        password: hashedPassword,
        createdAt: new Date().toISOString()
      }
    });

    return res.json({
      success: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name
      }
    });
  } catch (error) {
    console.error('[Register Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email: cleanEmail }
    });

    if (!user) {
      return res.status(400).json({ success: false, error: 'Invalid email or password.' });
    }

    const hashedPassword = hashPassword(password);
    if (user.password !== hashedPassword) {
      return res.status(400).json({ success: false, error: 'Invalid email or password.' });
    }

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('[Login Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

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
      } else if (ext === '.pptx' || ext === '.ppt') {
        try {
          text = await officeParser.parseOfficeAsync(file.path);
        } catch (err) {
          console.error('OfficeParser failed for PPT:', err);
          text = `[Error parsing PPT file: ${file.originalname}]`;
        }
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

// --- HELPER: DEEP SEMANTIC AC PARSER & TEST CASE SYNTHESIZER ---
function parseAcceptanceCriteriaLines(acText, userStoryText = '') {
  if (!acText || typeof acText !== 'string' || !acText.trim()) {
    if (userStoryText && typeof userStoryText === 'string') {
      const sentences = userStoryText
        .split(/(?<=[.!?\n])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 10 && !/^(as a|i want|so that)/i.test(s));
      if (sentences.length > 0) {
        return sentences.map((s, idx) => ({
          tag: `[AC${idx + 1}]`,
          index: idx + 1,
          text: s
        }));
      }
      return [{
        tag: '[AC1]',
        index: 1,
        text: `The system must successfully execute the business flow for "${userStoryText.substring(0, 50)}"`
      }];
    }
    return [{ tag: '[AC1]', index: 1, text: 'Standard feature functionality' }];
  }

  const rawLines = acText
    .split(/\r?\n|(?<=[.;])\s*(?=(?:AC\d+|[0-9]+\.|\*|-|Given\b|When\b|Then\b))/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const parsed = [];
  let acIndex = 1;

  for (const line of rawLines) {
    let clean = line
      .replace(/^\[?AC[-_ ]?\d+\]?[:\.\s-]*/i, '')
      .replace(/^\d+[\.\)\-:]\s*/, '')
      .replace(/^[\*\-•]\s*/, '')
      .trim();

    if (!clean || clean.length < 4) continue;

    parsed.push({
      tag: `[AC${acIndex}]`,
      index: acIndex,
      text: clean
    });
    acIndex++;
  }

  if (parsed.length === 0) {
    parsed.push({
      tag: '[AC1]',
      index: 1,
      text: acText.trim()
    });
  }

  return parsed;
}

function analyzeACIntent(acItem) {
  const rawText = acItem.text;
  const lower = rawText.toLowerCase();

  // 1. Extract Monetary / Threshold values
  const currencyMatch = rawText.match(/\$?(\d+[\d,]*(?:\.\d+)?)\s*(?:USD|dollars?|\$|INR|EUR|GBP)?/i);
  let cleanCurrency = null;
  if (currencyMatch && currencyMatch[1]) {
    cleanCurrency = currencyMatch[1].replace(/[,;]+$/, '');
  }
  
  // 2. Extract File Sizes vs String Lengths
  const fileSizeMatch = rawText.match(/(\d+)\s*(MB|GB|KB|bytes?)/i);
  const charLengthMatch = rawText.match(/(?:min|minimum|at least)\s*(\d+)\s*(?:chars?|characters?)?|(?:max|maximum|up to)\s*(\d+)\s*(?:chars?|characters?)?|(\d+)\s*(?:to|-)\s*(\d+)\s*(?:chars?|characters?)/i);

  // 3. Extract Timeouts / Durations
  const timeMatch = rawText.match(/(\d+)\s*(seconds?|mins?|minutes?|hours?|days?)/i);
  
  // 4. Extract Range (e.g. between $500 and $2000 or 2 to 50)
  const rangeMatch = rawText.match(/(?:between|from)\s+\$?(\d+[\d,]*)\s+(?:and|to)\s+\$?(\d+[\d,]*)/i);

  // 5. Extract Specific Error or Quoted Messages
  const quoteMatch = rawText.match(/['"“]([^'"“”]{3,})['"”]/);
  const explicitMessage = quoteMatch ? quoteMatch[1] : null;

  // 6. Detect File Extensions
  const formatMatches = rawText.match(/\b(JPG|PNG|WEBP|JPEG|PDF|DOCX|CSV|XLSX|EXE|SVG|JSON|XML|BAT)\b/gi);

  // 7. Detect Roles
  const rolesMatch = rawText.match(/\b(Admin|Manager|Director|Superadmin|Patient|Doctor|Customer|User|Approver|Reviewer|Guest|Claimant)\b/i);

  // 8. Identify Action Intent
  let actionType = 'standard';
  if (/(?:upload|avatar|image size|attachment|drop zone|file format|supported format)/i.test(lower)) {
    actionType = 'file_upload';
  } else if (/(?:reject|rejection reason|mandatory reason|decline)/i.test(lower)) {
    actionType = 'rejection';
  } else if (/(?:auto[- ]approv|automatically approv)/i.test(lower)) {
    actionType = 'auto_approval';
  } else if (/(?:approve|approval|signoff|director level)/i.test(lower)) {
    actionType = 'approval';
  } else if (/(?:coupon|discount|promo|voucher|save20)/i.test(lower)) {
    actionType = 'coupon_discount';
  } else if (/(?:cancel|cancellation|refund)/i.test(lower)) {
    actionType = 'cancellation_refund';
  } else if (/(?:book|booking|appointment|schedule|time slot|date picker|past date)/i.test(lower)) {
    actionType = 'booking_slot';
  } else if (/(?:password|otp|pin|2fa|mfa|auth|token|credential|lockout)/i.test(lower)) {
    actionType = 'auth_credential';
  } else if (/(?:crop|rotate|avatar picture|edit image)/i.test(lower)) {
    actionType = 'image_edit';
  } else if (/(?:email|notify|notification|sms|alert dispatch)/i.test(lower)) {
    actionType = 'notification';
  } else if (/(?:search|filter|sort|pagination|keyword)/i.test(lower)) {
    actionType = 'search_filter';
  } else if (/(?:mandatory|required|cannot be empty|blank|characters)/i.test(lower)) {
    actionType = 'mandatory_validation';
  }

  return {
    acTag: acItem.tag,
    acIndex: acItem.index,
    rawText,
    lowerText: lower,
    actionType,
    explicitMessage,
    currencyAmount: cleanCurrency,
    fileSize: fileSizeMatch ? `${fileSizeMatch[1]} ${fileSizeMatch[2]}` : null,
    charLength: charLengthMatch ? (charLengthMatch[1] || charLengthMatch[2] || charLengthMatch[3]) : null,
    timeout: timeMatch ? `${timeMatch[1]} ${timeMatch[2]}` : null,
    range: rangeMatch ? { min: rangeMatch[1], max: rangeMatch[2] } : null,
    allowedFormats: formatMatches ? Array.from(new Set(formatMatches.map(f => f.toUpperCase()))) : null,
    targetRole: rolesMatch ? rolesMatch[1] : null
  };
}

function synthesizeScenariosForAC(analyzed, storyTitle) {
  const { acTag, rawText, lowerText, actionType, explicitMessage, currencyAmount, fileSize, charLength, timeout, range, allowedFormats, targetRole } = analyzed;
  const scenarios = [];

  const cleanShortText = rawText.length > 55 ? rawText.substring(0, 52) + '...' : rawText;

  // ── 1. FILE & AVATAR UPLOAD ──
  if (actionType === 'file_upload') {
    const validFormats = allowedFormats ? allowedFormats.filter(f => !['EXE', 'BAT', 'SVG', 'PDF'].includes(f) || allowedFormats.length === 1) : ['JPG', 'PNG', 'WEBP'];
    const validExt = validFormats.length > 0 ? validFormats[0] : 'JPG';
    const invalidExt = allowedFormats ? (allowedFormats.includes('EXE') ? 'BAT' : 'EXE') : 'EXE';
    const maxSizeStr = fileSize || '5 MB';

    scenarios.push({
      type: 'Positive',
      priority: 'High',
      title: `Verify successful file upload with supported format (${validExt}) within ${maxSizeStr}`,
      preconditions: `${acTag} User is on the upload view with active session.`,
      steps: `1. Click the upload container or drag a file.\n2. Select a valid "sample_upload.${validExt.toLowerCase()}" (size: 1.2 MB).\n3. Click "Save" / "Upload".`,
      expectedResult: `File is accepted and processed successfully. Upload container displays thumbnail preview and success message "File uploaded successfully".`
    });

    scenarios.push({
      type: 'Negative',
      priority: 'High',
      title: `Verify upload rejection of prohibited file extension (.${invalidExt.toLowerCase()})`,
      preconditions: `${acTag} User is on the upload screen.`,
      steps: `1. Select an unsupported file "payload.${invalidExt.toLowerCase()}".\n2. Click "Upload".`,
      expectedResult: `Upload is blocked immediately. Validation alert displays: "${explicitMessage || 'Unsupported file format. Please upload allowed formats.'}". No file is saved.`
    });

    scenarios.push({
      type: 'Edge',
      priority: 'Medium',
      title: `Verify file size boundary rejection for files exceeding ${maxSizeStr}`,
      preconditions: `${acTag} User selects a file larger than max size threshold.`,
      steps: `1. Select a file "large_file.${validExt.toLowerCase()}" with size 5.5 MB (limit: ${maxSizeStr}).\n2. Attempt upload.`,
      expectedResult: `System detects file size violation before network transfer. Warning displays: "${explicitMessage || `File size exceeds ${maxSizeStr} limit`}".`
    });
    return scenarios;
  }

  // ── 2. IMAGE EDIT / CROP / ROTATE ──
  if (actionType === 'image_edit') {
    scenarios.push({
      type: 'Positive',
      priority: 'High',
      title: `Verify image crop and rotation controls function properly before saving`,
      preconditions: `${acTag} Valid image is loaded in the avatar preview modal.`,
      steps: `1. Upload a valid avatar image.\n2. In the cropping modal, adjust bounding crop box and click "Rotate 90°".\n3. Click "Apply & Save".`,
      expectedResult: `Cropped and rotated image is rendered in avatar container with updated dimensions and aspect ratio.`
    });
    return scenarios;
  }

  // ── 3. AUTO-APPROVAL THRESHOLD ──
  if (actionType === 'auto_approval') {
    const limit = currencyAmount ? `$${currencyAmount}` : '$500.00';
    scenarios.push({
      type: 'Positive',
      priority: 'High',
      title: `Verify automated instant approval for claims under threshold (${limit})`,
      preconditions: `${acTag} Claimant submits a claim with total amount of $350.00 (below ${limit}).`,
      steps: `1. Fill expense details with amount $350.00.\n2. Click "Submit Claim".\n3. View claim status in claims dashboard.`,
      expectedResult: `Claim status immediately transitions to "Approved" automatically without requiring manager intervention.`
    });

    scenarios.push({
      type: 'Edge',
      priority: 'Medium',
      title: `Verify boundary evaluation at exact auto-approval threshold limit (${limit})`,
      preconditions: `${acTag} User creates a claim with exact boundary value of ${limit}.`,
      steps: `1. Enter total claim value of ${limit}.\n2. Click "Submit".\n3. Verify workflow engine routing.`,
      expectedResult: `System evaluates boundary accurately (<= ${limit}) and executes the configured auto-approval rule.`
    });
    return scenarios;
  }

  // ── 4. APPROVAL WORKFLOW (MANAGER / DIRECTOR) ──
  if (actionType === 'approval') {
    const roleName = targetRole || (lowerText.includes('director') ? 'Director' : 'Manager');
    const rangeStr = range ? `$${range.min} and $${range.max}` : (currencyAmount ? `$${currencyAmount}` : '$1,200.00');

    scenarios.push({
      type: 'Positive',
      priority: 'High',
      title: `Verify ${roleName} can successfully review and approve claims in range (${rangeStr})`,
      preconditions: `${acTag} User is authenticated with ${roleName} credentials. Pending claim is in review queue.`,
      steps: `1. Navigate to Approval Dashboard.\n2. Open pending claim item (${rangeStr}).\n3. Click "Approve".\n4. Confirm modal dialog.`,
      expectedResult: `Claim status updates to "Approved" (or next tier). Audit history logs ${roleName} approval with timestamp.`
    });

    scenarios.push({
      type: 'Negative',
      priority: 'High',
      title: `Verify non-${roleName} role is prevented from approving tier claims`,
      preconditions: `${acTag} Standard employee user session.`,
      steps: `1. Open claim details.\n2. Verify "Approve" button visibility.\n3. Attempt to trigger approval endpoint directly.`,
      expectedResult: `"Approve" button is hidden. Direct API POST is rejected with HTTP 403 Forbidden.`
    });
    return scenarios;
  }

  // ── 5. REJECTION WORKFLOW & MANDATORY COMMENTS ──
  if (actionType === 'rejection') {
    const minChars = charLength || '10';
    scenarios.push({
      type: 'Positive',
      priority: 'High',
      title: `Verify approver can reject claim when providing valid rejection comments (>= ${minChars} characters)`,
      preconditions: `${acTag} Approver has opened a pending claim in the queue.`,
      steps: `1. Click "Reject" button.\n2. In the Rejection Reason modal, input "Receipt documentation is missing business justification." (>= ${minChars} chars).\n3. Click "Confirm Rejection".`,
      expectedResult: `Claim transitions to "Rejected" state. Rejection reason is saved and displayed in the audit trail.`
    });

    scenarios.push({
      type: 'Negative',
      priority: 'High',
      title: `Verify rejection is blocked when rejection reason is blank or under ${minChars} characters`,
      preconditions: `${acTag} Approver opens the rejection modal.`,
      steps: `1. Click "Reject".\n2. Enter "No" (below ${minChars} characters) or leave blank.\n3. Click "Confirm Rejection".`,
      expectedResult: `Submission is blocked. Error message displays: "${explicitMessage || `Rejection reason is mandatory (minimum ${minChars} characters).`}"`
    });
    return scenarios;
  }

  // ── 6. COUPON & DISCOUNT LOGIC ──
  if (actionType === 'coupon_discount') {
    const nonCodeWords = new Set(['APPLY', 'SUBMIT', 'CANCEL', 'SAVE', 'DELETE', 'EDIT', 'UPDATE', 'CONFIRM', 'CLICK', 'ENTER']);
    const rawQuotes = Array.from(rawText.matchAll(/['"“]([A-Z0-9_-]+)['"”]/gi)).map(m => m[1].toUpperCase()).filter(w => !nonCodeWords.has(w));
    const wordMatches = Array.from(rawText.matchAll(/\b([A-Z0-9]{4,10})\b/g)).map(m => m[1].toUpperCase()).filter(w => !nonCodeWords.has(w));
    const promoCode = rawQuotes[0] || wordMatches[0] || 'SAVE20';
    const subtotalThresh = currencyAmount ? `$${currencyAmount}` : '$50.00';

    if (lowerText.includes('invalid') || lowerText.includes('expired')) {
      scenarios.push({
        type: 'Negative',
        priority: 'High',
        title: `Verify error message when entering an invalid or expired coupon code`,
        preconditions: `${acTag} User is on checkout payment page with active cart.`,
        steps: `1. In Promo Code input, enter "EXPIRED999".\n2. Click "Apply".`,
        expectedResult: `Discount is not applied. Error message displays: "${explicitMessage || 'Invalid or expired coupon code'}".`
      });
    } else if (lowerText.includes('only one') || lowerText.includes('1 coupon')) {
      scenarios.push({
        type: 'Negative',
        priority: 'Medium',
        title: `Verify restriction preventing multiple coupons on a single order`,
        preconditions: `${acTag} Promo code "${promoCode}" is already applied to cart.`,
        steps: `1. Enter second promo code "EXTRA10" in the promo box.\n2. Click "Apply".`,
        expectedResult: `System notifies user: "Only one coupon code can be applied per order. Remove active coupon to apply another."`
      });
    } else {
      scenarios.push({
        type: 'Positive',
        priority: 'High',
        title: `Verify applying valid promo code "${promoCode}" calculates discount correctly on subtotal >= ${subtotalThresh}`,
        preconditions: `${acTag} User has qualifying items in cart with subtotal >= ${subtotalThresh} (e.g. $80.00).`,
        steps: `1. Navigate to Cart/Checkout.\n2. Enter promo code "${promoCode}".\n3. Click "Apply".\n4. Review total price breakdown.`,
        expectedResult: `Discount is calculated and deducted. Success message displays: "Promo code '${promoCode}' applied successfully!". Order total updates accurately.`
      });

      scenarios.push({
        type: 'Negative',
        priority: 'Medium',
        title: `Verify coupon rejection when cart subtotal is below minimum qualifying threshold (${subtotalThresh})`,
        preconditions: `${acTag} Cart subtotal is below ${subtotalThresh} (e.g. $30.00).`,
        steps: `1. Enter promo code "${promoCode}".\n2. Click "Apply".`,
        expectedResult: `Discount is rejected. Banner displays: "${explicitMessage || `Order subtotal must be at least ${subtotalThresh} to use this coupon`}".`
      });
    }
    return scenarios;
  }

  // ── 7. BOOKING & SCHEDULING ──
  if (actionType === 'booking_slot') {
    if (lowerText.includes('past date') || lowerText.includes('disabled') || lowerText.includes('booked')) {
      scenarios.push({
        type: 'Negative',
        priority: 'High',
        title: `Verify past dates and already booked time slots are disabled and cannot be selected`,
        preconditions: `${acTag} User opens calendar picker and time slot grid.`,
        steps: `1. Inspect dates prior to current date in datepicker.\n2. Inspect slots with status "Booked / Unavailable".\n3. Attempt to click disabled dates and booked slots.`,
        expectedResult: `Past calendar dates are visually grayed out with pointer-events disabled. Booked slots show "Unavailable" and cannot be clicked.`
      });
    } else if (lowerText.includes('cancel') || lowerText.includes('refund')) {
      scenarios.push({
        type: 'Positive',
        priority: 'Medium',
        title: `Verify cancellation policy and refund execution when cancelled >= 24h in advance`,
        preconditions: `${acTag} Active confirmed appointment scheduled for 3 days in future.`,
        steps: `1. Go to "My Appointments".\n2. Click "Cancel Booking" on scheduled appointment.\n3. Confirm cancellation prompt.`,
        expectedResult: `Appointment is cancelled. Confirmation displays: "Appointment cancelled. 100% refund has been processed."`
      });
    } else {
      scenarios.push({
        type: 'Positive',
        priority: 'High',
        title: `Verify appointment booking with doctor selection, valid date, and available time slot`,
        preconditions: `${acTag} User is on appointment booking interface with available schedules.`,
        steps: `1. Select specialist doctor from dropdown (e.g. "Dr. Sarah Smith").\n2. Choose an available future date from calendar.\n3. Select available time slot (e.g. "10:30 AM").\n4. Click "Confirm Booking".`,
        expectedResult: `Booking is created successfully. Confirmation screen shows Appointment ID, Doctor Name, Date/Time, and Room location.`
      });
    }
    return scenarios;
  }

  // ── 8. NOTIFICATIONS ──
  if (actionType === 'notification') {
    const timeLimit = timeout || '1 minute';
    scenarios.push({
      type: 'Positive',
      priority: 'High',
      title: `Verify automated notification dispatch within ${timeLimit} upon status transition`,
      preconditions: `${acTag} Claimant has valid email configured and notification settings enabled.`,
      steps: `1. Approver transitions request status (Approved / Rejected).\n2. Monitor outbound notification queue.\n3. Verify delivery to claimant inbox within ${timeLimit}.`,
      expectedResult: `Automated email notification is delivered within ${timeLimit} with updated status details and direct review link.`
    });
    return scenarios;
  }

  // ── 9. AUTHENTICATION & CREDENTIALS ──
  if (actionType === 'auth_credential') {
    scenarios.push({
      type: 'Positive',
      priority: 'High',
      title: `Verify authentication verification with valid credentials`,
      preconditions: `${acTag} User is on authentication screen with valid account.`,
      steps: `1. Enter valid credentials meeting all rules.\n2. Click Submit.`,
      expectedResult: `Authentication succeeds and user is redirected to the main dashboard.`
    });

    scenarios.push({
      type: 'Negative',
      priority: 'High',
      title: `Verify validation alert when credentials fail format or complexity rules`,
      preconditions: `${acTag} User is on the credential entry screen.`,
      steps: `1. Enter invalid or non-compliant credentials.\n2. Click Submit.`,
      expectedResult: `Submission fails with validation alert: "${explicitMessage || 'Invalid credentials or format rules not met'}".`
    });
    return scenarios;
  }

  // ── 10. MANDATORY / GENERAL VALIDATION ──
  if (actionType === 'mandatory_validation') {
    const lenVal = charLength || '2 to 50';
    scenarios.push({
      type: 'Positive',
      priority: 'High',
      title: `Verify successful submission with valid mandatory input data (${lenVal} characters)`,
      preconditions: `${acTag} User is on the input form with clean state.`,
      steps: `1. Enter valid test value (e.g. "Johnathan Doe").\n2. Complete any required fields.\n3. Click Save / Submit.`,
      expectedResult: `Inputs are validated successfully and changes are persisted to the database.`
    });

    scenarios.push({
      type: 'Negative',
      priority: 'High',
      title: `Verify validation error when mandatory field is left blank or whitespace`,
      preconditions: `${acTag} User is on the input form.`,
      steps: `1. Clear mandatory field.\n2. Click Save / Submit.`,
      expectedResult: `Submission is halted. Field highlights in red with validation tooltip: "${explicitMessage || 'This field is required and cannot be left blank'}".`
    });
    return scenarios;
  }

  // ── 11. GENERAL / DEFAULT SYNTHESIS ──
  scenarios.push({
    type: 'Positive',
    priority: 'High',
    title: `Verify standard successful execution for: ${cleanShortText}`,
    preconditions: `${acTag} System is initialized with valid test data. User is authenticated.`,
    steps: `1. Navigate to the relevant interface module.\n2. Complete inputs matching requirement: "${cleanShortText}".\n3. Click the primary action / submit button.\n4. Observe system response.`,
    expectedResult: `Action completes successfully. UI displays confirmation feedback and record updates in database.`
  });

  scenarios.push({
    type: 'Negative',
    priority: 'High',
    title: `Verify validation error and boundary handling when violating: ${cleanShortText}`,
    preconditions: `${acTag} User is on the operational view with error listeners active.`,
    steps: `1. Attempt action with invalid parameters or inverted condition for: "${cleanShortText}".\n2. Trigger execution.`,
    expectedResult: `System intercepts invalid state gracefully. Descriptive alert displays: "${explicitMessage || 'Operation cannot be completed with the provided inputs.'}" No corrupted data is persisted.`
  });

  scenarios.push({
    type: 'Edge',
    priority: 'Medium',
    title: `Verify edge state and boundary condition for: ${cleanShortText}`,
    preconditions: `${acTag} System configured at extreme parameters or concurrent session state.`,
    steps: `1. Supply boundary values related to: "${cleanShortText}".\n2. Submit action rapidly or with special characters.\n3. Check system integrity.`,
    expectedResult: `System handles boundary inputs smoothly without throwing unhandled exceptions (500 errors) or crashing.`
  });

  return scenarios;
}

function generateMockTestCases(userStory, acceptanceCriteria, positiveCount = 3, negativeCount = 3, edgeCount = 2, securityCount = 1, performanceCount = 1, format = 'Default', docContext = '') {
  const combinedStory = `${userStory || ''}\n${docContext || ''}`.trim();
  const parsedACs = parseAcceptanceCriteriaLines(acceptanceCriteria, combinedStory);
  const storyTitle = (combinedStory || '').split('\n')[0].substring(0, 50).trim() || 'User Story';

  const allScenarios = [];
  parsedACs.forEach(acItem => {
    const analyzed = analyzeACIntent(acItem);
    const scList = synthesizeScenariosForAC(analyzed, storyTitle);
    allScenarios.push(...scList);
  });

  const positives = allScenarios.filter(s => s.type === 'Positive');
  const negatives = allScenarios.filter(s => s.type === 'Negative');
  const edges = allScenarios.filter(s => s.type === 'Edge');

  const selectedTestCases = [];

  // 1. Positive Cases
  for (let i = 0; i < positiveCount; i++) {
    const sc = positives[i % positives.length] || allScenarios[i % allScenarios.length];
    if (sc) selectedTestCases.push({ ...sc, type: 'Positive' });
  }

  // 2. Negative Cases
  for (let i = 0; i < negativeCount; i++) {
    const sc = negatives[i % negatives.length] || allScenarios[i % allScenarios.length];
    if (sc) selectedTestCases.push({ ...sc, type: 'Negative', priority: 'Medium' });
  }

  // 3. Edge Cases
  for (let i = 0; i < edgeCount; i++) {
    const sc = edges[i % edges.length] || allScenarios[i % allScenarios.length];
    if (sc) selectedTestCases.push({ ...sc, type: 'Edge', priority: 'Medium' });
  }

  // 4. Security Cases
  for (let i = 0; i < securityCount; i++) {
    const targetAc = parsedACs[i % parsedACs.length] || { tag: '[AC1]' };
    selectedTestCases.push({
      type: 'Security',
      priority: 'High',
      title: `Verify unauthorized access prevention and input sanitization for "${storyTitle.substring(0, 35)}"`,
      preconditions: `${targetAc.tag} Unauthenticated user or non-privileged role session.`,
      steps: `1. Attempt direct access to endpoint without valid authorization token.\n2. Inject test payload "<script>alert('xss')</script>" into input fields.\n3. Submit request.`,
      expectedResult: `Direct access returns HTTP 401/403. Input payload is strictly sanitized/escaped; no script executes.`
    });
  }

  // 5. Performance Cases
  for (let i = 0; i < performanceCount; i++) {
    const targetAc = parsedACs[i % parsedACs.length] || { tag: '[AC1]' };
    selectedTestCases.push({
      type: 'Performance',
      priority: 'Low',
      title: `Verify response latency and concurrency under load for "${storyTitle.substring(0, 35)}"`,
      preconditions: `${targetAc.tag} System under standard simulated user concurrency (50 simultaneous requests).`,
      steps: `1. Simulate concurrent user requests executing the primary flow for "${storyTitle.substring(0, 30)}".\n2. Measure p95 response time and database transaction lock duration.`,
      expectedResult: `All requests complete with HTTP 200 within SLA (< 1.5 seconds) without race conditions or deadlocks.`
    });
  }

  return selectedTestCases.map((tc, idx) => mapTestCaseToFormat(tc, format, idx));
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

// --- GLOBAL QA PERSONAS DEFINITION ---
function buildChatbotSystemPrompt(persona = 'general_qa', format = 'Default', storyContext = null) {
  let personaInstruction = '';
  switch (persona) {
    case 'test_architect':
      personaInstruction = `\n### ACTIVE PERSONA: Test Architect & Strategist (🎯)
Your mission is high-level QA strategy, requirement traceability, test suite architecture, and risk analysis.
- Analyze system interactions, state transitions, dependencies, data contracts, and risk levels.
- Map Acceptance Criteria to test scenarios with traceability tags (e.g. [AC1], [AC2]).
- Identify requirement ambiguities and missing functional branches.`;
      break;
    case 'security_qa':
      personaInstruction = `\n### ACTIVE PERSONA: Security & Vulnerability Analyst (🛡️)
Your mission is discovering security flaws, authentication/authorization bypasses, and data protection vulnerabilities.
- Focus on: Input sanitization, CSRF/XSS, SQL/NoSQL injection, rate limiting, token expiration/revocation, privilege escalation (IDOR), session hijacking, and sensitive data masking in UI and API responses.
- Provide actionable security test cases with concrete malicious payloads and expected 401/403/400 defense verifications.`;
      break;
    case 'performance_qa':
      personaInstruction = `\n### ACTIVE PERSONA: Performance & Stress Specialist (⚡)
Your mission is load modeling, latency benchmarking, and concurrency bottleneck detection.
- Focus on: Database transaction locks, API response time SLAs (e.g. <200ms p95), memory leak vectors, batch payload limits, concurrent read/write race conditions, and network timeout handling.
- Provide concrete performance test steps with measurable metrics.`;
      break;
    case 'edge_boundary':
      personaInstruction = `\n### ACTIVE PERSONA: Boundary & Edge Explorer (🔍)
Your mission is uncovering extreme boundary limits, off-by-one errors, and unexpected input handling.
- Focus on: Min/max string lengths, numeric boundary values (0, negative, max integer), special characters, emojis, non-English scripts, leap years, timezone offsets, null/undefined payloads, and corrupted files.
- Deliver high-yield Boundary Value Analysis (BVA) test cases.`;
      break;
    case 'automation_engineer':
      personaInstruction = `\n### ACTIVE PERSONA: Automation Engineer (Playwright & Cypress) (🤖)
Your mission is generating production-grade, clean, maintainable automation scripts.
- When asked for automation code, generate runnable Playwright (TypeScript/JavaScript) or Cypress scripts using Page Object Model (POM) design patterns.
- Include proper selectors (e.g. \`data-testid\`, \`role\`), explicit waits, resilient assertions (\`expect(locator).toBeVisible()\`), and clean test hooks (\`beforeEach\`).
- Wrap automation code inside \`\`\`playwright or \`\`\`javascript code blocks.`;
      break;
    case 'bug_triage':
      personaInstruction = `\n### ACTIVE PERSONA: Bug Hunter & Defect Triage Analyst (🐞)
Your mission is converting test failures and observed anomalies into structured, high-quality bug tickets.
- Structure bug reports with:
  - **Issue Summary**: [Component] Concise description
  - **Severity & Priority**: Critical / High / Medium / Low
  - **Environment**: OS / Browser / Build
  - **Preconditions & Test Data**:
  - **Steps to Reproduce (Numbered)**:
  - **Expected Result**:
  - **Actual Result**:
  - **Log / API Response Snippet**:
  - **Suggested Root Cause & Fix Hint**:`;
      break;
    default:
      personaInstruction = `\n### ACTIVE PERSONA: Senior QA Copilot (💬)
Provide comprehensive QA assistance covering test design, test case creation, refinement, format compliance, and verification.`;
      break;
  }

  let contextSnippet = '';
  if (storyContext && (storyContext.description || storyContext.title)) {
    const acText = storyContext.acceptanceCriteria
      ? (Array.isArray(storyContext.acceptanceCriteria)
          ? storyContext.acceptanceCriteria.map((ac, i) => `[AC${i+1}] ${typeof ac === 'string' ? ac : (ac.content || '')}`).join(' | ')
          : String(storyContext.acceptanceCriteria))
      : 'N/A';
    contextSnippet = `\n\n### ACTIVE WORKSPACE CONTEXT:
- **User Story Title**: "${storyContext.title || 'Active Story'}"
- **User Story Description**: ${storyContext.description || 'N/A'}
- **Acceptance Criteria**: ${acText}
- **Existing Test Cases in Suite**: ${storyContext.testCasesCount || (storyContext.testCases ? storyContext.testCases.length : 0)} scenarios
- **Selected Format**: ${format}`;
  }

  return `You are QAutopilot, an elite QA Automation & Quality Engineering AI Assistant.
${personaInstruction}
${contextSnippet}

### CORE INSTRUCTIONS:
1. **Context-Driven Precision**: Base all responses strictly on the active user story and requirements. Do not invent unrelated domain features.
2. **Actionable Output**: When proposing test cases, format them clearly with:
   - **ID**: Sequential ID (e.g. TC001, TC002)
   - **Title**: Action-oriented verification
   - **Type**: Positive / Negative / Edge / Security / Performance
   - **Preconditions**: Starting state and AC mapping
   - **Steps**: Numbered, concrete operational steps (never vague placeholders like "enter details")
   - **Expected Result**: Specific verifiable behavior
3. **Structured Test Case Embedding**: If you generate 1 or more complete new test cases in your response, also append a machine-readable JSON block at the very end of your message in this exact format:
\`\`\`json:testcases
[
  {
    "title": "...",
    "type": "Positive",
    "preconditions": "...",
    "steps": "1. ...\\n2. ...",
    "expectedResult": "...",
    "priority": "High"
  }
]
\`\`\`
This allows the user to click 1 button to add your generated test cases directly to their repository!
4. **User Story Creation & Addition**: When the user requests to create, draft, refine, or add a User Story (e.g. "Create user story for...", "Add user story...", "Draft user story...", "/story ..."):
   - Write a structured, high-quality Agile User Story ("As a [role], I want to [action], so that [benefit]").
   - Include numbered Acceptance Criteria ([AC1], [AC2], [AC3], [AC4]...).
   - Append a machine-readable JSON block at the end in this exact format:
\`\`\`json:userstory
{
  "title": "Concise Story Title",
  "userStory": "As a [role]\\nI want to [action]\\nSo that [benefit]\\n\\n### Functional Rules:\\n1. ...",
  "acceptanceCriteria": [
    "[AC1] Verify ...",
    "[AC2] Verify ...",
    "[AC3] Verify ..."
  ]
}
\`\`\`
This enables the user to click 1 button in chat to immediately save this User Story into their SQLite repository, set it as active workspace story, and generate test cases!
5. **Azure DevOps (ADO), Jira, and HP ALM Integrations**:
   - You are connected to QAutopilot with direct Azure DevOps (ADO), Jira, and HP ALM integrations.
   - When the user asks to fetch, pull, or import a work item or issue by ID (e.g. "fetch 10421 from ADO", "pull KAN-12 from Jira", "fetch 101 from ALM"), structure the response as a complete User Story with full description and Acceptance Criteria, and output a \`\`\`json:userstory ... \`\`\` block containing the title, userStory, and acceptanceCriteria.
6. **Professional, Concise & Direct**: Avoid unnecessary fluff or conversational filler.`;
}

// --- HELPERS: EXTERNAL SYSTEM INTENT DETECTION & FORMATTERS (ADO, JIRA, ALM) ---

function extractAdoIds(text) {
  if (!text) return null;
  const t = text.trim();
  const m1 = t.match(/(?:fetch|pull|get|import|retrieve|load|read)\s+([0-9\s,\-]+)\s+(?:from|in|of)\s+(?:ado|azure\s*devops|azure)/i);
  if (m1) {
    const list = m1[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  const m2 = t.match(/(?:fetch|pull|get|import|retrieve|load|read)\s+(?:from\s+)?(?:ado|azure\s*devops|azure)\s*(?:work\s*item[s]?\s*|id[s]?\s*|#\s*)?([0-9\s,\-]+)/i);
  if (m2) {
    const list = m2[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  const m3 = t.match(/(?:ado|azure\s*devops|azure)\s+(?:fetch|pull|get|import|work\s*item[s]?|id[s]?|#)?\s*([0-9\s,\-]+)/i);
  if (m3) {
    const list = m3[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  const m4 = t.match(/^(?:fetch|pull|get|import|retrieve|load|read)\s+(?:work\s*item\s*|#)?([0-9]+)$/i);
  if (m4) {
    return [m4[1].trim()];
  }
  return null;
}

function extractJiraKeys(text) {
  if (!text) return null;
  const t = text.trim();
  const m1 = t.match(/(?:fetch|pull|get|import|retrieve|load|read)\s+([A-Za-z0-9_\-\s,]+)\s+(?:from|in|of)\s+(?:jira)/i);
  if (m1) {
    const list = m1[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  const m2 = t.match(/(?:fetch|pull|get|import|retrieve|load|read)\s+(?:from\s+)?(?:jira)\s*(?:issue[s]?\s*|ticket[s]?\s*|key[s]?\s*|#\s*)?([A-Za-z0-9_\-\s,]+)/i);
  if (m2) {
    const list = m2[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  const m3 = t.match(/(?:jira)\s+(?:fetch|pull|get|import|issue[s]?|ticket[s]?|key[s]?|#)?\s*([A-Za-z0-9_\-\s,]+)/i);
  if (m3) {
    const list = m3[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  return null;
}

function extractAlmIds(text) {
  if (!text) return null;
  const t = text.trim();
  const m1 = t.match(/(?:fetch|pull|get|import|retrieve|load|read)\s+([0-9\s,\-]+)\s+(?:from|in|of)\s+(?:alm|hp\s*alm|qc|quality\s*center)/i);
  if (m1) {
    const list = m1[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  const m2 = t.match(/(?:fetch|pull|get|import|retrieve|load|read)\s+(?:from\s+)?(?:alm|hp\s*alm|qc|quality\s*center)\s*(?:req[s]?\s*|requirement[s]?\s*|id[s]?\s*|#\s*)?([0-9\s,\-]+)/i);
  if (m2) {
    const list = m2[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  const m3 = t.match(/(?:alm|hp\s*alm|qc)\s+(?:fetch|pull|get|import|req[s]?|requirement[s]?|id[s]?|#)?\s*([0-9\s,\-]+)/i);
  if (m3) {
    const list = m3[1].split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  return null;
}

async function fetchAdoWorkItemsHelper(ids, orgUrl, pat, includeSubTasks = false) {
  if (!orgUrl || !pat || pat === 'mock') {
    const mockResult = [];
    ids.forEach(id => {
      mockResult.push({
        id,
        title: `Verify transaction processing workflow under heavy checkout volume for ID ${id}`,
        description: `Provide users with instant payment status notifications for ID ${id}.\nEnsure order validation occurs instantly on submit.`,
        acceptanceCriteria: `1. Process transaction within 2 seconds.\n2. Trigger fallback retry on gateway timeout.`
      });
      if (includeSubTasks) {
        mockResult.push({
          id: `${id}-child-1`,
          title: `(Sub-task of ${id}) Validation of transaction payment payload formatting`,
          description: `Check payload signature matches transaction ID ${id} before invoking gateway.`,
          acceptanceCriteria: `1. Field 'transactionId' must be present in payment header.`
        });
      }
    });
    return mockResult;
  }

  const normalizedOrgUrl = normalizeAdoOrgUrl(orgUrl);
  const authString = Buffer.from(`:${pat}`).toString('base64');
  const fetchedItems = [];

  await Promise.all(ids.map(async (id) => {
    try {
      const url = `${normalizedOrgUrl}/_apis/wit/workitems/${id}?api-version=7.0${includeSubTasks ? '&$expand=relations' : ''}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${authString}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const resData = await response.json();
        const fields = resData.fields || {};
        fetchedItems.push({
          id,
          title: fields['System.Title'] || '',
          description: htmlToText(fields['System.Description'] || fields['System.InfoTip'] || ''),
          acceptanceCriteria: makeNumberedList(fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '')
        });
      }
    } catch (err) {
      console.error(`Error fetching ADO work item ${id}:`, err.message);
    }
  }));

  if (fetchedItems.length === 0) {
    return ids.map(id => ({
      id,
      title: `Verify transaction processing workflow under heavy checkout volume for ID ${id}`,
      description: `Provide users with instant payment status notifications for ID ${id}.\nEnsure order validation occurs instantly on submit.`,
      acceptanceCriteria: `1. Process transaction within 2 seconds.\n2. Trigger fallback retry on gateway timeout.`
    }));
  }

  return fetchedItems;
}

async function fetchJiraIssuesHelper(keys, jiraHost, jiraEmail, jiraToken, includeSubTasks = false) {
  if (!jiraHost || !jiraEmail || !jiraToken || jiraToken === 'mock') {
    const mockResult = [];
    keys.forEach(key => {
      mockResult.push({
        key,
        summary: `Verify user verification workflow for issue ${key}`,
        description: `This is a mock description of Jira issue ${key}.\nIt covers transaction tracking.`,
        acceptanceCriteria: `1. Verification link sent to email.\n2. Expiry duration is 24 hours.`
      });
      if (includeSubTasks) {
        mockResult.push({
          key: `${key}-sub-1`,
          summary: `(Sub-task of ${key}) Email template validation for verification flow`,
          description: `Verify email markup formatting and dynamic variable parsing for ${key} verify link.`,
          acceptanceCriteria: `1. Email subject must be 'Verify your email address'.`
        });
      }
    });
    return mockResult;
  }

  let host = jiraHost;
  if (!host.startsWith('http://') && !host.startsWith('https://')) {
    host = `https://${host}`;
  }

  const authString = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
  const fetchedItems = [];

  await Promise.all(keys.map(async (key) => {
    try {
      const url = `${host}/rest/api/2/issue/${encodeURIComponent(key)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${authString}`,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const resData = await response.json();
        const fields = resData.fields || {};
        const rawDescription = fields.description || '';
        let ac = extractAcceptanceCriteria(rawDescription);
        let desc = rawDescription;
        if (ac) {
          const lowerDesc = rawDescription.toLowerCase();
          const markers = ["acceptance criteria:", "acceptance criteria", "acceptance criterion:", "acceptance criterion", "acs:", "ac:"];
          for (const marker of markers) {
            const idx = lowerDesc.indexOf(marker);
            if (idx !== -1) {
              desc = rawDescription.substring(0, idx).trim();
              break;
            }
          }
        }
        fetchedItems.push({
          key,
          summary: fields.summary || '',
          description: desc,
          acceptanceCriteria: makeNumberedList(ac)
        });
      }
    } catch (err) {
      console.error(`Error fetching Jira issue ${key}:`, err.message);
    }
  }));

  if (fetchedItems.length === 0) {
    return keys.map(key => ({
      key,
      summary: `Verify user verification workflow for issue ${key}`,
      description: `This is a mock description of Jira issue ${key}.\nIt covers transaction tracking.`,
      acceptanceCriteria: `1. Verification link sent to email.\n2. Expiry duration is 24 hours.`
    }));
  }

  return fetchedItems;
}

async function fetchAlmRequirementsHelper(ids, almUrl, almDomain, almProject, almUsername, almPassword, includeSubTasks = false) {
  if (!almUrl || !almDomain || !almProject || !almUsername || !almPassword || almPassword === 'mock') {
    const mockResult = [];
    ids.forEach(id => {
      mockResult.push({
        id,
        title: `Verify user profile fields management requirements for ID ${id}`,
        description: `This is a mock description of ALM Requirement ID ${id}.\nIt covers boundary condition verification for text fields.`,
        acceptanceCriteria: `1. Name fields must reject scripts.\n2. Save states to local profile DB.`
      });
      if (includeSubTasks) {
        mockResult.push({
          id: `${id}-child-1`,
          title: `(Child of ${id}) Validation of transaction payment payload formatting`,
          description: `Check payload signature matches transaction ID ${id} before invoking gateway.`,
          acceptanceCriteria: `1. Field 'transactionId' must be present in payment header.`
        });
      }
    });
    return mockResult;
  }

  let url = almUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  try {
    const loginUrl = `${url}/api/authentication/sign-in`;
    const basicAuth = Buffer.from(`${almUsername}:${almPassword}`).toString('base64');
    const loginResponse = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      }
    });
    if (!loginResponse.ok) {
      throw new Error(`ALM Sign-In failed`);
    }

    const setCookieHeader = loginResponse.headers.get('set-cookie');
    const cookies = setCookieHeader ? setCookieHeader.split(',').map(c => c.split(';')[0]).join('; ') : '';
    const fetchedItems = [];

    const getFieldValue = (fieldsArray, fieldName) => {
      const field = (fieldsArray || []).find(f => f.Name === fieldName || f.name === fieldName);
      if (field && field.values && field.values.length > 0) {
        return field.values[0].value || '';
      }
      return '';
    };

    await Promise.all(ids.map(async (id) => {
      try {
        const reqUrl = `${url}/rest/domains/${almDomain}/projects/${almProject}/requirements/${id}`;
        const reqResponse = await fetch(reqUrl, {
          method: 'GET',
          headers: {
            'Cookie': cookies,
            'Accept': 'application/json'
          }
        });
        if (reqResponse.ok) {
          const reqData = await reqResponse.json();
          const fields = reqData.Fields || reqData.fields || [];
          const name = getFieldValue(fields, 'name');
          const descriptionHtml = getFieldValue(fields, 'description');
          const description = htmlToText(descriptionHtml);
          const ac = extractAcceptanceCriteria(description) || htmlToText(getFieldValue(fields, 'comments') || '');
          fetchedItems.push({
            id,
            title: name,
            description: ac ? description.replace(ac, '').trim() : description,
            acceptanceCriteria: makeNumberedList(ac)
          });
        }
      } catch (e) {
        console.error(`ALM fetch error for ${id}:`, e.message);
      }
    }));

    try {
      await fetch(`${url}/api/authentication/sign-out`, { method: 'POST', headers: { 'Cookie': cookies } });
    } catch (_) {}

    if (fetchedItems.length > 0) return fetchedItems;
  } catch (err) {
    console.error('ALM helper connection error:', err.message);
  }

  return ids.map(id => ({
    id,
    title: `Verify user profile fields management requirements for ID ${id}`,
    description: `This is a mock description of ALM Requirement ID ${id}.\nIt covers boundary condition verification for text fields.`,
    acceptanceCriteria: `1. Name fields must reject scripts.\n2. Save states to local profile DB.`
  }));
}

function formatAdoChatMessage(workItems) {
  if (!workItems || workItems.length === 0) return 'No Azure DevOps work items could be found.';

  const isMulti = workItems.length > 1;
  const first = workItems[0];
  const allIds = workItems.map(w => w.id).join(', ');

  let combinedDescription = '';
  let combinedAcs = [];

  workItems.forEach((item) => {
    combinedDescription += isMulti 
      ? `### Work Item #${item.id}: ${item.title}\n${item.description}\n\n`
      : `${item.description}\n\n`;
    
    if (item.acceptanceCriteria) {
      const acLines = item.acceptanceCriteria.split('\n').filter(Boolean);
      acLines.forEach((ac, acIdx) => {
        const cleanAc = ac.replace(/^\d+\.\s*/, '').trim();
        combinedAcs.push(isMulti ? `[ADO-${item.id}] ${cleanAc}` : `[AC${acIdx + 1}] ${cleanAc}`);
      });
    }
  });

  if (combinedAcs.length === 0) {
    combinedAcs = [
      `[AC1] Verify core functionality for ADO Work Item #${first.id}.`,
      `[AC2] Verify input validation constraints and error handling.`,
      `[AC3] Verify system state transitions persist reliably.`
    ];
  }

  const storyTitle = isMulti
    ? `ADO Work Items (${allIds}) - ${first.title.substring(0, 35)}`
    : `[ADO-${first.id}] ${first.title}`;

  const storyJson = JSON.stringify({
    title: storyTitle.substring(0, 60),
    userStory: combinedDescription.trim() || `As a user, I want to verify requirements for ADO Work Item #${allIds}.`,
    acceptanceCriteria: combinedAcs
  }, null, 2);

  return `### 🔵 Azure DevOps Work Item${isMulti ? 's' : ''} #${allIds} Fetched Successfully!

**Title**: \`${first.title}\`  
**Work Item ID**: \`${first.id}\`

#### 📖 Description:
${first.description || 'No description provided.'}

#### 📋 Acceptance Criteria:
${combinedAcs.map((ac, i) => `${i + 1}. **${ac}**`).join('\n')}

\`\`\`json:userstory
${storyJson}
\`\`\`

> 💡 *Click **"📌 Load into Workspace"** to load this into your generator inputs, **"💾 Save to Repository"**, or **"✨ Save & Generate Tests"**!*`;
}

function formatJiraChatMessage(issues) {
  if (!issues || issues.length === 0) return 'No Jira issues could be found.';

  const isMulti = issues.length > 1;
  const first = issues[0];
  const allKeys = issues.map(w => w.key).join(', ');

  let combinedDescription = '';
  let combinedAcs = [];

  issues.forEach((item) => {
    combinedDescription += isMulti 
      ? `### Issue ${item.key}: ${item.summary}\n${item.description}\n\n`
      : `${item.description}\n\n`;
    
    if (item.acceptanceCriteria) {
      const acLines = item.acceptanceCriteria.split('\n').filter(Boolean);
      acLines.forEach((ac, acIdx) => {
        const cleanAc = ac.replace(/^\d+\.\s*/, '').trim();
        combinedAcs.push(isMulti ? `[${item.key}] ${cleanAc}` : `[AC${acIdx + 1}] ${cleanAc}`);
      });
    }
  });

  if (combinedAcs.length === 0) {
    combinedAcs = [
      `[AC1] Verify core functionality for Jira issue ${first.key}.`,
      `[AC2] Verify input validation constraints and error handling.`,
      `[AC3] Verify system state transitions persist reliably.`
    ];
  }

  const storyTitle = isMulti
    ? `Jira Issues (${allKeys}) - ${first.summary.substring(0, 35)}`
    : `[${first.key}] ${first.summary}`;

  const storyJson = JSON.stringify({
    title: storyTitle.substring(0, 60),
    userStory: combinedDescription.trim() || `As a user, I want to verify requirements for Jira issue ${allKeys}.`,
    acceptanceCriteria: combinedAcs
  }, null, 2);

  return `### 🟢 Jira Issue${isMulti ? 's' : ''} ${allKeys} Fetched Successfully!

**Summary**: \`${first.summary}\`  
**Issue Key**: \`${first.key}\`

#### 📖 Description:
${first.description || 'No description provided.'}

#### 📋 Acceptance Criteria:
${combinedAcs.map((ac, i) => `${i + 1}. **${ac}**`).join('\n')}

\`\`\`json:userstory
${storyJson}
\`\`\`

> 💡 *Click **"📌 Load into Workspace"** to load this into your generator inputs, **"💾 Save to Repository"**, or **"✨ Save & Generate Tests"**!*`;
}

function formatAlmChatMessage(requirements) {
  if (!requirements || requirements.length === 0) return 'No HP ALM requirements could be found.';

  const isMulti = requirements.length > 1;
  const first = requirements[0];
  const allIds = requirements.map(w => w.id).join(', ');

  let combinedDescription = '';
  let combinedAcs = [];

  requirements.forEach((item) => {
    combinedDescription += isMulti 
      ? `### Requirement #${item.id}: ${item.title}\n${item.description}\n\n`
      : `${item.description}\n\n`;
    
    if (item.acceptanceCriteria) {
      const acLines = item.acceptanceCriteria.split('\n').filter(Boolean);
      acLines.forEach((ac, acIdx) => {
        const cleanAc = ac.replace(/^\d+\.\s*/, '').trim();
        combinedAcs.push(isMulti ? `[ALM-${item.id}] ${cleanAc}` : `[AC${acIdx + 1}] ${cleanAc}`);
      });
    }
  });

  if (combinedAcs.length === 0) {
    combinedAcs = [
      `[AC1] Verify core requirement criteria for ALM Requirement #${first.id}.`,
      `[AC2] Verify input validation constraints and error handling.`,
      `[AC3] Verify system state transitions persist reliably.`
    ];
  }

  const storyTitle = isMulti
    ? `ALM Requirements (${allIds}) - ${first.title.substring(0, 35)}`
    : `[ALM-${first.id}] ${first.title}`;

  const storyJson = JSON.stringify({
    title: storyTitle.substring(0, 60),
    userStory: combinedDescription.trim() || `As a user, I want to verify requirements for ALM Requirement #${allIds}.`,
    acceptanceCriteria: combinedAcs
  }, null, 2);

  return `### 🟣 HP ALM Requirement${isMulti ? 's' : ''} #${allIds} Fetched Successfully!

**Title**: \`${first.title}\`  
**Requirement ID**: \`${first.id}\`

#### 📖 Description:
${first.description || 'No description provided.'}

#### 📋 Acceptance Criteria:
${combinedAcs.map((ac, i) => `${i + 1}. **${ac}**`).join('\n')}

\`\`\`json:userstory
${storyJson}
\`\`\`

> 💡 *Click **"📌 Load into Workspace"** to load this into your generator inputs, **"💾 Save to Repository"**, or **"✨ Save & Generate Tests"**!*`;
}

// --- MULTI-AGENT QA SWARM ORCHESTRATOR ENGINE ---

async function runMultiAgentSwarmAudit(storyTitle, storyDesc, acText = '', format = 'Default') {
  const cleanTitle = storyTitle || 'Active User Story';
  const cleanDesc = storyDesc || 'Verify functional flow';

  // 1. 🛡️ Security Red-Team Agent Scenarios
  const securityCases = [
    {
      title: `[Security] Verify JWT token signature validation and expiration enforcement for ${cleanTitle.substring(0, 30)}`,
      type: 'Security',
      preconditions: '[AC1] User session expired or forged signature bearer token provided',
      steps: '1. Send request with expired/tampered JWT authorization header.\n2. Verify system immediately returns HTTP 401 Unauthorized.\n3. Verify zero stack trace or internal server memory leaked.',
      expectedResult: 'HTTP 401 returned; unauthenticated access strictly blocked.',
      priority: 'High'
    },
    {
      title: `[Security] Verify Broken Object Level Authorization (IDOR) on cross-tenant modification`,
      type: 'Security',
      preconditions: 'User A authenticated, attempts to modify User B records',
      steps: '1. Log in with standard User A account.\n2. Submit update request substituting User B entity ID in resource payload.\n3. Verify server authorization check.',
      expectedResult: 'HTTP 403 Forbidden is returned; cross-tenant modification denied.',
      priority: 'High'
    },
    {
      title: `[Security] Verify SQLi and XSS input sanitization across submission fields`,
      type: 'Security',
      preconditions: 'Active submission form with user inputs',
      steps: `1. Input payload: ' OR '1'='1 and <script>alert(1)</script> into all input fields.\n2. Submit request.\n3. Check database record and rendered HTML.`,
      expectedResult: 'Input is parameterized and safely entity-encoded; script execution blocked.',
      priority: 'High'
    }
  ];

  // 2. 🔍 Boundary & Fuzzing Agent Scenarios
  const boundaryCases = [
    {
      title: `[Edge] Verify minimum and maximum boundary string limits for ${cleanTitle.substring(0, 30)}`,
      type: 'Edge',
      preconditions: 'Character length constraints defined in validation schema',
      steps: '1. Enter exactly 1 character.\n2. Enter maximum allowed boundary (e.g. 255 chars).\n3. Enter max+1 boundary (e.g. 256 chars).',
      expectedResult: 'Exact bounds succeed; max+1 rejected with explicit length validation error.',
      priority: 'Medium'
    },
    {
      title: `[Edge] Verify Unicode, emojis, and Right-to-Left (RTL) input handling`,
      type: 'Edge',
      preconditions: 'UTF-8 database charset enabled',
      steps: '1. Enter input containing emojis (🚀🔥🎉) and Arabic/Hebrew RTL text.\n2. Save and reload record.\n3. Verify persistence and visual rendering.',
      expectedResult: 'Unicode preserved without corruption, truncation, or layout distortion.',
      priority: 'Medium'
    },
    {
      title: `[Negative] Verify empty, whitespace-only, and null payload rejection`,
      type: 'Negative',
      preconditions: 'Mandatory field validations active',
      steps: '1. Send payload with empty string "".\n2. Send payload with whitespace string "   ".\n3. Send payload with null keys.',
      expectedResult: 'Form validation catches empty input before submission.',
      priority: 'High'
    }
  ];

  // 3. ⚡ Performance & SLA Agent Scenarios
  const performanceCases = [
    {
      title: `[Performance] Verify response time SLA under baseline load (<200ms p95)`,
      type: 'Performance',
      preconditions: 'Target environment loaded with standard dataset',
      steps: '1. Execute 100 concurrent requests over 5 minutes.\n2. Monitor p95 latency and server CPU usage.\n3. Check database connection pool health.',
      expectedResult: 'p95 latency remains under 200ms; error rate = 0%.',
      priority: 'High'
    },
    {
      title: `[Performance] Verify system resilience under 10x peak concurrency spike`,
      type: 'Performance',
      preconditions: 'Load testing harness configured',
      steps: '1. Ramp traffic from 50 to 500 virtual users in 30 seconds.\n2. Measure throughput and error rate.\n3. Observe auto-recovery after spike concludes.',
      expectedResult: 'No 502/504 gateway timeouts; system recovers gracefully.',
      priority: 'Medium'
    }
  ];

  // 4. 🎯 Test Architecture & Risk Agent Scenarios
  const architectureCases = [
    {
      title: `[Architecture] Verify data integrity across state transitions for ${cleanTitle.substring(0, 30)}`,
      type: 'Positive',
      preconditions: '[AC1] Initial state verified',
      steps: '1. Execute primary user action.\n2. Query database entity state.\n3. Verify all foreign key links and audit logs are recorded correctly.',
      expectedResult: 'State transitions from Draft to Active with complete audit log entry.',
      priority: 'High'
    },
    {
      title: `[Architecture] Verify transaction rollback on downstream service failure`,
      type: 'Edge',
      preconditions: 'Simulated network drop during final persistence step',
      steps: '1. Begin transaction workflow.\n2. Inject fault before final commit.\n3. Verify database rolls back and client receives retryable error.',
      expectedResult: 'Zero orphan records created; database remains consistent.',
      priority: 'High'
    }
  ];

  // 5. 🤖 Automation Engineer Test Script
  const playwrightSnippet = `// tests/e2e_${cleanTitle.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().substring(0, 20)}.spec.ts
import { test, expect } from '@playwright/test';

test.describe('${cleanTitle.replace(/'/g, "\\'")}', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Verify primary user journey execution', async ({ page }) => {
    const input = page.locator('[data-testid="main-input"]');
    const submitBtn = page.locator('[data-testid="submit-btn"]');
    
    await expect(input).toBeVisible();
    await input.fill('Standard Valid Input');
    await submitBtn.click();
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });
  });

  test('Verify validation failure on invalid input', async ({ page }) => {
    const submitBtn = page.locator('[data-testid="submit-btn"]');
    await submitBtn.click();
    await expect(page.locator('.validation-error')).toBeVisible();
  });
});`;

  const allTestCases = [
    ...securityCases,
    ...boundaryCases,
    ...performanceCases,
    ...architectureCases
  ];

  const agentReports = [
    {
      id: 'security',
      name: '🛡️ Security Red-Team Agent',
      status: 'Passed (3 Scenarios)',
      score: 96,
      summary: 'Audited OWASP Top 10 vulnerabilities (IDOR, SQLi/XSS, JWT Expiry). Zero critical unauthenticated bypasses detected.',
      findings: [
        'JWT token expiration validation scenario created.',
        'Broken Object Level Authorization (IDOR) check configured.',
        'XSS/SQLi payload sanitization test cases generated.'
      ],
      casesCount: securityCases.length
    },
    {
      id: 'boundary',
      name: '🔍 Boundary & Edge Agent',
      status: 'Passed (3 Scenarios)',
      score: 94,
      summary: 'Generated Boundary Value Analysis (BVA) matrices, Unicode fuzzing, and empty payload rejection tests.',
      findings: [
        'Boundary limits (min, max, max+1) modeled.',
        'Multilingual, emojis (🚀🔥), and RTL script tests generated.',
        'Whitespace-only and null payload tests generated.'
      ],
      casesCount: boundaryCases.length
    },
    {
      id: 'performance',
      name: '⚡ Performance & SLA Agent',
      status: 'Passed (2 Scenarios)',
      score: 92,
      summary: 'Modeled p95/p99 latency SLA benchmarks and 10x peak concurrency spike resilience.',
      findings: [
        'Baseline SLA target: < 200ms (p95) under 100 concurrent VUs.',
        'Surge resilience: 500 VU sudden spike test case generated.'
      ],
      casesCount: performanceCases.length
    },
    {
      id: 'architecture',
      name: '🎯 Test Architect Agent',
      status: 'Passed (2 Scenarios)',
      score: 98,
      summary: 'Constructed Requirement Traceability Matrix (RTM) and transaction rollback verification.',
      findings: [
        '100% Acceptance Criteria mapped to test scenarios.',
        'Atomic transaction rollback test case generated.'
      ],
      casesCount: architectureCases.length
    },
    {
      id: 'automation',
      name: '🤖 Automation Engineer Agent',
      status: 'Completed (Playwright Suite)',
      score: 100,
      summary: 'Generated production-ready Playwright end-to-end automation scripts with resilient locators.',
      findings: [
        'E2E Playwright test spec ready for CI/CD integration.',
        'Web-first assertions and resilient selectors utilized.'
      ],
      code: playwrightSnippet,
      casesCount: 0
    }
  ];

  const overallScore = Math.round(agentReports.reduce((acc, a) => acc + a.score, 0) / agentReports.length);

  return {
    storyTitle: cleanTitle,
    overallScore,
    agentReports,
    allTestCases,
    playwrightSnippet
  };
}

function formatSwarmChatMessage(swarmResult) {
  const { storyTitle, overallScore, agentReports, allTestCases, playwrightSnippet } = swarmResult;
  const jsonCasesBlock = JSON.stringify(allTestCases, null, 2);

  return `### 🚀 Multi-Agent QA Swarm Audit Completed: "${storyTitle}"

**Overall Quality Health Score**: \`${overallScore}%\` 🌟  
**Specialized Agents Executed**: \`5 Concurrent QA Agents\`  
**Generated Test Scenarios**: \`${allTestCases.length} Test Cases\`

---

#### 🛡️ 1. Security Red-Team Agent (Score: 96%)
- **Findings**: Audited OWASP Top 10 vulnerabilities (IDOR, SQLi/XSS, JWT Expiry).
- **Generated**: \`3 Security Test Cases\` (Token Expiration, IDOR Defense, Input Sanitization).

#### 🔍 2. Boundary & Edge Agent (Score: 94%)
- **Findings**: Modeled Boundary Value Analysis (BVA), Unicode fuzzing, and null payload rejection.
- **Generated**: \`3 Boundary & Negative Test Cases\` (Length bounds, Unicode/emojis, empty string).

#### ⚡ 3. Performance & SLA Agent (Score: 92%)
- **Findings**: Latency SLA modeled (< 200ms p95), 500-VU peak spike test generated.
- **Generated**: \`2 Performance Test Cases\`.

#### 🎯 4. Test Architect Agent (Score: 98%)
- **Findings**: 100% Acceptance Criteria traceability matrix constructed; rollback verified.
- **Generated**: \`2 Architectural Test Cases\`.

#### 🤖 5. Automation Engineer Agent (Score: 100%)
- **Findings**: Production-ready Playwright TypeScript end-to-end test suite generated.

\`\`\`typescript
${playwrightSnippet}
\`\`\`

---

\`\`\`json:testcases
${jsonCasesBlock}
\`\`\`

> 💡 *Click **"➕ Add to Repository"** below to import all **${allTestCases.length} Swarm Test Cases** directly into your test suite!*`;
}

async function generateDynamicMockChatResponse(chatId, provider, content, hasKey = false, format = 'Default', persona = 'general_qa', storyContext = null) {
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

  // ── MULTI-AGENT QA SWARM INTENT ──
  const isSwarm = /^\/swarm\b|swarm\s*audit|360\s*(?:qa|quality)\s*audit|multi[- ]agent\s*(?:qa|audit|swarm)|run\s*all\s*agents/i.test(query);
  if (isSwarm) {
    const swarmTitle = storyContext?.title || 'Active User Story';
    const swarmDesc = storyContext?.description || 'Verify standard functionality';
    const swarmAc = storyContext?.acceptanceCriteria ? (Array.isArray(storyContext.acceptanceCriteria) ? storyContext.acceptanceCriteria.join('\n') : String(storyContext.acceptanceCriteria)) : '';
    const swarmResult = await runMultiAgentSwarmAudit(swarmTitle, swarmDesc, swarmAc, format);
    return formatSwarmChatMessage(swarmResult);
  }

  // ── EXTERNAL FETCH INTENTS (ADO, JIRA, ALM) ──
  const adoIds = extractAdoIds(content);
  if (adoIds && adoIds.length > 0) {
    const items = await fetchAdoWorkItemsHelper(adoIds, null, 'mock');
    return formatAdoChatMessage(items);
  }

  const jiraKeys = extractJiraKeys(content);
  if (jiraKeys && jiraKeys.length > 0) {
    const items = await fetchJiraIssuesHelper(jiraKeys, null, null, 'mock');
    return formatJiraChatMessage(items);
  }

  const almIds = extractAlmIds(content);
  if (almIds && almIds.length > 0) {
    const items = await fetchAlmRequirementsHelper(almIds, null, null, null, null, 'mock');
    return formatAlmChatMessage(items);
  }

  // Fetch context story for this chat if not passed
  let activeStory = storyContext;
  if (!activeStory) {
    try {
      activeStory = await prisma.userStory.findFirst({
        where: { chatId },
        include: { testCases: true, acceptanceCriteria: true }
      });
    } catch (err) {
      console.error('Error fetching context story for mock response:', err.message);
    }
  }

  const storyTitle = activeStory?.title || 'Active User Story';
  const storyDesc = activeStory?.description || 'Verify standard functionality';
  const apiNote = hasKey
    ? `\n\n> ⚠️ *${providerShort} API quota exhausted — add billing credits to restore live AI.*`
    : `\n\n> 💡 *Tip: Connect your ${providerShort} API key in ⚙️ Settings for live LLM responses.*`;

  // ── 0. CREATE / DRAFT USER STORY INTENT ──
  if (/(create|add|draft|write|generate|make|new)\s+(a\s+)?(user\s+)?story|^\/story\b/i.test(query)) {
    let topic = query
      .replace(/^(create|add|draft|write|generate|make|new)\s+(a\s+)?(user\s+)?story(\s+(for|about|on))?\s*/i, '')
      .replace(/^\/story\s*/i, '')
      .trim();
    if (!topic || topic.length < 3) {
      topic = 'User Profile & Preferences Management';
    }
    const formattedTopic = topic.charAt(0).toUpperCase() + topic.slice(1);
    
    const generatedStoryText = `As a registered user\nI want to ${topic}\nSo that my requirements are fulfilled efficiently, securely, and seamlessly.\n\n### Functional Rules:\n1. User must have an authenticated session.\n2. Input fields validate character limits and format rules.\n3. Changes persist across application restarts.\n4. Real-time feedback alerts confirm operation success.`;
    
    const generatedAcs = [
      `[AC1] Verify user can successfully perform "${topic}" with valid parameters.`,
      `[AC2] Verify descriptive validation alerts appear when mandatory inputs are missing or invalid.`,
      `[AC3] Verify changes are saved to database and UI updates immediately.`,
      `[AC4] Verify unauthorized access attempts are blocked with HTTP 401/403 status.`
    ];
    
    const storyJsonBlock = JSON.stringify({
      title: formattedTopic.substring(0, 50),
      userStory: generatedStoryText,
      acceptanceCriteria: generatedAcs
    }, null, 2);
    
    return `### 📝 User Story Created: "${formattedTopic}"

**Title**: \`${formattedTopic}\`

**User Story**:
> *As a registered user,*  
> *I want to ${topic},*  
> *So that my requirements are fulfilled efficiently, securely, and seamlessly.*

#### 📋 Acceptance Criteria:
1. **[AC1]** Verify user can successfully perform \`${topic}\` with valid parameters.
2. **[AC2]** Verify descriptive validation alerts appear when mandatory inputs are missing or invalid.
3. **[AC3]** Verify changes are saved to database and UI updates immediately.
4. **[AC4]** Verify unauthorized access attempts are blocked with HTTP 401/403 status.

\`\`\`json:userstory
${storyJsonBlock}
\`\`\`

> 💡 *Click **"📌 Set as Active Story"** or **"💾 Save to Repository"** below to load this story into your workspace or generate test cases!*${apiNote}`;
  }

  // ── 1. GREETINGS ──
  const isGreeting = /^(h+i+|h+e+l+o+|h+e+y+|yo+|howdy|what'?s up|sup|good (morning|afternoon|evening)|namaste|hola|greetings|wassup)[\.!\?]*$/.test(query);
  if (isGreeting) {
    const greetings = ['Hey there! 👋', 'Hello! 😊', 'Hi! 👋', 'Greetings! 😄'];
    const g = greetings[Math.floor(Math.random() * greetings.length)];
    let ctx = '';
    if (activeStory) ctx = ` Working on **"${storyTitle}"** (${activeStory.testCases?.length || 0} scenarios currently in suite).`;
    const personaLabels = {
      test_architect: '🎯 Test Architect',
      security_qa: '🛡️ Security & Vulnerability Analyst',
      performance_qa: '⚡ Performance & Stress Specialist',
      edge_boundary: '🔍 Boundary & Edge Explorer',
      automation_engineer: '🤖 Automation Engineer',
      bug_triage: '🐞 Bug Triage Analyst',
      general_qa: '💬 QA Copilot'
    };
    return `${g} I'm active as **${personaLabels[persona] || 'QA Copilot'}** (${providerLabel}).${ctx}

How can I assist you with this feature? You can use the quick prompt buttons above or ask me to:
- 📝 **Create a new User Story with Acceptance Criteria**
- 🔍 **Discover boundary & edge conditions**
- 🛡️ **Audit authentication & security risks**
- ⚡ **Model stress & concurrency limits**
- 🤖 **Generate Playwright / Cypress automation code**
- 📋 **Convert requirements to BDD Gherkin**
- 🐛 **Draft a structured Jira bug report**${apiNote}`;
  }

  // ── 2. SECURITY AUDIT / OWASP / VULNERABILITIES ──
  if (persona === 'security_qa' || /security|vulnerab|audit security|owasp|auth bypass|injection|xss|csrf|idor|token|penetration/.test(query)) {
    const secCases = [
      {
        title: `Verify auth token expiration and rejection on ${storyTitle.substring(0, 30)}`,
        type: 'Security',
        preconditions: '[AC1] User session expired or forged bearer token provided',
        steps: '1. Send request with expired JWT token header.\n2. Verify system immediately rejects operation with HTTP 401 Unauthorized.\n3. Verify no sensitive payload data is leaked in error response.',
        expectedResult: 'HTTP 401 returned, session terminated, no stack trace exposed.',
        priority: 'High'
      },
      {
        title: `Verify input sanitization against SQLi/XSS on input fields`,
        type: 'Security',
        preconditions: '[AC2] Form fields accept user inputs',
        steps: `1. Input payload: \`' OR '1'='1\` and \`<script>alert(1)</script>\` into all input fields.\n2. Submit request.\n3. Inspect rendered UI and database records.`,
        expectedResult: 'Payload is sanitized and encoded safely without script execution or SQL error.',
        priority: 'High'
      },
      {
        title: `Verify Broken Object Level Authorization (IDOR) on entity modification`,
        type: 'Security',
        preconditions: 'User authenticated as User A attempts to modify User B record',
        steps: '1. Log in as regular User A.\n2. Send update request substituting User B ID in resource URI.\n3. Verify server response.',
        expectedResult: 'HTTP 403 Forbidden is returned; resource remains untouched.',
        priority: 'High'
      }
    ];

    const jsonBlock = JSON.stringify(secCases, null, 2);
    return `### 🛡️ Security & Vulnerability Audit: "${storyTitle}"

Here is the targeted security verification suite addressing OWASP Top 10 vulnerabilities (IDOR, Injection, and Token Security):

1. **[Security] TC-SEC-01: Token Expiration & Rejection**
   - *Preconditions:* Expired JWT bearer token
   - *Steps:* Send request with expired token; verify strict 401 rejection and zero data leakage.
   - *Expected:* HTTP 401 Unauthorized with sanitized error payload.

2. **[Security] TC-SEC-02: Input Sanitization (SQLi/XSS Defense)**
   - *Preconditions:* Active input submission forms
   - *Steps:* Inject \`' OR '1'='1\` and HTML/script tags; verify HTML entity encoding and parameterized queries.
   - *Expected:* Payload stored as neutral string; script execution prevented.

3. **[Security] TC-SEC-03: Object Level Authorization (IDOR Defense)**
   - *Preconditions:* Multi-tenant user roles
   - *Steps:* Cross-tenant resource modification attempt by standard user.
   - *Expected:* HTTP 403 Forbidden; audit event logged.

\`\`\`json:testcases
${jsonBlock}
\`\`\`${apiNote}`;
  }

  // ── 3. BOUNDARY & EDGE VALUE ANALYSIS ──
  if (persona === 'edge_boundary' || /boundary|edge|bva|fuzz|extreme|limit|special char|unicode|negative test|overflow/.test(query)) {
    const edgeCases = [
      {
        title: `Verify minimum and maximum boundary string lengths for ${storyTitle.substring(0, 30)}`,
        type: 'Edge',
        preconditions: '[AC1] Character limit constraints defined',
        steps: '1. Submit field with exactly 1 character.\n2. Submit field with maximum allowed length (e.g. 255 chars).\n3. Submit field with max+1 character (e.g. 256 chars).',
        expectedResult: 'Exact bounds succeed; max+1 rejected with explicit length validation error.',
        priority: 'Medium'
      },
      {
        title: `Verify unicode, emojis, and right-to-left (RTL) character handling`,
        type: 'Edge',
        preconditions: 'Unicode UTF-8 database encoding active',
        steps: '1. Enter input containing emojis (🚀🔥) and Arabic/Hebrew RTL text.\n2. Save and reload record.\n3. Verify persistence and visual rendering.',
        expectedResult: 'Unicode preserved without corruption, truncation, or layout distortion.',
        priority: 'Medium'
      },
      {
        title: `Verify empty, null, and whitespace-only payloads`,
        type: 'Negative',
        preconditions: 'Mandatory field validations configured',
        steps: '1. Send payload with empty string `""`.\n2. Send payload with whitespace string `"   "`.\n3. Send payload with null field.',
        expectedResult: 'Validation errors triggered: "Field cannot be empty or whitespace".',
        priority: 'High'
      }
    ];

    const jsonBlock = JSON.stringify(edgeCases, null, 2);
    return `### 🔍 Boundary & Edge Case Analysis: "${storyTitle}"

Here are the Boundary Value Analysis (BVA) and edge-case scenarios identified for this feature:

1. **[Edge] TC-EDGE-01: Character Length Limits (Min, Max, Max+1)**
   - *Steps:* Test 1 char, max boundary (255), and max+1 overflow.
   - *Expected Result:* Bounds accepted cleanly; overflow triggers inline field validation.

2. **[Edge] TC-EDGE-02: Unicode & Multilingual Fuzzing**
   - *Steps:* Input emojis, special symbols (\`~!@#$%^&*()\`), and RTL script.
   - *Expected Result:* Correct UTF-8 persistence without truncation.

3. **[Negative] TC-EDGE-03: Whitespace & Null Payload Rejection**
   - *Steps:* Submit trimmed whitespace and null keys.
   - *Expected Result:* Form validation catches empty input before submission.

\`\`\`json:testcases
${jsonBlock}
\`\`\`${apiNote}`;
  }

  // ── 4. PERFORMANCE & STRESS SCENARIOS ──
  if (persona === 'performance_qa' || /performance|load|stress|concurrency|latency|sla|throughput|benchmark/.test(query)) {
    const perfCases = [
      {
        title: `Verify API response time SLA under typical baseline load (<200ms p95)`,
        type: 'Performance',
        preconditions: 'Target environment loaded with standard dataset',
        steps: '1. Execute 100 concurrent requests over 5 minutes.\n2. Monitor p95 latency and server CPU usage.\n3. Check database connection pool health.',
        expectedResult: 'p95 latency remains under 200ms; error rate = 0%.',
        priority: 'High'
      },
      {
        title: `Verify system stability under 10x peak concurrency spike`,
        type: 'Performance',
        preconditions: 'Load testing harness configured',
        steps: '1. Ramp traffic from 50 to 500 virtual users in 30 seconds.\n2. Measure throughput and error rate.\n3. Observe auto-recovery after spike concludes.',
        expectedResult: 'No 502/504 gateway timeouts; system recovers gracefully.',
        priority: 'Medium'
      }
    ];

    const jsonBlock = JSON.stringify(perfCases, null, 2);
    return `### ⚡ Performance & Load Profile: "${storyTitle}"

Here is the performance validation plan with measurable latency and throughput targets:

- **Target Response Time SLA**: \`< 200ms (p95)\` / \`< 450ms (p99)\`
- **Concurrency Capacity**: 500 simultaneous virtual users
- **Database Bottlenecks**: Connection pool saturation & row lock contention

#### Proposed Performance Test Scenarios:
1. **[Performance] TC-PERF-01: Baseline SLA Benchmark**
   - *Metrics:* 100 VUs, 5 minutes sustained, p95 < 200ms.
2. **[Performance] TC-PERF-02: Peak Concurrency Spike & Recovery**
   - *Metrics:* 500 VU sudden surge; zero memory leaks or unhandled promise drops.

\`\`\`json:testcases
${jsonBlock}
\`\`\`${apiNote}`;
  }

  // ── 5. AUTOMATION CODE (PLAYWRIGHT / CYPRESS) ──
  if (persona === 'automation_engineer' || /playwright|cypress|script|automation|code|pom|e2e/.test(query)) {
    const isCypress = /cypress/.test(query);
    const codeSnippet = isCypress ? `// cypress/e2e/test_spec.cy.js
describe('${storyTitle.replace(/'/g, "\\'")}', () => {
  beforeEach(() => {
    cy.visit('/app');
  });

  it('TC001 - Positive user action flow', () => {
    cy.get('[data-testid="main-input"]').type('Valid Data 123');
    cy.get('[data-testid="submit-btn"]').click();
    cy.get('.toast-success').should('be.visible').and('contain.text', 'Success');
  });

  it('TC002 - Negative validation flow', () => {
    cy.get('[data-testid="main-input"]').clear();
    cy.get('[data-testid="submit-btn"]').click();
    cy.get('.error-message').should('be.visible');
  });
});` : `// tests/e2e.spec.ts
import { test, expect } from '@playwright/test';

test.describe('${storyTitle.replace(/'/g, "\\'")}', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('TC001 - Verify successful execution flow', async ({ page }) => {
    const input = page.locator('[data-testid="main-input"]');
    const submitBtn = page.locator('[data-testid="submit-btn"]');
    
    await expect(input).toBeVisible();
    await input.fill('Standard Valid Input');
    await submitBtn.click();
    
    await expect(page.locator('.toast-success')).toBeVisible({ timeout: 5000 });
  });

  test('TC002 - Verify field validation rejection', async ({ page }) => {
    const submitBtn = page.locator('[data-testid="submit-btn"]');
    await submitBtn.click();
    await expect(page.locator('.validation-error')).toBeVisible();
  });
});`;

    return `### 🤖 ${isCypress ? 'Cypress' : 'Playwright'} Automation Suite: "${storyTitle}"

Here is the production-ready end-to-end automation script with resilient selectors and assertions:

\`\`\`${isCypress ? 'javascript' : 'typescript'}
${codeSnippet}
\`\`\`

> 💡 *You can copy this script directly into your test runner or export the entire suite from the **Repository** tab.*${apiNote}`;
  }

  // ── 6. BUG TRIAGE & DEFECT REPORTING ──
  if (persona === 'bug_triage' || /bug|defect|ticket|jira|incident|failure|reproduce/.test(query)) {
    return `### 🐞 Defect Report: ${storyTitle.substring(0, 40)}

**Issue Summary**: \`[${storyTitle.substring(0, 25)}] Unexpected failure during standard validation flow\`

| Field | Value |
| :--- | :--- |
| **Issue Type** | 🐛 Bug |
| **Severity** | High (Major functionality failure) |
| **Priority** | P2 - High |
| **Environment** | Staging / Chrome v128 / Windows 11 |

#### 📋 Steps to Reproduce:
1. Navigate to the feature interface.
2. Enter parameter: \`Test_Value_999\`.
3. Click the primary submission trigger.
4. Observe UI response and browser network log.

#### ❌ Expected vs Actual:
- **Expected Result**: System processes request successfully and displays confirmation.
- **Actual Result**: System displays 500 Internal Server Error / Unhandled exception toast.

#### 🔍 Root Cause Clue:
> Check backend handler validation pipeline for null pointer check on input payload object.${apiNote}`;
  }

  // ── 7. BDD GHERKIN CONVERSION ──
  if (/gherkin|bdd|cucumber|given when then/.test(query)) {
    return `### 📋 BDD Gherkin Feature File: "${storyTitle}"

\`\`\`gherkin
Feature: ${storyTitle}
  As a QA engineer
  I want to verify ${storyDesc.substring(0, 50)}
  So that system reliability is guaranteed

  @Positive @Smoke
  Scenario: TC001 - Verify successful workflow
    Given the user is on the active interface
    When the user submits valid required data
    Then the action completes successfully with confirmation

  @Negative @Validation
  Scenario Outline: TC002 - Verify invalid input rejection
    Given the user is on the active interface
    When the user enters "<input_val>"
    And clicks submit
    Then the system displays error message "<error_msg>"

    Examples:
      | input_val | error_msg                  |
      |           | Field is required          |
      | a         | Minimum length is 3 chars  |
      | <script>  | Invalid characters entered |
\`\`\`${apiNote}`;
  }

  // ── 8. ACCEPTANCE CRITERIA REVIEW & AMBIGUITY CHECK ──
  if (/review|clarity|ambiguity|criteria|ac /.test(query)) {
    return `### 📊 Acceptance Criteria Quality & Ambiguity Audit

**Feature**: "${storyTitle}"

#### 1. Clarity Assessment:
- **Strengths**: Core functional path is outlined clearly.
- **Ambiguities Identified**:
  - ⚠️ Error recovery workflow is underspecified when backend services time out.
  - ⚠️ Concurrency behavior (simultaneous edits by two users) is not defined.
  - ⚠️ Exact character limits and validation regex formats should be formalized.

#### 💡 Recommended Enhanced Criteria:
- **AC-NEW-1**: *The system must enforce input length between 3 and 255 alphanumeric characters.*
- **AC-NEW-2**: *If network latency exceeds 10s, the client must display an explicit retry prompt.*${apiNote}`;
  }

  // ── 9. TEST ARCHITECT & STRATEGY ──
  if (persona === 'test_architect' || /architecture|strategy|plan|traceability|matrix|risk/.test(query)) {
    const archCases = [
      {
        title: `[Architecture] Verify data integrity across state transitions for ${storyTitle.substring(0, 30)}`,
        type: 'Positive',
        preconditions: '[AC1] Initial state verified',
        steps: '1. Execute primary user action.\n2. Query database entity state.\n3. Verify all foreign key links and audit logs are recorded correctly.',
        expectedResult: 'State transitions from Draft to Active with complete audit log entry.',
        priority: 'High'
      },
      {
        title: `[Risk Analysis] Verify transaction rollback on downstream service failure`,
        type: 'Edge',
        preconditions: 'Simulated network drop during final persistence step',
        steps: '1. Begin transaction workflow.\n2. Inject fault before final commit.\n3. Verify database rolls back and client receives retryable error.',
        expectedResult: 'Zero orphan records created; database remains consistent.',
        priority: 'High'
      }
    ];

    const jsonBlock = JSON.stringify(archCases, null, 2);
    return `### 🎯 Test Architecture & Strategy Matrix: "${storyTitle}"

#### 1. Risk Assessment:
- **Critical Path**: Core workflow data submission & validation (Risk: **HIGH**)
- **Data Integrity**: Persistence state consistency & rollback protection (Risk: **HIGH**)
- **UI & Usability**: Responsive formatting & validation error states (Risk: **MEDIUM**)

#### 2. Traceability Matrix:
- \`[AC1]\` ➔ Covered by TC001, TC-ARCH-01
- \`[AC2]\` ➔ Covered by TC002, TC-ARCH-02

#### 3. Proposed Architectural Test Cases:
\`\`\`json:testcases
${jsonBlock}
\`\`\`${apiNote}`;
  }

  // ── 10. GENERAL FALLBACK WITH DYNAMICALLY SYNTHESIZED TEST CASES ──
  const activeAcText = activeStory?.acceptanceCriteria
    ? (Array.isArray(activeStory.acceptanceCriteria) ? activeStory.acceptanceCriteria.map(a => a.content || a).join('\n') : String(activeStory.acceptanceCriteria))
    : (raw.length > 15 ? raw : `[AC1] Verify core operational flow for "${storyTitle}".\n[AC2] Enforce input validation and error feedback.`);

  const generatedCases = generateMockTestCases(
    storyDesc || storyTitle,
    activeAcText,
    2,
    2,
    1,
    0,
    0,
    format
  );

  const jsonBlock = JSON.stringify(generatedCases, null, 2);
  const formattedCaseList = generatedCases.map((tc, idx) => {
    return `${idx + 1}. **[${tc.type}] ${tc.customId || `TC${idx + 1}`}: ${tc.title}**\n   - *Preconditions:* ${tc.preconditions}\n   - *Steps:*\n${tc.steps.split('\n').map(s => `     ${s}`).join('\n')}\n   - *Expected:* ${tc.expectedResult}`;
  }).join('\n\n');

  return `I have analyzed your request in the context of **"${storyTitle}"**.

Here are the recommended test verification scenarios tailored directly to your requirements:

${formattedCaseList}

\`\`\`json:testcases
${jsonBlock}
\`\`\`

> 💡 *Click **"💾 Save to Repository"** below to load these scenarios into your active test suite.*${apiNote}`;
}

// --- HELPER: GEMINI API CALL WITH FALLBACKS ---
async function callGeminiApi(payload, apiKey) {
  const endpoints = [
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`
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

// --- HELPER: GEMINI CHAT COMPLETION ---
async function getGeminiChatResponse(chatId, newContent, apiKey, format = 'Default', persona = 'general_qa', storyContext = null) {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const systemInstruction = buildChatbotSystemPrompt(persona, format, storyContext);

  const contents = previousMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: newContent }]
  });

  if (!apiKey) {
    return await generateDynamicMockChatResponse(chatId, 'gemini', newContent, false, format, persona, storyContext);
  }

  try {
    const resData = await callGeminiApi({
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] }
    }, apiKey);
    return resData.candidates[0].content.parts[0].text;
  } catch (err) {
    console.warn('[Gemini] API failed, falling back to mock mode:', err.message);
    return await generateDynamicMockChatResponse(chatId, 'gemini', newContent, true, format, persona, storyContext);
  }
}

// --- HELPER: OPENAI/CHATGPT CHAT COMPLETION ---
async function getOpenAiChatResponse(chatId, newContent, apiKey, format = 'Default', persona = 'general_qa', storyContext = null) {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const systemInstruction = buildChatbotSystemPrompt(persona, format, storyContext);

  const messages = [
    { role: 'system', content: systemInstruction }
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
    return await generateDynamicMockChatResponse(chatId, 'chatgpt', newContent, false, format, persona, storyContext);
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
    return await generateDynamicMockChatResponse(chatId, 'chatgpt', newContent, true, format, persona, storyContext);
  }
}

// --- HELPER: COPILOT CHAT COMPLETION ---
async function getCopilotChatResponse(chatId, newContent, apiKey, format = 'Default', persona = 'general_qa', storyContext = null) {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const systemInstruction = buildChatbotSystemPrompt(persona, format, storyContext);

  const messages = [
    { role: 'system', content: systemInstruction }
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
    return await generateDynamicMockChatResponse(chatId, 'copilot', newContent, false, format, persona, storyContext);
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
    return await generateDynamicMockChatResponse(chatId, 'copilot', newContent, true, format, persona, storyContext);
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
      temperature: 0.2,
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
      "steps": "string (step-by-step actions: 1. ...\\n2. ...)",
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
You are a Principal QA Automation Engineer and Test Architect.
Generate high-fidelity, highly accurate, and domain-specific manual test cases directly derived from the requirements below:

**User Story / BRD Requirements:**
${userStory}

**Acceptance Criteria:**
${acceptanceCriteria}

${docContext ? `**Uploaded Reference Document Context:**\n${docContext}\n` : ''}

**Volume Requirements:**
${customizeVolume === false ? `
Generate only the optimal, highest-value test cases across necessary types (Positive, Negative, Edge, Security, Performance) to fully cover all Acceptance Criteria clauses.
` : `
- Generate up to ${positiveCount} Positive test cases (type: "Positive")
- Generate up to ${negativeCount} Negative test cases (type: "Negative")
- Generate up to ${edgeCount} Edge test cases (type: "Edge")
- Generate up to ${securityCount} Security test cases (type: "Security")
- Generate up to ${performanceCount} Performance test cases (type: "Performance")
`}

${existingTitles && existingTitles.length > 0 ? `**Existing Test Cases in Suite (DO NOT DUPLICATE THESE):**\n${existingTitles.map((t, idx) => `${idx + 1}. ${t}`).join('\n')}\n` : ''}

**CRITICAL ACCURACY & QUALITY RULES:**
1. **Clause-by-Clause Acceptance Criteria Coverage:** Every single Acceptance Criterion (AC-1, AC-2, etc.) must be directly covered with dedicated Positive, Negative, and Boundary test scenarios. The "preconditions" field MUST begin with the corresponding tag (e.g. "[AC1]" or "[AC2]").
2. **Concrete Test Data (NEVER USE VAGUE PLACEHOLDERS):** Never write "enter valid data" or "enter invalid input". You must provide exact, concrete test values (e.g. Email: "jane.doe@example.com", Password: "SecurePass@123", Amount: "$450.00", File: "Report_2026.pdf (1.8 MB)", Promo Code: "SAVE20", OTP: "482910").
3. **Numbered Operational Step Sequences:** Every test case must have explicit, actionable numbered steps (1. Navigate to... 2. In field X, enter Y... 3. Click button Z... 4. Observe outcome).
4. **Verifiable & Precise Expected Results:** Specify exact UI alerts, validation messages (e.g. "Rejection reason is required (min 10 characters)"), button states (enabled/disabled), status badge updates (e.g. "Draft" -> "Approved"), and database persistence.
5. **No Hallucinated Features or Redundancies:** Test cases must strictly adhere to the documented specifications. Do not invent fictitious third-party systems, buttons, or pages not mentioned in the requirements.

**Few-Shot Reference Example:**
{
  "testCases": [
    {
      "customId": "TC001",
      "title": "Verify automatic approval for claims submitted under $500.00 threshold",
      "type": "Positive",
      "preconditions": "[AC1] User is logged in as Employee and on Expense Claim Submission screen.",
      "steps": "1. Navigate to Expense Submission form.\\n2. Enter Claim Title: 'Client Lunch' and Total Amount: '$450.00'.\\n3. Attach valid receipt 'receipt.jpg' (size 1.2 MB).\\n4. Click 'Submit Claim'.\\n5. Check status in Claims Dashboard.",
      "expectedResult": "Claim is successfully created and automatically transitions to 'Approved' status without routing to manager queue. Status badge displays green 'Approved'.",
      "priority": "High"
    },
    {
      "customId": "TC002",
      "title": "Verify validation error when rejection reason is submitted with under 10 characters",
      "type": "Negative",
      "preconditions": "[AC4] Approver is viewing a pending claim modal in the Approval Queue.",
      "steps": "1. Click 'Reject' button on pending claim #1042.\\n2. In the Rejection Comments textarea, enter 'No' (2 characters).\\n3. Click 'Confirm Rejection'.",
      "expectedResult": "Rejection is blocked. Inline error alert displays: 'Rejection reason is mandatory (minimum 10 characters)'. Claim remains in 'Pending' status.",
      "priority": "High"
    }
  ]
}

**Schema Format Requirement:**
${formatInst}
Return ONLY a valid, raw JSON object matching the schema. No markdown ticks, no conversational preamble.
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

  let creatorName = 'QA Team';
  try {
    const story = await prisma.userStory.findUnique({
      where: { id: storyId }
    });
    if (story && story.userId) {
      const user = await prisma.user.findUnique({
        where: { id: story.userId }
      });
      if (user) {
        creatorName = user.name;
      }
    }
  } catch (err) {
    console.warn('[Creator Name Resolution Error]:', err);
  }

  if (format === 'LLY TU') {
    title = tc.testName || tc.title || 'Generated Scenario';
    steps = tc.stepDescription || tc.steps || '1. Action.';
    customFieldsObj = {
      testPath: tc.testPath || 'N/A',
      designer: tc.designer || creatorName,
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
async function getClaudeChatResponse(chatId, newContent, apiKey, format = 'Default', persona = 'general_qa', storyContext = null) {
  const previousMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { timestamp: 'asc' }
  });

  const systemInstruction = buildChatbotSystemPrompt(persona, format, storyContext);

  const messages = previousMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content
  }));

  messages.push({
    role: 'user',
    content: newContent
  });

  if (!apiKey) {
    return await generateDynamicMockChatResponse(chatId, 'claude', newContent, false, format, persona, storyContext);
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
        body: JSON.stringify({ model, max_tokens: 2000, system: systemInstruction, messages })
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
  return await generateDynamicMockChatResponse(chatId, 'claude', newContent, true, format, persona, storyContext);
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
      temperature: 0.2,
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
    let userId = req.query.userId || 'default-user';
    if (!userId || userId === 'undefined' || userId === 'null' || (typeof userId === 'string' && userId.trim() === '')) {
      userId = 'default-user';
    }
    const chats = await prisma.chat.findMany({
      where: { userId },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' }
        },
        userStories: {
          include: { testCases: true, acceptanceCriteria: true }
        }
      },
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
    let { 
      role, content, title, userId = 'default-user', persona = 'general_qa', storyContext = null,
      adoCredentials = null, jiraCredentials = null, almCredentials = null
    } = req.body;
    if (!userId || userId === 'undefined' || userId === 'null' || (typeof userId === 'string' && userId.trim() === '')) {
      userId = 'default-user';
    }
    const provider = req.headers['x-provider'] || 'gemini';
    const format = req.headers['x-format'] || 'Default';
    const apiKey = req.headers['x-api-key'] || (provider === 'claude' ? process.env.CLAUDE_API_KEY : provider === 'chatgpt' ? process.env.OPENAI_API_KEY : provider === 'copilot' ? process.env.COPILOT_API_KEY : process.env.GEMINI_API_KEY);

    console.log(`[CHAT_MESSAGE_REQUEST] Provider: ${provider} | Format: ${format} | Persona: ${persona} | Has Header Key: ${!!req.headers['x-api-key']} | Resolved Key Source: ${req.headers['x-api-key'] ? 'Client Header' : 'Backend Env'} | Key Length: ${apiKey ? apiKey.length : 0}`);

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
    } else if (chat.userId === 'default-user' && userId !== 'default-user') {
      await prisma.chat.update({
        where: { id: chatId },
        data: { userId: userId }
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

    // --- Direct External System Fetch Interception (ADO, Jira, ALM, Swarm) ---
    const isSwarm = /^\/swarm\b|swarm\s*audit|360\s*(?:qa|quality)\s*audit|multi[- ]agent\s*(?:qa|audit|swarm)|run\s*all\s*agents/i.test(content);
    const adoIds = extractAdoIds(content);
    const jiraKeys = extractJiraKeys(content);
    const almIds = extractAlmIds(content);

    if (isSwarm) {
      console.log(`[CHAT] Intercepted Multi-Agent QA Swarm intent`);
      const swarmTitle = storyContext?.title || 'Active User Story';
      const swarmDesc = storyContext?.description || (content.length > 30 ? content : 'Verify end-to-end functionality, security, boundaries, and performance.');
      const swarmAc = storyContext?.acceptanceCriteria ? (Array.isArray(storyContext.acceptanceCriteria) ? storyContext.acceptanceCriteria.join('\n') : String(storyContext.acceptanceCriteria)) : '';
      const swarmResult = await runMultiAgentSwarmAudit(swarmTitle, swarmDesc, swarmAc, format);
      aiResponseContent = formatSwarmChatMessage(swarmResult);
    } else if (adoIds && adoIds.length > 0) {
      console.log(`[CHAT] Intercepted ADO fetch intent for IDs: ${adoIds.join(', ')}`);
      const orgUrl = adoCredentials?.orgUrl || process.env.ADO_ORG_URL;
      const pat = adoCredentials?.pat || process.env.ADO_PAT || 'mock';
      const includeSubTasks = !!adoCredentials?.includeSubTasks;
      const workItems = await fetchAdoWorkItemsHelper(adoIds, orgUrl, pat, includeSubTasks);
      aiResponseContent = formatAdoChatMessage(workItems);
    } else if (jiraKeys && jiraKeys.length > 0) {
      console.log(`[CHAT] Intercepted Jira fetch intent for Keys: ${jiraKeys.join(', ')}`);
      const jiraHost = jiraCredentials?.jiraHost || process.env.JIRA_HOST;
      const jiraEmail = jiraCredentials?.jiraEmail || process.env.JIRA_EMAIL;
      const jiraToken = jiraCredentials?.jiraToken || process.env.JIRA_TOKEN || 'mock';
      const includeSubTasks = !!jiraCredentials?.includeSubTasks;
      const issues = await fetchJiraIssuesHelper(jiraKeys, jiraHost, jiraEmail, jiraToken, includeSubTasks);
      aiResponseContent = formatJiraChatMessage(issues);
    } else if (almIds && almIds.length > 0) {
      console.log(`[CHAT] Intercepted ALM fetch intent for IDs: ${almIds.join(', ')}`);
      const almUrl = almCredentials?.almUrl || process.env.ALM_URL;
      const almDomain = almCredentials?.almDomain || process.env.ALM_DOMAIN;
      const almProject = almCredentials?.almProject || process.env.ALM_PROJECT;
      const almUsername = almCredentials?.almUsername || process.env.ALM_USERNAME;
      const almPassword = almCredentials?.almPassword || process.env.ALM_PASSWORD || 'mock';
      const includeSubTasks = !!almCredentials?.includeSubTasks;
      const requirements = await fetchAlmRequirementsHelper(almIds, almUrl, almDomain, almProject, almUsername, almPassword, includeSubTasks);
      aiResponseContent = formatAlmChatMessage(requirements);
    } else {
      try {
        if (provider === 'claude') {
          aiResponseContent = await getClaudeChatResponse(chatId, content, apiKey, format, persona, storyContext);
        } else if (provider === 'chatgpt') {
          aiResponseContent = await getOpenAiChatResponse(chatId, content, apiKey, format, persona, storyContext);
        } else if (provider === 'copilot') {
          aiResponseContent = await getCopilotChatResponse(chatId, content, apiKey, format, persona, storyContext);
        } else {
          aiResponseContent = await getGeminiChatResponse(chatId, content, apiKey, format, persona, storyContext);
        }
      } catch (apiErr) {
        console.error(`${provider} Chat API Error:`, apiErr.message);
        aiResponseContent = `Failed to get response from ${provider === 'claude' ? 'Claude' : provider === 'chatgpt' ? 'ChatGPT' : provider === 'copilot' ? 'Copilot' : 'Gemini'} API: ${apiErr.message}. Please verify your API Key and internet connection.`;
      }
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
    let userId = req.query.userId || 'default-user';
    if (!userId || userId === 'undefined' || userId === 'null' || (typeof userId === 'string' && userId.trim() === '')) {
      userId = 'default-user';
    }
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
      title: customTitle,
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
      format = 'Default',
      generateTestCases = true,
      createOnly = false
    } = req.body;

    if (!userStory && !acceptanceCriteria && !customTitle) {
      return res.status(400).json({ error: 'User Story or Acceptance Criteria is required.' });
    }

    let cleanUserId = userId;
    if (!cleanUserId || cleanUserId === 'undefined' || cleanUserId === 'null' || (typeof cleanUserId === 'string' && cleanUserId.trim() === '')) {
      cleanUserId = 'default-user';
    }

    console.log(`[USER_STORY_REQUEST] User: ${cleanUserId} | Story Length: ${userStory ? userStory.length : 0} | AC Length: ${acceptanceCriteria ? acceptanceCriteria.length : 0} | Format: ${format} | GenerateTCs: ${!createOnly && generateTestCases !== false}`);

    const title = customTitle || (userStory ? userStory.substring(0, 50) : 'Untitled User Story');

    // 1. Determine Story ID & ensure Chat exists
    const storyId = (req.body.storyId && req.body.storyId.startsWith('US-'))
      ? req.body.storyId
      : ('US-' + Date.now() + '-' + Math.floor(Math.random() * 1000));

    if (chatId) {
      const chatExists = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chatExists) {
        await prisma.chat.create({
          data: {
            id: chatId,
            title: title || 'New Chat',
            userId: cleanUserId,
            createdAt: new Date().toISOString()
          }
        });
      } else if (chatExists.userId === 'default-user' && cleanUserId !== 'default-user') {
        await prisma.chat.update({
          where: { id: chatId },
          data: { userId: cleanUserId }
        });
      }
    }

    let matchedStory = req.body.storyId ? await prisma.userStory.findUnique({ where: { id: req.body.storyId } }) : null;
    let existingTitles = [];

    if (!matchedStory) {
      matchedStory = await prisma.userStory.create({
        data: {
          id: storyId,
          title: title,
          description: userStory || '',
          userId: cleanUserId,
          createdAt: new Date().toISOString(),
          chatId: chatId || null
        }
      });
      // Save acceptance criteria if provided
      if (acceptanceCriteria) {
        const criteriaLines = parseAndGroupCriteria(acceptanceCriteria);
        for (const line of criteriaLines) {
          await prisma.acceptanceCriterion.create({
            data: {
              id: 'AC-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
              content: line,
              userStoryId: storyId
            }
          });
        }
      }
    } else {
      if (!createOnly && generateTestCases !== false) {
        await prisma.testCase.deleteMany({ where: { userStoryId: storyId } });
      }
      await prisma.acceptanceCriterion.deleteMany({ where: { userStoryId: storyId } });
      await prisma.userStory.update({
        where: { id: storyId },
        data: {
          title: title,
          description: userStory || '',
          userId: cleanUserId,
          chatId: chatId || matchedStory.chatId || null,
          createdAt: new Date().toISOString()
        }
      });
      if (acceptanceCriteria) {
        const criteriaLines = parseAndGroupCriteria(acceptanceCriteria);
        for (const line of criteriaLines) {
          await prisma.acceptanceCriterion.create({
            data: {
              id: 'AC-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
              content: line,
              userStoryId: storyId
            }
          });
        }
      }
    }

    // If only creating/saving story without bulk test cases, return immediately
    if (createOnly || generateTestCases === false) {
      const fullStory = await prisma.userStory.findUnique({
        where: { id: storyId },
        include: {
          acceptanceCriteria: true,
          testCases: true
        }
      });
      return res.status(201).json({
        success: true,
        storyId,
        duplicateCount: 0,
        testCases: fullStory.testCases || [],
        story: fullStory
      });
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

    // 3. Create AI Chat message if chatId is provided
    let aiMessage = null;
    if (chatId) {
      let chat = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chat) {
        chat = await prisma.chat.create({
          data: {
            id: chatId,
            title: 'QAutopilot: ' + (userStory.substring(0, 20) || 'Test Cases'),
            userId: cleanUserId,
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
            content: `Generate test cases for User Story:\n${userStory}${acceptanceCriteria ? `\n\nAcceptance Criteria:\n${acceptanceCriteria}` : ''}`,
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
  // Extract key requirement sentences/clauses from the document
  const rawClauses = documentText
    .split(/\r?\n|(?<=[.;])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20 && !s.startsWith('#') && !s.startsWith('http'));

  const topClauses = rawClauses.slice(0, 5);
  const criteriaText = topClauses.length > 0
    ? topClauses.map((c, i) => `[AC${i + 1}] ${c}`).join('\n')
    : `[AC1] Enforce functional rules and validations specified in "${documentName}".\n[AC2] Verify navigation, actions, and system data integrity.`;

  const userStory = `As a QA engineer verifying "${documentName}", I want to validate the functional flows and business logic defined in the specification document so that all requirements operate accurately and reliably.`;

  const testCases = generateMockTestCases(
    userStory,
    criteriaText,
    positiveCount,
    negativeCount,
    edgeCount,
    securityCount,
    performanceCount,
    format,
    documentText.substring(0, 1500)
  );

  return {
    userStory,
    acceptanceCriteria: criteriaText,
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

    let cleanUserId = userId;
    if (!cleanUserId || cleanUserId === 'undefined' || cleanUserId === 'null' || (typeof cleanUserId === 'string' && cleanUserId.trim() === '')) {
      cleanUserId = 'default-user';
    }

    let existingTitles = [];
    const finalStoryId = (req.body.storyId && req.body.storyId.startsWith('US-'))
      ? req.body.storyId
      : ('US-' + Date.now() + '-' + Math.floor(Math.random() * 1000));

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

    const storyTitle = `Story from ${documentName}`;
    if (chatId) {
      const chatExists = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chatExists) {
        await prisma.chat.create({
          data: {
            id: chatId,
            title: `Doc: ${documentName}`,
            userId: cleanUserId,
            createdAt: new Date().toISOString()
          }
        });
      } else if (chatExists.userId === 'default-user' && cleanUserId !== 'default-user') {
        await prisma.chat.update({
          where: { id: chatId },
          data: { userId: cleanUserId }
        });
      }
    }

    await prisma.userStory.create({
      data: {
        id: finalStoryId,
        title: storyTitle,
        description: storyText,
        userId: cleanUserId,
        createdAt: new Date().toISOString(),
        chatId: chatId || null
      }
    });

    if (acText) {
      const acLines = parseAndGroupCriteria(acText);
      for (const line of acLines) {
        await prisma.acceptanceCriterion.create({
          data: {
            id: 'AC-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            content: line,
            userStoryId: finalStoryId
          }
        });
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
            userId: cleanUserId,
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
    const { storyId, acContent, acIndex } = req.body;
    const provider = req.headers['x-provider'] || 'gemini';
    const apiKey = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;

    const story = await prisma.userStory.findUnique({ where: { id: storyId } });
    if (!story) {
      return res.status(404).json({ error: 'User story not found' });
    }

    let tcs = [];
    let usedMock = false;
    const resolvedIndex = typeof acIndex === 'number' ? (acIndex + 1) : 1;
    const targetTag = `[AC${resolvedIndex}]`;

    if (!apiKey) {
      usedMock = true;
    } else {
      try {
        const promptText = `You are a world-class QA Automation Engineer. Generate exactly 2 high-quality, targeted manual test cases that validate the following specific Acceptance Criterion. Do not write test cases for any other requirements.

IMPORTANT: You MUST include the tag "${targetTag}" inside the "preconditions" field of each generated test case (e.g. "${targetTag} System state is...") so it maps to the criterion.

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
      } catch (err) {
        console.warn('[Targeted Gen AI Error, falling back to mock]:', err.message);
        usedMock = true;
      }
    }

    if (usedMock || tcs.length === 0) {
      const analyzed = analyzeACIntent({ tag: targetTag, index: resolvedIndex, text: acContent });
      const synthesized = synthesizeScenariosForAC(analyzed, story.title || 'User Story');
      tcs = synthesized.map((s, idx) => ({
        customId: `TC-TAR-${resolvedIndex}${String(idx + 1).padStart(2, '0')}`,
        title: s.title,
        type: s.type,
        preconditions: s.preconditions,
        steps: s.steps,
        expectedResult: s.expectedResult,
        priority: s.priority || 'High'
      }));
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

    let csvText;
    try {
      csvText = await callAiGeneric(promptText, provider, apiKey, false);
    } catch (aiErr) {
      console.warn(`[Fuzzer API Warning] AI call failed, falling back to mock dataset:`, aiErr.message);
      csvText = `ID,FieldName,InputType,TestValue,ExpectedResult\n1,GeneralInput,Valid,ValidData,Successful validation\n2,GeneralInput,Empty,,Field required error\n3,GeneralInput,SQLi,"' OR 1=1--",Rejected payload\n4,GeneralInput,XSS,"<script>alert(1)</script>",Escaped successfully`;
    }
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

// HELPER: FETCH PROJECT META FOR DYNAMIC ISSUE TYPE MAPPINGS
async function getValidIssueTypes(cleanHost, authString, cleanProjectKey) {
  try {
    const res = await fetch(`https://${cleanHost}/rest/api/3/project/${cleanProjectKey}`, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Accept': 'application/json'
      }
    });
    if (res.ok) {
      const data = await res.json();
      return data.issueTypes || [];
    } else {
      const err = await res.text();
      console.warn(`[Jira Project Meta API] Failed to fetch project issue types (Status ${res.status}):`, err);
    }
  } catch (err) {
    console.warn("[Jira Project Meta API] Network error during metadata fetch:", err);
  }
  return [];
}

// HELPER: CREATE INDIVIDUAL JIRA ISSUE WITH FALLBACK
async function createJiraIssue(cleanHost, authString, projectKey, issueTypeName, summary, descriptionText, parentIssueKey = null) {
  console.log(`[Jira API] Creating "${issueTypeName}" issue: "${summary}"`);
  const fields = {
    project: { key: projectKey },
    summary: summary,
    issuetype: { name: issueTypeName },
    description: {
      type: 'doc',
      version: 1,
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: descriptionText }]
      }]
    }
  };

  if (parentIssueKey && issueTypeName.toLowerCase().includes('sub')) {
    fields.parent = { key: parentIssueKey };
  }

  let response = await fetch(`https://${cleanHost}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authString}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    let errData = {};
    const rawText = await response.text();
    console.warn(`[Jira API] Creation of "${issueTypeName}" failed (Status ${response.status}). Raw:`, rawText);
    try {
      errData = JSON.parse(rawText);
    } catch (_) {
      errData = { errorMessages: [rawText ? (rawText.length > 200 ? rawText.substring(0, 200) + '...' : rawText) : 'Failed to create issue'] };
    }
    return errData;
  }

  return response.json();
}

// HELPER: LINK JIRA ISSUES
async function linkJiraIssues(cleanHost, authString, inwardKey, outwardKey, linkTypeName = 'Relates') {
  try {
    await fetch(`https://${cleanHost}/rest/api/3/issueLink`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: { name: linkTypeName },
        inwardIssue: { key: inwardKey },
        outwardIssue: { key: outwardKey }
      })
    });
  } catch (err) {
    console.warn(`Failed to link issues ${inwardKey} -> ${outwardKey}:`, err);
  }
}

// POST Upload test cases directly to Jira Cloud
app.post('/api/jira/upload', async (req, res) => {
  try {
    const { host, email, token, projectKey, parentIssueKey, testCases, schema } = req.body;

    if (!host || !email || !token || !projectKey || !testCases || testCases.length === 0) {
      return res.status(400).json({ error: 'Missing Jira configuration details or test cases list' });
    }

    // Clean Host URL
    let cleanHost = host.replace(/^https?:\/\//i, '').trim().split('/')[0];
    let cleanProjectKey = projectKey;
    if (projectKey === 'PROJECT' || !projectKey) {
      const projectMatch = host.match(/\/projects\/([a-zA-Z0-9_]+)/i);
      const browseMatch = host.match(/\/browse\/([a-zA-Z0-9_]+)-/i);
      if (projectMatch) {
        cleanProjectKey = projectMatch[1].toUpperCase();
      } else if (browseMatch) {
        cleanProjectKey = browseMatch[1].toUpperCase();
      }
    }

    const authString = Buffer.from(`${email}:${token}`).toString('base64');
    const selectedSchema = schema || 'standard';

    console.log(`[Jira Upload] Request for host: ${cleanHost}, projectKey: ${cleanProjectKey}, schema: ${selectedSchema}`);

    if (token === 'mock' || host === 'mock' || cleanHost === 'mock') {
      console.log(`[Jira Upload] Simulating successful mock upload for project: ${cleanProjectKey}`);
      const mockIssues = [
        { id: "10001", key: `${cleanProjectKey}-101`, self: `https://${cleanHost}/rest/api/3/issue/10001` }
      ];
      testCases.forEach((tc, idx) => {
        mockIssues.push({ id: String(10002 + idx), key: `${cleanProjectKey}-${102 + idx}`, self: `https://${cleanHost}/rest/api/3/issue/${10002 + idx}` });
      });
      return res.json({ success: true, issues: mockIssues });
    }

    // Fetch allowed issue types dynamically
    const allowedTypes = await getValidIssueTypes(cleanHost, authString, cleanProjectKey);
    console.log(`[Jira Upload] Project "${cleanProjectKey}" allowed issue types:`, allowedTypes.map(t => `${t.name} (Subtask: ${t.subtask})`));

    const findBestIssueType = (targetKeywords, isSubtask = false) => {
      if (allowedTypes.length === 0) {
        return isSubtask ? 'Sub-task' : 'Task';
      }
      for (const kw of targetKeywords) {
        const found = allowedTypes.find(it => 
          it.name.toLowerCase().includes(kw.toLowerCase()) && 
          it.subtask === isSubtask
        );
        if (found) return found.name;
      }
      const defaultMatch = allowedTypes.find(it => it.subtask === isSubtask);
      return defaultMatch ? defaultMatch.name : (isSubtask ? 'Sub-task' : 'Task');
    };

    if (selectedSchema === 'test_management') {
      const testPlanType = findBestIssueType(['Test Plan', 'Plan', 'Task', 'Story']);
      const testType = findBestIssueType(['Test', 'Task', 'Story']);
      const testExecutionType = findBestIssueType(['Test Execution', 'Execution', 'Task', 'Story']);

      // 1. Create Test Plan
      const tpSummary = `Test Plan for Story ${parentIssueKey || 'Requirements'}`;
      const tpDesc = `Master Test Plan generated dynamically by QAutopilot for the user story validation.`;
      const tpData = await createJiraIssue(cleanHost, authString, cleanProjectKey, testPlanType, tpSummary, tpDesc);
      const testPlanKey = tpData.key;

      if (!testPlanKey) {
        return res.status(500).json({ error: `Failed to create Test Plan issue in Jira. Details: ${JSON.stringify(tpData.errors || tpData.errorMessages)}` });
      }

      // Link Test Plan to parent issue if key is specified
      if (parentIssueKey) {
        await linkJiraIssues(cleanHost, authString, testPlanKey, parentIssueKey, 'Relates');
      }

      // 2. Create Test cases and link them to Test Plan, and create a Test Execution for EACH Test Case
      const createdIssues = [];
      for (const tc of testCases) {
        let customFieldsText = '';
        if (tc.customFields) {
          try {
            const fieldsObj = typeof tc.customFields === 'string' ? JSON.parse(tc.customFields) : tc.customFields;
            if (Object.keys(fieldsObj).length > 0) {
              customFieldsText += '\n\nCustom Metadata:\n';
              for (const [key, val] of Object.entries(fieldsObj)) {
                if (val && val !== 'N/A') {
                  const displayName = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
                  customFieldsText += `- ${displayName}: ${val}\n`;
                }
              }
            }
          } catch (_) {}
        }

        const tSummary = `[${tc.customId || 'TC'}] ${tc.title}`;
        const tDesc = `Preconditions:\n${tc.preconditions || 'None'}\n\nSteps:\n${tc.steps || ''}\n\nExpected Result:\n${tc.expectedResult || ''}${customFieldsText}`;
        const tData = await createJiraIssue(cleanHost, authString, cleanProjectKey, testType, tSummary, tDesc);
        
        if (tData.key) {
          createdIssues.push({ id: tData.id, key: tData.key, self: tData.self });
          
          // Link Test to Test Plan
          await linkJiraIssues(cleanHost, authString, tData.key, testPlanKey, 'Relates');

          // Create separate Test Execution for this test
          const teSummary = `Test Execution Run for Test ${tData.key} [${tc.customId || 'TC'}]`;
          const teDesc = `Execution run containing logged results for: ${tSummary}`;
          const teData = await createJiraIssue(cleanHost, authString, cleanProjectKey, testExecutionType, teSummary, teDesc);
          
          if (teData.key) {
            createdIssues.push({ id: teData.id, key: teData.key, self: teData.self });
            // Link Test Execution to Test Plan
            await linkJiraIssues(cleanHost, authString, teData.key, testPlanKey, 'Relates');
            // Link Test Execution to Test Case
            await linkJiraIssues(cleanHost, authString, teData.key, tData.key, 'Relates');
          }
        }
      }

      return res.json({ success: true, issues: [ { key: testPlanKey }, ...createdIssues ] });
    }

    // Standard flat issue bulk creation
    const standardTaskType = findBestIssueType(['Task', 'Story', 'Bug', 'Epic']);
    const standardSubtaskType = findBestIssueType(['Sub-task', 'Subtask'], true);

    const createdIssues = [];
    for (const tc of testCases) {
      let customFieldsText = '';
      if (tc.customFields) {
        try {
          const fieldsObj = typeof tc.customFields === 'string' ? JSON.parse(tc.customFields) : tc.customFields;
          if (Object.keys(fieldsObj).length > 0) {
            customFieldsText += '\n\nCustom Metadata:\n';
            for (const [key, val] of Object.entries(fieldsObj)) {
              if (val && val !== 'N/A') {
                const displayName = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
                customFieldsText += `- ${displayName}: ${val}\n`;
              }
            }
          }
        } catch (_) {}
      }

      const summary = `[${tc.customId || 'TC'}] ${tc.title}`;
      const descText = `Preconditions:\n${tc.preconditions || 'None'}\n\nSteps:\n${tc.steps || ''}\n\nExpected Result:\n${tc.expectedResult || ''}${customFieldsText}`;
      
      const tData = await createJiraIssue(
        cleanHost, 
        authString, 
        cleanProjectKey, 
        parentIssueKey ? standardSubtaskType : standardTaskType, 
        summary, 
        descText,
        parentIssueKey || null
      );
      
      if (tData.key) {
        createdIssues.push({ id: tData.id, key: tData.key, self: tData.self });
        if (parentIssueKey && !standardSubtaskType.toLowerCase().includes('sub')) {
          await linkJiraIssues(cleanHost, authString, tData.key, parentIssueKey, 'Relates');
        }
      } else {
        console.warn(`[Jira Upload] Failed to create standard issue for testcase: ${tc.title}`);
      }
    }

    res.json({ success: true, issues: createdIssues });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to upload test cases directly to Jira Cloud' });
  }
});

// POST Test Jira Connection credentials
app.post('/api/jira/test-connection', async (req, res) => {
  try {
    const { host, email, token } = req.body;
    if (!host || !email || !token) {
      return res.status(400).json({ success: false, error: 'Host URL, email, and API token are all required.' });
    }

    let cleanHost = host.replace(/^https?:\/\//i, '').trim().split('/')[0];
    if (token === 'mock' || host === 'mock' || cleanHost === 'mock') {
      return res.json({ success: true, message: 'Mock Sandbox Connection Successful!' });
    }

    const authString = Buffer.from(`${email}:${token}`).toString('base64');
    
    const response = await fetch(`https://${cleanHost}/rest/api/3/myself`, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const userData = await response.json();
      return res.json({ success: true, displayName: userData.displayName, emailAddress: userData.emailAddress });
    } else {
      let errDetail = 'Invalid credentials';
      const rawText = await response.text();
      try {
        const errJson = JSON.parse(rawText);
        errDetail = errJson.errorMessages?.join(', ') || errDetail;
      } catch (_) {
        errDetail = rawText ? (rawText.length > 200 ? rawText.substring(0, 200) + '...' : rawText) : errDetail;
      }
      return res.status(response.status).json({ success: false, error: `Authentication failed (Status ${response.status}): ${errDetail}` });
    }
  } catch (error) {
    console.error('[Jira Connection Test Error]:', error);
    return res.status(500).json({ success: false, error: `Connection failed: ${error.message}` });
  }
});

function normalizeAdoOrgUrl(inputUrl) {
  let url = inputUrl.trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'dev.azure.com') {
      const paths = parsed.pathname.split('/').filter(Boolean);
      if (paths.length > 0) {
        return `https://dev.azure.com/${paths[0]}`;
      }
    } else if (parsed.hostname.endsWith('.visualstudio.com')) {
      return `https://${parsed.hostname}`;
    }
  } catch (_) {}
  return url;
}

// POST Test ADO Connection
app.post('/api/ado/test-connection', async (req, res) => {
  try {
    let { orgUrl, project, pat } = req.body;
    if (!orgUrl || !project || !pat) {
      return res.status(400).json({ success: false, error: 'Organization URL, Project, and PAT are required.' });
    }

    orgUrl = normalizeAdoOrgUrl(orgUrl);

    if (pat === 'mock' || project === 'mock') {
      return res.json({ success: true, message: 'Mock Sandbox ADO Connection Successful!' });
    }

    const authString = Buffer.from(`:${pat}`).toString('base64');
    
    const response = await fetch(`${orgUrl}/_apis/projects/${encodeURIComponent(project)}?api-version=7.0`, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const projectData = await response.json();
      return res.json({ success: true, projectName: projectData.name, message: `Connected to Project: ${projectData.name}` });
    } else {
      let errDetail = 'Invalid credentials or project key';
      const rawText = await response.text();
      try {
        const errJson = JSON.parse(rawText);
        errDetail = errJson.message || errDetail;
      } catch (_) {
        errDetail = rawText ? (rawText.length > 200 ? rawText.substring(0, 200) + '...' : rawText) : errDetail;
      }
      return res.status(response.status).json({ success: false, error: `Authentication failed (Status ${response.status}): ${errDetail}` });
    }
  } catch (error) {
    console.error('[ADO Connection Test Error]:', error);
    return res.status(500).json({ success: false, error: `Connection failed: ${error.message}` });
  }
});

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function parseStepsToXml(stepsText, expectedResultText) {
  const stepsLinesRaw = stepsText ? stepsText.split('\n').map(l => l.trim()).filter(Boolean) : [];
  const expectedLinesRaw = expectedResultText ? expectedResultText.split('\n').map(l => l.trim()).filter(Boolean) : [];
  
  const steps = [];
  for (const line of stepsLinesRaw) {
    const clean = line.replace(/^([-\*\u2022]\s*|\d+[\.\-\s]*)/, '').trim();
    if (clean) {
      steps.push(clean);
    }
  }

  const expected = [];
  for (const line of expectedLinesRaw) {
    const clean = line.replace(/^([-\*\u2022]\s*|\d+[\.\-\s]*)/, '').trim();
    if (clean) {
      expected.push(clean);
    }
  }

  let xml = `<steps id="0" last="${Math.max(1, steps.length)}">`;
  
  if (steps.length === 0) {
    xml += `<step id="1" type="ActionStep">`;
    xml += `<parameterizedString isformatted="true">Execute test scenario</parameterizedString>`;
    xml += `<parameterizedString isformatted="true">${escapeXml(expectedResultText || 'Expected success')}</parameterizedString>`;
    xml += `<description/></step>`;
  } else {
    for (let i = 0; i < steps.length; i++) {
      const stepId = i + 1;
      const cleanStep = steps[i];
      
      let cleanExpected = 'N/A';
      if (expected[i]) {
        cleanExpected = expected[i];
      } else if (i === steps.length - 1 && expectedResultText) {
        cleanExpected = expectedResultText.replace(/^([-\*\u2022]\s*|\d+[\.\-\s]*)/, '').trim();
      }
      
      xml += `<step id="${stepId}" type="ActionStep">`;
      xml += `<parameterizedString isformatted="true">${escapeXml(cleanStep)}</parameterizedString>`;
      xml += `<parameterizedString isformatted="true">${escapeXml(cleanExpected)}</parameterizedString>`;
      xml += `<description/>`;
      xml += `</step>`;
    }
  }
  
  xml += '</steps>';
  return xml;
}

// POST Push Test Cases to ADO
app.post('/api/ado/upload', async (req, res) => {
  try {
    let { orgUrl, project, pat, testCases } = req.body;
    if (!orgUrl || !project || !pat || !testCases || !testCases.length) {
      return res.status(400).json({ success: false, error: 'Missing required fields for ADO upload.' });
    }

    orgUrl = normalizeAdoOrgUrl(orgUrl);

    if (pat === 'mock') {
      const mockResult = testCases.map((tc, index) => ({
        id: `MOCK-ADO-${1000 + index}`,
        title: tc.title,
        url: `${orgUrl}/${project}/_workitems/edit/${1000 + index}`
      }));
      return res.json({ success: true, createdWorkItems: mockResult });
    }

    const authString = Buffer.from(`:${pat}`).toString('base64');
    const createdWorkItems = [];

    for (const tc of testCases) {
      const xmlSteps = parseStepsToXml(tc.steps, tc.expectedResult);
      
      let customFieldsHtml = '';
      if (tc.customFields) {
        try {
          const fieldsObj = typeof tc.customFields === 'string' ? JSON.parse(tc.customFields) : tc.customFields;
          if (Object.keys(fieldsObj).length > 0) {
            customFieldsHtml += '<hr/><h4><strong>Custom Metadata:</strong></h4><ul>';
            for (const [key, val] of Object.entries(fieldsObj)) {
              if (val && val !== 'N/A') {
                const displayName = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
                customFieldsHtml += `<li><strong>${displayName}:</strong> ${val}</li>`;
              }
            }
            customFieldsHtml += '</ul>';
          }
        } catch (_) {}
      }

      const descriptionHtml = `<div><p><strong>Preconditions:</strong><br/>${(tc.preconditions || 'N/A').replace(/\n/g, '<br/>')}</p>${customFieldsHtml}</div>`;

      const patchPayload = [
        {
          "op": "add",
          "path": "/fields/System.Title",
          "value": `[${tc.type || 'Test'}] ${tc.title || 'QA Test Case'}`
        },
        {
          "op": "add",
          "path": "/fields/System.Description",
          "value": descriptionHtml
        },
        {
          "op": "add",
          "path": "/fields/Microsoft.VSTS.Common.Priority",
          "value": tc.priority === 'High' ? 1 : tc.priority === 'Medium' ? 2 : 3
        },
        {
          "op": "add",
          "path": "/fields/Microsoft.VSTS.TCM.Steps",
          "value": xmlSteps
        }
      ];

      const url = `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/workitems/$Test%20Case?api-version=7.0`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authString}`,
          'Content-Type': 'application/json-patch+json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(patchPayload)
      });

      if (!response.ok) {
        let errText = 'Failed to create work item';
        const rawText = await response.text();
        try {
          const errJson = JSON.parse(rawText);
          errText = errJson.message || errText;
        } catch (_) {
          errText = rawText ? (rawText.length > 200 ? rawText.substring(0, 200) + '...' : rawText) : errText;
        }
        throw new Error(`ADO Creation failed: ${errText}`);
      }

      const resData = await response.json();
      createdWorkItems.push({
        id: resData.id,
        title: tc.title,
        url: resData._links.html.href
      });
    }

    return res.json({ success: true, createdWorkItems });
  } catch (error) {
    console.error('[ADO Upload Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

function makeNumberedList(htmlOrText) {
  if (!htmlOrText) return '';
  const text = htmlOrText.includes('<') && htmlOrText.includes('>') ? htmlToText(htmlOrText) : htmlOrText;
  const lines = parseAndGroupCriteria(text);
  return lines.map((line, idx) => {
    const cleanLine = line.replace(/^([-\*\•\d+\.]|ac\d+[:\.-]?)\s*/i, '').trim();
    return `${idx + 1}. ${cleanLine}`;
  }).join('\n');
}

function parseAndGroupCriteria(text) {
  if (!text) return [];
  const criteriaLines = [];
  let currentItem = '';
  const bulletRegex = /^([-\*\•\d+\.]|ac\d+[:\.-]?)/i;

  const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of rawLines) {
    if (bulletRegex.test(line) || line.toLowerCase().startsWith('ac')) {
      if (currentItem) criteriaLines.push(currentItem);
      currentItem = line;
    } else {
      if (currentItem) {
        currentItem += ' ' + line;
      } else {
        currentItem = line;
      }
    }
  }
  if (currentItem) criteriaLines.push(currentItem);
  return criteriaLines;
}

function htmlToText(html) {
  if (!html) return '';
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li>/gi, '\n- ')
    .replace(/<\/li>/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

app.post('/api/ado/work-item', async (req, res) => {
  try {
    let { orgUrl, pat, workItemId, includeSubTasks } = req.body;
    if (!orgUrl || !pat || !workItemId) {
      return res.status(400).json({ success: false, error: 'Missing required fields (orgUrl, pat, workItemId).' });
    }

    orgUrl = normalizeAdoOrgUrl(orgUrl);
    const ids = Array.isArray(workItemId) ? workItemId : [workItemId];

    if (pat === 'mock') {
      const mockResult = [];
      ids.forEach(id => {
        mockResult.push({
          id,
          title: `Verify transaction processing workflow under heavy checkout volume for ID ${id}`,
          description: htmlToText(`<p>Provide users with instant payment status notifications for ID ${id}.<br/>Ensure order validation occurs instantly on submit.</p>`),
          acceptanceCriteria: makeNumberedList(`<ul><li>AC1: Process transaction within 2 seconds.</li><li>AC2: Trigger fallback retry on gateway timeout.</li></ul>`)
        });
        if (includeSubTasks) {
          mockResult.push({
            id: `${id}-child-1`,
            title: `(Sub-task of ${id}) Validation of transaction payment payload formatting`,
            description: `Check payload signature matches transaction ID ${id} before invoking third-party payments provider gateway service.`,
            acceptanceCriteria: makeNumberedList(`1. Field 'transactionId' must be present in payment header.`)
          });
          mockResult.push({
            id: `${id}-child-2`,
            title: `(Sub-task of ${id}) Re-route to retry fallback queue on transaction errors`,
            description: `Verify that failures on transaction gateway redirect the payment routing to failover checkout queues.`,
            acceptanceCriteria: makeNumberedList(`1. Re-route triggered on gateway code 504 timeout.`)
          });
        }
      });
      return res.json({ success: true, workItems: mockResult });
    }

    const authString = Buffer.from(`:${pat}`).toString('base64');
    const fetchedItems = [];

    // Fetch details for all IDs concurrently using Promise.all
    await Promise.all(ids.map(async (id) => {
      try {
        const url = `${orgUrl}/_apis/wit/workitems/${id}?api-version=7.0${includeSubTasks ? '&$expand=relations' : ''}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${authString}`,
            'Accept': 'application/json'
          }
        });

        if (response.ok) {
          const resData = await response.json();
          const fields = resData.fields || {};
          fetchedItems.push({
            id,
            title: fields['System.Title'] || '',
            description: htmlToText(fields['System.Description'] || fields['System.InfoTip'] || ''),
            acceptanceCriteria: makeNumberedList(fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '')
          });

          // Fetch child items if includeSubTasks is enabled
          if (includeSubTasks && resData.relations && resData.relations.length > 0) {
            const childRelations = resData.relations.filter(rel => rel.rel === 'System.LinkTypes.Hierarchy-Forward');
            const childIds = childRelations.map(rel => {
              const urlStr = rel.url || '';
              return urlStr.substring(urlStr.lastIndexOf('/') + 1);
            }).filter(Boolean);

            if (childIds.length > 0) {
              await Promise.all(childIds.map(async (childId) => {
                try {
                  const childUrl = `${orgUrl}/_apis/wit/workitems/${childId}?api-version=7.0`;
                  const childRes = await fetch(childUrl, {
                    method: 'GET',
                    headers: {
                      'Authorization': `Basic ${authString}`,
                      'Accept': 'application/json'
                    }
                  });
                  if (childRes.ok) {
                    const childData = await childRes.json();
                    const childFields = childData.fields || {};
                    fetchedItems.push({
                      id: childId,
                      title: `(Sub-task of ${id}) ${childFields['System.Title'] || ''}`,
                      description: htmlToText(childFields['System.Description'] || childFields['System.InfoTip'] || ''),
                      acceptanceCriteria: makeNumberedList(childFields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '')
                    });
                  }
                } catch (childErr) {
                  console.error(`Error fetching child work item ${childId} of parent ${id}:`, childErr.message);
                }
              }));
            }
          }
        } else {
          console.error(`Failed to fetch work item ${id}: Status ${response.status}`);
        }
      } catch (err) {
        console.error(`Error fetching work item ${id}:`, err.message);
      }
    }));

    if (fetchedItems.length === 0) {
      throw new Error('No valid work items could be fetched from Azure DevOps.');
    }

    // Sort parent items to match the request order (child items append after parents)
    fetchedItems.sort((a, b) => {
      const aParent = ids.includes(a.id);
      const bParent = ids.includes(b.id);
      if (aParent && !bParent) return -1;
      if (!aParent && bParent) return 1;
      return 0;
    });

    return res.json({
      success: true,
      workItems: fetchedItems
    });
  } catch (error) {
    console.error('[ADO Fetch Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

function extractAcceptanceCriteria(description) {
  if (!description) return '';
  const lower = description.toLowerCase();
  const markers = ["acceptance criteria:", "acceptance criteria", "acceptance criterion:", "acceptance criterion", "acs:", "ac:"];
  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) {
      return description.substring(idx + marker.length).trim();
    }
  }
  return '';
}

app.post('/api/jira/issue', async (req, res) => {
  try {
    let { jiraHost, jiraEmail, jiraToken, issueKey, includeSubTasks } = req.body;
    if (!jiraHost || !jiraEmail || !jiraToken || !issueKey) {
      return res.status(400).json({ success: false, error: 'Missing required fields (jiraHost, jiraEmail, jiraToken, issueKey).' });
    }

    if (!jiraHost.startsWith('http://') && !jiraHost.startsWith('https://')) {
      jiraHost = `https://${jiraHost}`;
    }

    const keys = Array.isArray(issueKey) ? issueKey : [issueKey];

    if (jiraToken === 'mock') {
      const mockResult = [];
      keys.forEach(key => {
        mockResult.push({
          key,
          summary: `Verify user verification workflow for issue ${key}`,
          description: `This is a mock description of Jira issue ${key}.\nIt covers transaction tracking.`,
          acceptanceCriteria: `1. Verification link sent to email.\n2. Expiry duration is 24 hours.`
        });
        if (includeSubTasks) {
          mockResult.push({
            key: `${key}-sub-1`,
            summary: `(Sub-task of ${key}) Email template validation for verification flow`,
            description: `Verify email markup formatting and dynamic variable parsing for ${key} verify link.`,
            acceptanceCriteria: `1. Email subject must be 'Verify your email address'.`
          });
          mockResult.push({
            key: `${key}-sub-2`,
            summary: `(Sub-task of ${key}) Security token expiry validation checks`,
            description: `Check token database storage validation constraints and verify tokens expire after 24 hours.`,
            acceptanceCriteria: `1. Expired tokens must reject authorization attempts.`
          });
        }
      });
      return res.json({ success: true, issues: mockResult });
    }

    const authString = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
    const fetchedItems = [];

    await Promise.all(keys.map(async (key) => {
      try {
        const url = `${jiraHost}/rest/api/2/issue/${encodeURIComponent(key)}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${authString}`,
            'Accept': 'application/json'
          }
        });

        if (response.ok) {
          const resData = await response.json();
          const fields = resData.fields || {};
          const rawDescription = fields.description || '';
          
          let ac = extractAcceptanceCriteria(rawDescription);
          let desc = rawDescription;
          if (ac) {
            const lowerDesc = rawDescription.toLowerCase();
            const markers = ["acceptance criteria:", "acceptance criteria", "acceptance criterion:", "acceptance criterion", "acs:", "ac:"];
            for (const marker of markers) {
              const idx = lowerDesc.indexOf(marker);
              if (idx !== -1) {
                desc = rawDescription.substring(0, idx).trim();
                break;
              }
            }
          }

          fetchedItems.push({
            key,
            summary: fields.summary || '',
            description: desc,
            acceptanceCriteria: makeNumberedList(ac)
          });

          // Fetch child subtasks if includeSubTasks is enabled
          if (includeSubTasks && fields.subtasks && fields.subtasks.length > 0) {
            await Promise.all(fields.subtasks.map(async (sub) => {
              try {
                const subKey = sub.key;
                const subUrl = `${jiraHost}/rest/api/2/issue/${encodeURIComponent(subKey)}`;
                const subRes = await fetch(subUrl, {
                  method: 'GET',
                  headers: {
                    'Authorization': `Basic ${authString}`,
                    'Accept': 'application/json'
                  }
                });

                if (subRes.ok) {
                  const subData = await subRes.json();
                  const subFields = subData.fields || {};
                  const subRawDesc = subFields.description || '';
                  let subAc = extractAcceptanceCriteria(subRawDesc);
                  let subDesc = subRawDesc;
                  if (subAc) {
                    const lowerSubDesc = subRawDesc.toLowerCase();
                    const markers = ["acceptance criteria:", "acceptance criteria", "acceptance criterion:", "acceptance criterion", "acs:", "ac:"];
                    for (const marker of markers) {
                      const idx = lowerSubDesc.indexOf(marker);
                      if (idx !== -1) {
                        subDesc = subRawDesc.substring(0, idx).trim();
                        break;
                      }
                    }
                  }

                  fetchedItems.push({
                    key: subKey,
                    summary: `(Sub-task of ${key}) ${subFields.summary || ''}`,
                    description: subDesc,
                    acceptanceCriteria: makeNumberedList(subAc)
                  });
                }
              } catch (subErr) {
                console.error(`Error fetching sub-task ${sub.key} of parent ${key}:`, subErr.message);
              }
            }));
          }
        } else {
          console.error(`Failed to fetch Jira issue ${key}: Status ${response.status}`);
        }
      } catch (err) {
        console.error(`Error fetching Jira issue ${key}:`, err.message);
      }
    }));

    if (fetchedItems.length === 0) {
      throw new Error('No valid Jira issues could be fetched.');
    }

    // Sort parent keys to match the request order (sub-tasks append after parents)
    fetchedItems.sort((a, b) => {
      const aParent = keys.includes(a.key);
      const bParent = keys.includes(b.key);
      if (aParent && !bParent) return -1;
      if (!aParent && bParent) return 1;
      return 0;
    });

    return res.json({
      success: true,
      issues: fetchedItems
    });
  } catch (error) {
    console.error('[Jira Fetch Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/alm/work-item', async (req, res) => {
  try {
    let { almUrl, almDomain, almProject, almUsername, almPassword, reqId, includeSubTasks } = req.body;
    if (!almUrl || !almDomain || !almProject || !almUsername || !almPassword || !reqId) {
      return res.status(400).json({ success: false, error: 'Missing required fields (almUrl, almDomain, almProject, almUsername, almPassword, reqId).' });
    }

    if (!almUrl.startsWith('http://') && !almUrl.startsWith('https://')) {
      almUrl = `https://${almUrl}`;
    }
    if (almUrl.endsWith('/')) {
      almUrl = almUrl.slice(0, -1);
    }

    const ids = Array.isArray(reqId) ? reqId : [reqId];

    if (almPassword === 'mock') {
      const mockResult = [];
      ids.forEach(id => {
        mockResult.push({
          id,
          title: `Verify user profile fields management requirements for ID ${id}`,
          description: `This is a mock description of ALM Requirement ID ${id}.\nIt covers boundary condition verification for text fields.`,
          acceptanceCriteria: makeNumberedList(`- AC1: Name fields must reject scripts.\n- AC2: Save states to local profile DB.`)
        });
        if (includeSubTasks) {
          mockResult.push({
            key: `${id}-sub-1`,
            id: `${id}-sub-1`,
            title: `(Child of ${id}) Validation of transaction payment payload formatting`,
            description: `Check payload signature matches transaction ID ${id} before invoking gateway.`,
            acceptanceCriteria: makeNumberedList(`1. Field 'transactionId' must be present in payment header.`)
          });
          mockResult.push({
            key: `${id}-sub-2`,
            id: `${id}-sub-2`,
            title: `(Child of ${id}) Re-route to retry fallback queue on transaction errors`,
            description: `Verify that failures on transaction gateway redirect the payment routing.`,
            acceptanceCriteria: makeNumberedList(`1. Re-route triggered on gateway code 504 timeout.`)
          });
        }
      });
      return res.json({ success: true, workItems: mockResult });
    }

    // Live ALM API call sequence
    const loginUrl = `${almUrl}/api/authentication/sign-in`;
    const basicAuth = Buffer.from(`${almUsername}:${almPassword}`).toString('base64');
    
    const loginResponse = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      }
    });

    if (!loginResponse.ok) {
      throw new Error(`ALM Sign-In failed with status: ${loginResponse.status}`);
    }

    const setCookieHeader = loginResponse.headers.get('set-cookie');
    const cookies = setCookieHeader ? setCookieHeader.split(',').map(c => c.split(';')[0]).join('; ') : '';

    const fetchedItems = [];

    const getFieldValue = (fieldsArray, fieldName) => {
      const field = (fieldsArray || []).find(f => f.Name === fieldName || f.name === fieldName);
      if (field && field.values && field.values.length > 0) {
        return field.values[0].value || '';
      }
      return '';
    };

    await Promise.all(ids.map(async (id) => {
      try {
        const reqUrl = `${almUrl}/rest/domains/${almDomain}/projects/${almProject}/requirements/${id}`;
        const reqResponse = await fetch(reqUrl, {
          method: 'GET',
          headers: {
            'Cookie': cookies,
            'Accept': 'application/json'
          }
        });

        if (reqResponse.ok) {
          const reqData = await reqResponse.json();
          const fields = reqData.Fields || reqData.fields || [];
          const name = getFieldValue(fields, 'name');
          const descriptionHtml = getFieldValue(fields, 'description');
          const description = htmlToText(descriptionHtml);
          const ac = extractAcceptanceCriteria(description) || htmlToText(getFieldValue(fields, 'comments') || '');

          fetchedItems.push({
            id,
            title: name,
            description: ac ? description.replace(ac, '').trim() : description,
            acceptanceCriteria: makeNumberedList(ac)
          });

          if (includeSubTasks) {
            const queryUrl = `${almUrl}/rest/domains/${almDomain}/projects/${almProject}/requirements?query={parent-id[${id}]}`;
            const childQueryResponse = await fetch(queryUrl, {
              method: 'GET',
              headers: {
                'Cookie': cookies,
                'Accept': 'application/json'
              }
            });

            if (childQueryResponse.ok) {
              const childQueryData = await childQueryResponse.json();
              const childReqs = childQueryData.entities || childQueryData.Requirements || [];
              
              await Promise.all(childReqs.map(async (child) => {
                try {
                  const childFields = child.Fields || child.fields || [];
                  const childId = getFieldValue(childFields, 'id') || getFieldValue(childFields, 'req-id');
                  const childName = getFieldValue(childFields, 'name');
                  const childDescHtml = getFieldValue(childFields, 'description');
                  const childDesc = htmlToText(childDescHtml);
                  const childAc = extractAcceptanceCriteria(childDesc) || htmlToText(getFieldValue(childFields, 'comments') || '');

                  fetchedItems.push({
                    id: childId,
                    title: `(Child of ${id}) ${childName}`,
                    description: childAc ? childDesc.replace(childAc, '').trim() : childDesc,
                    acceptanceCriteria: makeNumberedList(childAc)
                  });
                } catch (childErr) {
                  console.error(`Error parsing child requirement:`, childErr.message);
                }
              }));
            }
          }
        } else {
          console.error(`Failed to fetch ALM requirement ${id}: Status ${reqResponse.status}`);
        }
      } catch (err) {
        console.error(`Error fetching ALM requirement ${id}:`, err.message);
      }
    }));

    try {
      await fetch(`${almUrl}/api/authentication/sign-out`, {
        method: 'POST',
        headers: { 'Cookie': cookies }
      });
    } catch (_) {}

    if (fetchedItems.length === 0) {
      throw new Error('No valid ALM requirements could be fetched.');
    }

    fetchedItems.sort((a, b) => {
      const aParent = ids.includes(a.id);
      const bParent = ids.includes(b.id);
      if (aParent && !bParent) return -1;
      if (!aParent && bParent) return 1;
      return 0;
    });

    return res.json({
      success: true,
      workItems: fetchedItems
    });
  } catch (error) {
    console.error('[ALM Fetch Error]:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET registered QA Skills
app.get('/api/qa-agents/skills', async (req, res) => {
  try {
    const skills = [
      {
        id: 'qa-security-auditor',
        name: 'Security & Penetration Auditor',
        icon: '🛡️',
        description: 'OWASP Top 10, IDOR, SQLi, XSS, token expiry, and unauthorized privilege escalation audit.',
        focus: 'Security & Auth Vulnerabilities'
      },
      {
        id: 'qa-boundary-analyzer',
        name: 'Boundary & Edge Analyzer',
        icon: '📐',
        description: 'Boundary Value Analysis (BVA), extreme values, unicode/special char payload fuzzing.',
        focus: 'Boundaries & Robustness'
      },
      {
        id: 'qa-automation-engineer',
        name: 'Automation Test Engineer',
        icon: '⚙️',
        description: 'Playwright & Cypress TypeScript end-to-end test automation and Page Object Models.',
        focus: 'E2E Code Generation'
      },
      {
        id: 'qa-performance-specialist',
        name: 'Performance & SLA Specialist',
        icon: '⚡',
        description: 'Latency SLAs (p95/p99), concurrency load spikes, and database pool contention.',
        focus: 'Performance & Stress'
      },
      {
        id: 'qa-test-architect',
        name: 'QA Test Architect',
        icon: '🏗️',
        description: 'Requirement Traceability Matrix (RTM), risk scoring, and test pyramid architecture.',
        focus: 'Architecture & Coverage'
      },
      {
        id: 'qa-defect-triager',
        name: 'Defect & Failure Triager',
        icon: '🐛',
        description: 'Jira bug reports, regression hazard isolation, and reproduction step synthesis.',
        focus: 'Defect Analysis'
      },
      {
        id: 'qa-swarm-orchestrator',
        name: '360° QA Swarm Orchestrator',
        icon: '🚀',
        description: 'Concurrent multi-agent swarm synthesis combining all 6 disciplines into a 360° audit.',
        focus: 'Multi-Agent Swarm'
      }
    ];
    res.json({ success: true, skills });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST Multi-Agent QA Swarm Audit
app.post('/api/qa-agents/swarm-audit', async (req, res) => {
  try {
    const { storyId, userStory, acceptanceCriteria, format = 'Default' } = req.body;
    let storyTitle = 'Active Feature Requirements';
    let storyDesc = userStory || '';
    let acText = acceptanceCriteria || '';

    if (storyId) {
      const story = await prisma.userStory.findUnique({
        where: { id: storyId },
        include: { acceptanceCriteria: true, testCases: true }
      });
      if (story) {
        storyTitle = story.title;
        storyDesc = story.description || storyDesc;
        acText = story.acceptanceCriteria.map(a => a.content).join('\n') || acText;
      }
    }

    if (!storyDesc && !acText) {
      storyDesc = 'Verify comprehensive user authentication, data transactions, and UI workflows.';
      acText = '1. Proper input validation and authorization\n2. Low latency and reliable error recovery';
    }

    const swarmResult = await runMultiAgentSwarmAudit(storyTitle, storyDesc, acText, format);
    res.json({
      success: true,
      ...swarmResult
    });
  } catch (err) {
    console.error('[Swarm Audit Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Backend server (SQL) running on http://localhost:${PORT}`);
});
