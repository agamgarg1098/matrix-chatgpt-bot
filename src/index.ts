import { OpenAI } from 'openai';
import Keyv from 'keyv';
import { KeyvFile } from 'keyv-file';
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

let storage: IStorageProvider;
if (KEYV_BOT_STORAGE) {
  storage = new KeyvStorageProvider('chatgpt-bot-storage');
} else {
  storage = new SimpleFsStorageProvider(path.join(DATA_PATH, "bot.json"));
}

let cryptoStore: ICryptoStorageProvider;
if (MATRIX_ENCRYPTION) cryptoStore = new RustSdkCryptoStorageProvider(path.join(DATA_PATH, "encrypted"));

let cacheOptions;
if (KEYV_BACKEND === 'file') {
  cacheOptions = { store: new KeyvFile({ filename: path.join(DATA_PATH, `chatgpt-bot-api.json`) }) };
} else {
  cacheOptions = { uri: KEYV_URL };
}

const openai = new OpenAI({
  apiKey: OPENAI_ASSISTANT_API_KEY, 
});

async function createAssistantThread(conversationId: string, userMessage: string) {
  try {
    const systemMessage = "You are a helpful assistant. Use your tools like the code interpreter, file search, and function calling to assist the user with their requests.";
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo', 
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 150,
      temperature: CHATGPT_TEMPERATURE,
      user: conversationId,
    });

    LogService.info("Thread ID:", conversationId);
    LogService.info("Assistant's response:", response.choices[0].message.content);

    return response.choices[0].message.content || "Sorry, I couldn't generate a response.";
  } catch (error) {
    LogService.error("Assistant API", `Error calling Assistant API: ${error.message}`);
    return "Sorry, there was an error while communicating with the assistant.";
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

  const client: MatrixClient = new MatrixClient(MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, storage, cryptoStore);

  const clientOptions = {
    modelOptions: {
      model: CHATGPT_API_MODEL,
      temperature: CHATGPT_TEMPERATURE,
    },
    promptPrefix: wrapPrompt(CHATGPT_PROMPT_PREFIX),
    debug: false,
    azure: OPENAI_AZURE,
    reverseProxyUrl: CHATGPT_REVERSE_PROXY,
    maxContextTokens: CHATGPT_MAX_CONTEXT_TOKENS,
    maxPromptTokens: CHATGPT_MAX_PROMPT_TOKENS
  };

  if (MATRIX_AUTOJOIN) AutojoinRoomsMixin.setupOnClient(client);

  client.on("room.failed_decryption", async (roomId, event, error) => {
    LogService.error("index", `Failed decryption event!\n${{ roomId, event, error }}`);
    await client.sendText(roomId, `Room key error. I will leave the room, please reinvite me!`);
    try {
      await client.leaveRoom(roomId);
    } catch (e) {
      LogService.error("index", `Failed to leave room ${roomId} after failed decryption!`);
    }
  });

  client.on("room.join", async (roomId: string, _event: any) => {
    LogService.info("index", `Bot joined room ${roomId}`);
    if (MATRIX_WELCOME) {
      await client.sendMessage(roomId, {
        "msgtype": "m.notice",
        "body": `👋 Hello, I'm ChatGPT bot! Matrix E2EE: ${MATRIX_ENCRYPTION}`,
      });
    }
  });

  client.on("room.message", async (roomId, event) => {
    if (event['content'] && event['content']['msgtype'] === 'm.text') {
      const message = event['content']['body'];
      const sender = event['sender'];

      if (sender === MATRIX_BOT_USERNAME) {
        return; 
      }

      try {
        let responseText;
        let threadId: string | null = null;

        if (CHATGPT_CONTEXT === 'assistant') {
          if (!threadId) {
            threadId = sender;
            LogService.info("New Thread Created:", threadId);
          }

          LogService.info(`Received message from ${sender}: "${message}"`);
          responseText = await createAssistantThread(threadId, message);
        } else {
          const response = await openai.chat.completions.create({
            model: CHATGPT_API_MODEL,
            messages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: message },
            ],
            temperature: CHATGPT_TEMPERATURE,
            max_tokens: CHATGPT_MAX_PROMPT_TOKENS,
          });

          responseText = response.choices[0].message.content;
        }

        if (!responseText) {
          LogService.error("index", "Assistant response is not in the expected format or does not contain text.");
          await client.sendText(roomId, "Sorry, I couldn't get a response from the Assistant.");
          return;
        }

        LogService.info(`Assistant's response for thread ${threadId}: "${responseText}"`);
        await client.sendMessage(roomId, {
          "msgtype": "m.text",
          "body": responseText
        });
      } catch (error) {
        LogService.error("index", `Error while getting response: ${error}`);
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
