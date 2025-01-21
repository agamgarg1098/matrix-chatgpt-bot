import { OpenAI } from "openai";
import {
  MatrixAuth, MatrixClient, AutojoinRoomsMixin, LogService, LogLevel, RichConsoleLogger,
  RustSdkCryptoStorageProvider, IStorageProvider, SimpleFsStorageProvider, ICryptoStorageProvider,
} from "matrix-bot-sdk";
import * as path from "path";
import {
  DATA_PATH, KEYV_URL, OPENAI_API_KEY, MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, MATRIX_AUTOJOIN,
  MATRIX_BOT_PASSWORD, MATRIX_BOT_USERNAME, MATRIX_ENCRYPTION, MATRIX_THREADS, CHATGPT_CONTEXT,
  CHATGPT_API_MODEL, KEYV_BOT_STORAGE, KEYV_BACKEND, CHATGPT_PROMPT_PREFIX, MATRIX_WELCOME,
  CHATGPT_REVERSE_PROXY, CHATGPT_TEMPERATURE, CHATGPT_MAX_CONTEXT_TOKENS, CHATGPT_MAX_PROMPT_TOKENS,
  OPENAI_ASSISTANT_API_KEY,
  OPENAI_AZURE,
} from './env.js';
import CommandHandler from "./handlers.js";
import { KeyvStorageProvider } from './storage.js';
import { parseMatrixUsernamePretty, wrapPrompt } from './utils.js';

LogService.setLogger(new RichConsoleLogger());
LogService.setLevel(LogLevel.INFO);

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: OPENAI_ASSISTANT_API_KEY,
});

// Create Assistant
async function createAssistant() {
  try {
    const assistant = await openai.beta.assistants.create({
      name: "Math Tutor",
      instructions: "You are a personal math tutor. Write and run code to answer math questions.",
      tools: [{ type: "code_interpreter" }],
      model: "gpt-4",
    });

    LogService.info("Assistant created:", assistant.id);
    return assistant;
  } catch (error) {
    LogService.error("Error creating assistant:", error);
    throw error;
  }
}

// Create Thread
async function createThread() {
  try {
    const thread = await openai.beta.threads.create();
    LogService.info("Thread created:", thread.id);
    return thread;
  } catch (error) {
    LogService.error("Error creating thread:", error);
    throw error;
  }
}

// Add Message to Thread
async function addMessageToThread(threadId: string, message: string) {
  try {
    const messageResponse = await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message,
    });
    LogService.info("Message added to thread:", messageResponse.id);
    return messageResponse;
  } catch (error) {
    LogService.error("Error adding message to thread:", error);
    throw error;
  }
}

// Create and Poll Thread Run
async function createAndPollThreadRun(threadId: string, assistantId: string) {
  try {
    const run = await openai.beta.threads.runs.createAndPoll(threadId, {
      assistant_id: assistantId,
      instructions: "Please address the user as Jane Doe. The user has a premium account.",
    });

    LogService.info("Run completed:", run);

    // Access the assistant's response from the run result (check the actual response structure)
    const responseText = run.result?.choices?.[0]?.message?.content || "Sorry, I couldn't get a response from the Assistant.";
    return responseText;
  } catch (error) {
    LogService.error("Error running thread:", error);
    throw error;
  }
}

async function main() {
  if (!MATRIX_ACCESS_TOKEN) {
    const botUsernameWithoutDomain = parseMatrixUsernamePretty(MATRIX_BOT_USERNAME);
    const authedClient = await (new MatrixAuth(MATRIX_HOMESERVER_URL)).passwordLogin(botUsernameWithoutDomain, MATRIX_BOT_PASSWORD);
    console.log(authedClient.homeserverUrl + " token: \n" + authedClient.accessToken);
    console.log("Set MATRIX_ACCESS_TOKEN to above token, MATRIX_BOT_PASSWORD can now be blank");
    return;
  }

  if (!MATRIX_THREADS && CHATGPT_CONTEXT !== "room") throw Error("You must set CHATGPT_CONTEXT to 'room' if you set MATRIX_THREADS to false");

  const client: MatrixClient = new MatrixClient(MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN);

  if (MATRIX_AUTOJOIN) AutojoinRoomsMixin.setupOnClient(client);

  // Create Assistant and Thread
  const assistant = await createAssistant();
  let thread = await createThread();

  client.on("room.message", async (roomId, event) => {
    if (event['content'] && event['content']['msgtype'] === 'm.text') {
      const message = event['content']['body'];
      const sender = event['sender'];

      if (sender === MATRIX_BOT_USERNAME) {
        return;
      }

      try {
        // Store thread ID in room context (using setRoomData)
        await client.setRoomData(roomId, 'chatgpt_thread_id', thread.id);

        // Add message to thread
        await addMessageToThread(thread.id, message);

        // Create and poll thread run, then get assistant's response
        const responseText = await createAndPollThreadRun(thread.id, assistant.id);

        // Send assistant's response back to the room
        await client.sendText(roomId, responseText);
      } catch (error) {
        LogService.error("Error while handling message:", error);
        await client.sendText(roomId, "Sorry, I couldn't get a response from the Assistant.");
      }
    }
  });

  const commands = new CommandHandler(client, openai);
  await commands.start();

  LogService.info("index", `Starting bot using ChatGPT model: ${CHATGPT_API_MODEL}`);
  await client.start();
  LogService.info("index", "Bot started!");
}

main();
