import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { ownerContext } from './data.js';
import { executeTool, TOOL_DECLARATIONS } from './tools.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
// `behavior` is a Live-API-only field; plain generateContent rejects it.
const CHAT_TOOLS = [{ functionDeclarations: TOOL_DECLARATIONS.map(({ behavior, ...d }) => d) }];

/** One chat turn: Gemini with the owner tools, up to 8 tool rounds. History is kept by the browser. */
export async function chat(message, history, queries) {
  const ctx = await ownerContext();
  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];
  const used = [];

  for (let round = 0; round < 8; round++) {
    const res = await ai.models.generateContent({
      model: config.geminiChatModel,
      contents,
      config: { systemInstruction: ctx.systemPrompt, tools: CHAT_TOOLS },
    });
    const calls = res.functionCalls ?? [];
    if (!calls.length) return { reply: res.text ?? '', tools: used };

    contents.push(res.candidates?.[0]?.content);
    const parts = [];
    for (const call of calls) {
      used.push(call.name);
      const response = await executeTool(ctx, call.name, call.args ?? {}, queries);
      parts.push({ functionResponse: { name: call.name, response } });
    }
    contents.push({ role: 'user', parts });
  }
  return { reply: 'Sorry, that took too many steps. Could you ask it a bit more specifically?', tools: used };
}
