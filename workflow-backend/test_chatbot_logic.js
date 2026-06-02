const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

// Initialize prisma to avoid crashing if server.js imports it
const prisma = new PrismaClient();

// Re-import generateDynamicMockChatResponse from server.js dynamically
const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// Create a wrapper of the functions we want to test
const testEnv = {
  prisma,
  console,
  Math,
  Date,
  process
};

const extractionRegex = /const MOCK_FEATURE_TESTS =[\s\S]*?async function generateDynamicMockChatResponse[\s\S]*?\n\}/;
const match = serverCode.match(extractionRegex);

if (!match) {
  console.error("Could not extract mock responder code from server.js!");
  process.exit(1);
}

const mapTestCaseRegex = /function mapTestCaseToFormat[\s\S]*?\n\}/;
const mapTestCaseMatch = serverCode.match(mapTestCaseRegex);

if (!mapTestCaseMatch) {
  console.error("Could not extract mapTestCaseToFormat from server.js!");
  process.exit(1);
}

// Create a sandboxed evaluation script
const sandboxScript = `
  const prisma = testEnv.prisma;
  ${mapTestCaseMatch[0]}
  
  // Extract format instructions helper
  function getFormatInstructions(format) {
    if (format === 'LLY TU') {
      return "LLY TU Schema Instructions";
    } else if (format === 'LLY PBPA') {
      return "LLY PBPA Schema Instructions";
    } else if (format === 'DEL') {
      return "DEL Schema Instructions";
    } else {
      return "Default Schema Instructions";
    }
  }

  ${match[0]}
  
  // Export functions to outside
  module.exports = {
    generateDynamicMockChatResponse
  };
`;

// Evaluate sandboxed script
const moduleHolder = { exports: {} };
const fn = new Function('testEnv', 'module', sandboxScript);
fn(testEnv, moduleHolder);

const { generateDynamicMockChatResponse } = moduleHolder.exports;

async function runTests() {
  console.log("=== STARTING CHATBOT LOGIC TESTS ===\n");
  
  let passed = 0;
  let failed = 0;
  
  const testCases = [
    {
      name: "Greeting matching (hi)",
      content: "hi",
      provider: "claude",
      format: "Default",
      check: (res) => res.includes("I'm your **Claude Opus 4.8** QA assistant") || res.includes("Hey there")
    },
    {
      name: "Download/Jira keyword priority check",
      content: "how can i download these test cases",
      provider: "gemini",
      format: "Default",
      check: (res) => res.includes("export and download") && res.includes("Jira Export")
    },
    {
      name: "Connect guide check",
      content: "how to connect API keys",
      provider: "chatgpt",
      format: "Default",
      check: (res) => res.includes("Connect **ChatGPT GPT-5.5** to Live Mode")
    },
    {
      name: "Dynamic feature login check - LLY TU format",
      content: "write test cases for login page",
      provider: "copilot",
      format: "LLY TU",
      check: (res) => res.includes("Valid Login") && res.includes("Path:") && res.includes("Format: **LLY TU**")
    },
    {
      name: "Dynamic feature payment check - DEL format",
      content: "test payment page",
      provider: "gemini",
      format: "DEL",
      check: (res) => res.includes("Payment with valid card details") && res.includes("Test Data:") && res.includes("Format: **DEL**")
    },
    {
      name: "Small talk check",
      content: "how are you today?",
      provider: "claude",
      format: "Default",
      check: (res) => res.includes("doing great")
    }
  ];

  for (const tc of testCases) {
    try {
      const result = await generateDynamicMockChatResponse("test-chat-id", tc.provider, tc.content, false, tc.format);
      
      const success = tc.check(result);
      if (success) {
        console.log(`[PASS] ${tc.name}`);
        passed++;
      } else {
        console.error(`[FAIL] ${tc.name}`);
        console.error(`  Query: "${tc.content}"`);
        console.error(`  Result: "${result.substring(0, 150)}..."`);
        failed++;
      }
    } catch (err) {
      console.error(`[ERROR] ${tc.name} threw exception:`, err.message);
      failed++;
    }
  }

  console.log(`\n=== TEST RESULTS: ${passed} Passed, ${failed} Failed ===`);
  
  // Close prisma connection
  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
