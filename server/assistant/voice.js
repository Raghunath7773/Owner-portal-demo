import { FunctionResponseScheduling, GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { ownerContext } from './data.js';
import { VOICE_TOOL_FILLER } from './prompt.js';
import { executeTool, TOOL_DECLARATIONS } from './tools.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
const TURN_COMPLETE = '__TURN_COMPLETE__';

/**
 * Voice on /voice: browser ⇄ this server ⇄ Gemini Live.
 * Browser sends raw PCM16 mono 16 kHz binary frames; gets PCM16 mono 24 kHz binary frames back,
 * plus the text frame "__TURN_COMPLETE__" when Gemini finishes or is interrupted.
 */
export function attachVoice(server, queries) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    // Only pages served from this host may open a voice session (no cross-site use of the key).
    const origin = req.headers.origin && new URL(req.headers.origin).host;
    if (pathname !== '/voice' || (origin && origin !== req.headers.host)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws, queries));
  });
}

async function handle(ws, queries) {
  let session = null;
  let canSendAudio = true;
  const closeBoth = (code = 1000, reason = '') => {
    try { session?.close(); } catch { /* already closed */ }
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };

  try {
    const ctx = await ownerContext();
    session = await ai.live.connect({
      model: config.geminiLiveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.geminiVoice } } },
        systemInstruction: ctx.systemPrompt + VOICE_TOOL_FILLER,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        contextWindowCompression: { slidingWindow: {} },
      },
      callbacks: {
        onmessage: (msg) => {
          for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data && ws.readyState === ws.OPEN) ws.send(Buffer.from(part.inlineData.data, 'base64'));
          }
          if ((msg.serverContent?.interrupted || msg.serverContent?.turnComplete) && ws.readyState === ws.OPEN) {
            ws.send(TURN_COMPLETE);
          }
          if (msg.toolCall) void runTools(msg.toolCall);
        },
        onerror: (e) => console.error('[voice] gemini error:', e?.message ?? e),
        onclose: () => closeBoth(1000, ''),
      },
    });
    if (ws.readyState !== ws.OPEN) return closeBoth(); // owner hung up while we were connecting

    // Gemini speaks first: the greeting also absorbs the session's cold-start, so the owner's
    // first question gets a warm session. The browser opens the mic only once this audio arrives.
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: `Greet ${ctx.ownerName} warmly by first name and ask how you can help. Always reply in the language the owner speaks.` }] }],
      turnComplete: true,
    });

    async function runTools(toolCall) {
      canSendAudio = false; // the owner's audio is held while tools run, as in the ERP voice agent
      try {
        const functionResponses = [];
        for (const fc of toolCall.functionCalls ?? []) {
          const response = await executeTool(ctx, fc.name, fc.args ?? {}, queries);
          functionResponses.push({ id: fc.id, name: fc.name, response, scheduling: FunctionResponseScheduling.WHEN_IDLE });
        }
        session.sendToolResponse({ functionResponses });
      } catch (err) {
        console.error('[voice] tool response failed:', err.message);
      } finally {
        canSendAudio = true;
      }
    }
  } catch (err) {
    console.error('[voice] could not start:', err.message);
    return closeBoth(1011, 'Voice assistant unavailable');
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary || !canSendAudio) return;
    try {
      session.sendRealtimeInput({ audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    } catch (err) {
      console.error('[voice] audio forward failed:', err.message);
    }
  });
  ws.on('close', () => closeBoth());
}
