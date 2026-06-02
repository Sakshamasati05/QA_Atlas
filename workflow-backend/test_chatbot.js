const run = async () => {
  try {
    console.log("Attempting to load free-chatbot...");
    const sdk = await import('free-chatbot');
    console.log("Successfully loaded free-chatbot! Keys:", Object.keys(sdk));
    
    try {
      console.log("Sending query to DuckDuckGo...");
      const ddg = sdk.createDuckDuckGoChat();
      const res1 = await ddg.chat("Hello, reply with exactly the word 'SUCCESS'");
      console.log("DuckDuckGo response:", res1);
    } catch (e) {
      console.error("DuckDuckGo error:", e.message);
    }

    try {
      console.log("Sending query to Blackbox...");
      const blackbox = sdk.createBlackboxChat();
      const res2 = await blackbox.chat("Hello, reply with exactly the word 'SUCCESS'");
      console.log("Blackbox response:", res2);
    } catch (e) {
      console.error("Blackbox error:", e.message);
    }
  } catch (err) {
    console.error("Error running test:", err);
  }
};
run();
