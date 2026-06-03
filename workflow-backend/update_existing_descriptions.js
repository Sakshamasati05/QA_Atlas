const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Starting database description update script...");
  const testCases = await prisma.testCase.findMany();
  console.log(`Fetched ${testCases.length} total test cases.`);

  let updatedCount = 0;

  for (const tc of testCases) {
    let customFieldsObj = {};
    if (tc.customFields) {
      try {
        customFieldsObj = JSON.parse(tc.customFields);
      } catch (e) {
        customFieldsObj = {};
      }
    }

    let needsUpdate = false;

    // Check for LLY TU
    if (tc.format === 'LLY TU') {
      const desc = customFieldsObj.description;
      if (!desc || desc === 'N/A' || desc.trim() === '') {
        customFieldsObj.description = tc.title || 'Verify the scenario.';
        needsUpdate = true;
      }
    } 
    // Check for LLY PBPA
    else if (tc.format === 'LLY PBPA') {
      const desc = customFieldsObj.description;
      const tcDesc = customFieldsObj.testCaseDescription;
      if (!desc || desc === 'N/A' || desc.trim() === '' || !tcDesc || tcDesc === 'N/A' || tcDesc.trim() === '') {
        const fallback = tc.title || 'Verify function.';
        customFieldsObj.description = (desc && desc !== 'N/A' && desc.trim() !== '') ? desc : fallback;
        customFieldsObj.testCaseDescription = (tcDesc && tcDesc !== 'N/A' && tcDesc.trim() !== '') ? tcDesc : fallback;
        needsUpdate = true;
      }
    } 
    // Check for DEL
    else if (tc.format === 'DEL') {
      const desc = customFieldsObj.description;
      if (!desc || desc === 'N/A' || desc.trim() === '') {
        customFieldsObj.description = tc.title || 'Verify the scenario.';
        needsUpdate = true;
      }
    } 
    // Check for Default or general fallback
    else {
      const desc = customFieldsObj.description;
      if (!desc || desc === 'N/A' || desc.trim() === '') {
        customFieldsObj.description = tc.title || 'Verify the scenario.';
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      await prisma.testCase.update({
        where: { id: tc.id },
        data: {
          customFields: JSON.stringify(customFieldsObj)
        }
      });
      updatedCount++;
    }
  }

  console.log(`Successfully updated ${updatedCount} test cases in database.`);
}

main()
  .catch(e => {
    console.error("Error updating descriptions:", e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
