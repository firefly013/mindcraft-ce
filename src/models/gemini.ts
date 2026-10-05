import { GoogleGenAI } from '@google/genai';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import type { AIModel, ChatMessage } from '../types/common.js';

interface SafetySetting {
  category: string;
  threshold: string;
}

export class Gemini implements AIModel {
  static prefix = 'google';
  private model_name: string | null;
  private params: Record<string, unknown> | undefined;
  private safetySettings: SafetySetting[];
  private genAI: GoogleGenAI;

  constructor(model_name: string | null, _url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.params = params;
    this.safetySettings = [
      { category: 'HARM_CATEGORY_DANGEROUS', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ];

    this.genAI = new GoogleGenAI({ apiKey: getKey('GEMINI_API_KEY') });
  }

  async sendRequest(turns: ChatMessage[], systemMessage: string): Promise<string> {
    console.log('Awaiting Google API response...');

    const formatted = strictFormat(turns);
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const turn of formatted) {
      contents.push({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      });
    }

    const result = await this.genAI.models.generateContent({
      model: this.model_name || 'gemini-2.5-flash',
      contents: contents as never,
      safetySettings: this.safetySettings as never,
      config: {
        systemInstruction: systemMessage,
        ...(this.params ?? {}),
      },
    } as never);
    const response = (await result.text) as string;

    console.log('Received.');

    return response;
  }

  async sendVisionRequest(
    turns: ChatMessage[],
    systemMessage: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg',
      },
    };

    const formatted = strictFormat(turns);
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
    for (const turn of formatted) {
      contents.push({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      });
    }
    contents.push({
      role: 'user',
      parts: [{ text: 'SYSTEM: Vision response' }, imagePart],
    });

    let res: string | null;
    try {
      console.log('Awaiting Google API vision response...');
      const result = await this.genAI.models.generateContent({
        model: this.model_name || 'gemini-2.5-flash',
        contents: contents as never,
        safetySettings: this.safetySettings as never,
        generationConfig: {
          ...(this.params ?? {}),
        } as never,
        systemInstruction: systemMessage,
      } as never);
      res = (await result.text) as string;
      console.log('Received.');
    } catch (err) {
      console.log(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Image input modality is not enabled for models/')) {
        res = 'Vision is only supported by certain models.';
      } else {
        res = 'An unexpected error occurred, please try again.';
      }
    }
    return res ?? 'An unexpected error occurred, please try again.';
  }
}

export async function sendAudioRequest(
  text: string,
  model: string,
  voice: string,
  _url?: string,
): Promise<string | null> {
  const ai = new GoogleGenAI({ apiKey: getKey('GEMINI_API_KEY') });

  const response = await ai.models.generateContent({
    model: model,
    contents: [{ parts: [{ text: text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  });

  const pcmBase64 = (response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? null) as
    | string
    | null;
  if (!pcmBase64) {
    console.warn('Gemini TTS: no audio data returned');
    return null;
  }

  // Wrap PCM in a minimal WAV container so ffplay can decode it.
  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const wavHeader = createWavHeader(pcmBuffer.length, 24000, 1, 16);
  const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

  const wavBase64 = wavBuffer.toString('base64');
  return wavBase64;
}

// helper: create PCM WAV header
function createWavHeader(
  dataLength: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM
  header.writeUInt16LE(1, 20); // Audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

export const TTSConfig = {
  sendAudioRequest: sendAudioRequest,
};
