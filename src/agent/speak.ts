import { exec, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { TTSConfig as gptTTSConfig } from '../models/gpt.js';
import { TTSConfig as geminiTTSConfig } from '../models/gemini.js';

// speak_model 既可以是 'provider/model/voice' 字符串，也可以是 { api, model, voice, url } 对象
export type SpeakModel =
    | string
    | {
        api?: string;
        model?: string;
        voice?: string;
        url?: string;
        [key: string]: unknown;
    };

interface SpeakingItem {
    text: string;
    model: SpeakModel;
    audioData: string | null;
    ready: Promise<unknown>;
    error?: unknown;
}

const speakingQueue: SpeakingItem[] = []; // each item: {text, model, audioData, ready}
let isSpeaking = false;

export function speak(text: string, speak_model?: SpeakModel): void {
    const model: SpeakModel = speak_model || 'system';

    const item: SpeakingItem = { text, model, audioData: null, ready: Promise.resolve() };

    if (model === 'system') {
        // no preprocessing needed
        item.ready = Promise.resolve();
    } else {
    item.ready = fetchRemoteAudio(text, model)
        .then(data => { item.audioData = data as string; })
        .catch((err: unknown) => { item.error = err; });
    }

    speakingQueue.push(item);
    if (!isSpeaking) void processQueue();
}

function fetchRemoteAudio(txt: string, model: SpeakModel): Promise<unknown> {
    function getModelUrl(prov: string | undefined): string | undefined {
        if (prov === 'openai') return gptTTSConfig.baseUrl as string;
        // 原 .js 取 geminiTTSConfig.baseUrl，但该对象并无此字段（运行时为 undefined），保留该行为
        if (prov === 'google') return (geminiTTSConfig as { baseUrl?: string }).baseUrl;
        return 'https://api.openai.com/v1';
    }

    let prov: string | undefined, mdl: string | undefined, voice: string | undefined, url: string | undefined;
    if (typeof model === 'string') {
        [prov, mdl, voice] = model.split('/');
        url = getModelUrl(prov);
    } else {
        prov = model.api;
        mdl = model.model;
        voice = model.voice;
        url = model.url || getModelUrl(prov);
    }

    if (prov === 'openai') {
        return gptTTSConfig.sendAudioRequest(txt, mdl as string, voice as string, url);
    } else if (prov === 'google') {
        return geminiTTSConfig.sendAudioRequest(txt, mdl as string, voice as string, url);
    }
    else {
        throw new Error(`TTS Provider ${prov} is not supported.`);
    }
}

async function processQueue(): Promise<void> {
    isSpeaking = true;
    if (speakingQueue.length === 0) {
        isSpeaking = false;
        return;
    }
    const item = speakingQueue.shift();
    if (!item) {
        isSpeaking = false;
        return;
    }
    const { text: txt, model, audioData } = item;
    void audioData;
    if (txt.trim() === '') {
        isSpeaking = false;
        await processQueue();
        return;
    }

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // wait for preprocessing if needed
    try {
        await item.ready;
        if (item.error) throw item.error;
    } catch (err: unknown) {
        console.error('[TTS] preprocess error', err);
        isSpeaking = false;
        await processQueue();
        return;
    }


if (model === 'system') {
    // Strip markdown formatting and collapse newlines to a single space
    const txtClean = txt
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/`/g, '')
        .replace(/#{1,6}\s*/g, '')
        .replace(/[\r\n]+/g, ' ')
        .trim();

    let cmd: string;

    if (isWin) {
        // Build the PS script as a plain string, escape only PS single-quotes
        const ps = [
            'Add-Type -AssemblyName System.Speech;',
            '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
            '$s.Rate = 2;',
            `$s.Speak('${txtClean.replace(/'/g, "''")}');`,
            '$s.Dispose()'
        ].join(' ');

        // Encode as UTF-16LE Base64 — bypasses ALL cmd.exe quoting entirely
        const b64 = Buffer.from(ps, 'utf16le').toString('base64');
        cmd = `powershell -NoProfile -EncodedCommand ${b64}`;

    } else if (isMac) {
        cmd = `say "${txtClean.replace(/"/g, '\\"')}"`;
    } else {
        cmd = `espeak "${txtClean.replace(/"/g, '\\"')}"`;
    }

    exec(cmd, err => {
        if (err) console.error('TTS error', err);
        isSpeaking = false;
        void processQueue();
    });
}
    else {
        // audioData was already fetched in speak()
        const audioData = item.audioData;

        if (!audioData) {
            console.error('[TTS] No audio data ready');
            isSpeaking = false;
            await processQueue();
            return;
        }

        try {
            if (isWin) {
                const tmpPath = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
                await fs.writeFile(tmpPath, Buffer.from(audioData, 'base64'));

                const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', tmpPath], {
                    stdio: 'ignore', windowsHide: true
                });
                player.on('error', async (err) => {
                    console.error('[TTS] ffplay error', err);
                    try { await fs.unlink(tmpPath); } catch { /* tmp file may already be gone */ }
                    isSpeaking = false;
                    await processQueue();
                });
                player.on('exit', async () => {
                    try { await fs.unlink(tmpPath); } catch { /* tmp file may already be gone */ }
                    isSpeaking = false;
                    await processQueue();
                });

            } else {
                const player = spawn('ffplay', ['-nodisp','-autoexit','pipe:0'], {
                    stdio: ['pipe','ignore','ignore']
                });
                player.stdin?.write(Buffer.from(audioData, 'base64'));
                player.stdin?.end();
                player.on('exit', () => {
                    isSpeaking = false;
                    void processQueue();
                });
            }
        } catch (e: unknown) {
            console.error('[TTS] Audio error', e);
            isSpeaking = false;
            await processQueue();
        }
    }
}
