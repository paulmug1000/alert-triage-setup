import Anthropic from "@anthropic-ai/sdk";

async function testAPI() {
  console.log("Testing Anthropic API...");
  console.log("API Key:", process.env.ANTHROPIC_API_KEY ? "✓ Found" : "✗ Not found");
  
  try {
    const client = new Anthropic();
    
    console.log("Attempting to call Claude API...");
    const message = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 100,
      messages: [
        { role: "user", content: "Say 'API is working'" }
      ],
    });
    
    console.log("✓ API call successful!");
    console.log("Response:", message.content[0].text);
  } catch (error) {
    console.error("✗ API call failed!");
    console.error("Error type:", error.constructor.name);
    console.error("Error message:", error.message);
    console.error("Error status:", error.status);
    console.error("Full error:", JSON.stringify(error, null, 2));
  }
}

testAPI();