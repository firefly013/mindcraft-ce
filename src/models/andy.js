import { hasKey, getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class Andy {
    static prefix = 'andy';

    constructor(model_name, url, params) {
        this.model_name = model_name || 'auto';
        this.params = params;
        this.base_url = url || 'https://andy.mindcraft-ce.com';
        this.chat_endpoint = '/api/v1/chat/completions';
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name || 'auto';
        let messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));

        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting Andy API response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                const data = await this.send(this.chat_endpoint, {
                    model,
                    messages,
                    stream: false,
                    ...(this.params || {})
                });
                if (data?.choices?.[0]?.message?.content) {
                    res = data.choices[0].message.content;
                } else {
                    res = 'No response data.';
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                } else {
                    console.log(err);
                    res = 'My brain disconnected, try again.';
                }
            }

            const hasOpenTag = res.includes('<think>');
            const hasCloseTag = res.includes('</think>');

            if (hasOpenTag && !hasCloseTag) {
                console.warn('Partial <think> block detected. Re-generating...');
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn('Could not get a valid response after max attempts.');
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    /**
     * OpenAI 原生工具调用（OpenAI 兼容网关）：把 !Command 转换后的 tools
     * 透传给 chat/completions，返回 { text, tool_calls: [{ id, name, args }] }。
     * 调用方用 executeToolCall 执行。不支持时抛错，由上层回落到文本 !Command。
     */
    async sendRequestWithTools(turns, systemMessage, tools, tool_choice = 'auto') {
        const model = this.model_name || 'auto';
        const messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        console.log(`Awaiting Andy tool response... (model: ${model})`);
        const data = await this.send(this.chat_endpoint, {
            model,
            messages,
            tools,
            tool_choice,
            stream: false,
            ...(this.params || {})
        });
        const msg = data?.choices?.[0]?.message ?? {};
        let tool_calls = [];
        try {
            tool_calls = (msg.tool_calls || []).map((tc) => {
                let args = {};
                try { args = JSON.parse(tc.function?.arguments ?? '{}') ?? {}; }
                catch { args = {}; }
                return { id: tc.id, name: tc.function?.name ?? '', args };
            });
        } catch {
            tool_calls = [];
        }
        return { text: msg.content ?? '', tool_calls };
    }



    async send(endpoint, body) {
        const url = new URL(endpoint, this.base_url);
        const headers = { 'Content-Type': 'application/json' };
        const apiKey = hasKey('ANDY_API_KEY') ? getKey('ANDY_API_KEY') : null;
        if (apiKey && apiKey !== 'optional') {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        const request = new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        const res = await fetch(request);
        if (!res.ok) {
            throw new Error(`Andy API status: ${res.status}`);
        }
        return await res.json();
    }
}
