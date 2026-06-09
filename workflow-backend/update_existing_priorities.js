const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Starting database priorities update script...");
  const testCases = await prisma.testCase.findMany();
  console.log(`Fetched ${testCases.length} total test cases.`);

  let updatedCount = 0;

  for (let idx = 0; idx < testCases.length; idx++) {
    const tc = testCases[idx];
    let priority = 'Medium';

    const type = (tc.type || 'Positive').toLowerCase().trim();
    if (type.includes('security')) {
      priority = 'High';
    } else if (type.includes('positive')) {
      priority = (idx % 2 === 0) ? 'High' : 'Medium';
    } else if (type.includes('negative')) {
      priority = (idx % 3 === 0) ? 'High' : 'Medium';
    } else if (type.includes('edge')) {
      priority = (idx % 3 === 0) ? 'Low' : 'Medium';
    } else if (type.includes('performance')) {
      priority = (idx % 4 === 0) ? 'Low' : 'Medium';
    } else {
      priority = (idx % 2 === 0) ? 'High' : 'Medium';
    }

    // Update test case priority in database
    await prisma.testCase.update({
      where: { id: tc.id },
      data: { priority }
    });
    updatedCount++;
  }

  console.log(`Successfully updated priority for ${updatedCount} test cases in database.`);
}

main()
  .catch(e => {
    console.error("Error updating priorities:", e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
