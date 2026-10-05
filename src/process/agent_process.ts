import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    name: string;
    port: number | string;
    process?: ChildProcess;
    count_id?: number;
    running?: boolean;

    constructor(name: string, port: number | string) {
        this.name = name;
        this.port = port;
    }

    start(
        load_memory: boolean | string = false,
        init_message: string | null = null,
        count_id = 0,
    ): void {
        this.count_id = count_id;
        this.running = true;

        const args: string[] = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', String(count_id));
        if (load_memory)
            args.push('-l', String(load_memory));
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', String(this.port));

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit', // stdio:inherit 已覆盖 stdout/stderr，原 JS 多余的 stderr 字段被 spawn 忽略
        });

        let last_restart = Date.now();
        agentProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);

            if (code !== null && code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                // agent must run for at least 10 seconds before restarting
                if (Date.now() - last_restart < 10000) {
                    console.error(`Agent process exited too quickly and will not be restarted.`);
                    return;
                }
                console.log('Restarting agent...');
                this.start(true, 'Agent process restarted.', count_id);
                last_restart = Date.now();
            }
        });

        agentProcess.on('error', (err: Error) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop(): void {
        if (!this.running) return;
        this.process?.kill('SIGINT');
    }

    forceRestart(): void {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);

            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                clearTimeout(restartTimeout);
                console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                this.start(true, 'Agent process restarted.', this.count_id ?? 0);
            });
            this.stop(); // sends SIGINT
        } else {
            this.start(true, 'Agent process restarted.', this.count_id ?? 0);
        }
    }
}
