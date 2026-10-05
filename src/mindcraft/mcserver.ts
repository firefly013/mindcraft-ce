import net from 'net';
import mc from 'minecraft-protocol';

export interface MCServerInfo {
    host: string;
    port: number;
    name: string;
    ping: number;
    version: string | null;
}

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 */
export function serverInfo(
    ip: string,
    port: number,
    timeout = 1000,
    verbose = false,
): Promise<MCServerInfo | null> {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            if (verbose)
                console.error(`Timeout pinging server ${ip}:${port}`);
            resolve(null); // Resolve as null if no response within timeout
        }, timeout);

        mc.ping({
            host: ip,
            port,
        }, (err: Error | null, response: unknown) => {
            clearTimeout(timeoutId);

            if (err) {
                if (verbose)
                    console.error(`Error pinging server ${ip}:${port}`, err);
                return resolve(null);
            }

            // minecraft-protocol ping results differ across versions; treat as untyped here
            const res = response as {
                version?: { name?: string };
                description?: { text?: string } | string;
                latency?: number;
            };
            // extract version number from modded servers like "Paper 1.21.4"
            const version = res?.version?.name || '';
            const match = String(version).match(/\d+\.\d+(?:\.\d+)?/);
            const numericVersion = match ? match[0] : null;
            if (numericVersion !== version) {
                console.log(`Modded server found (${version}), attempting to use ${numericVersion}...`);
            }

            const description = typeof res.description === 'string'
                ? res.description
                : (res.description?.text || 'No description provided.');

            const info: MCServerInfo = {
                host: ip,
                port,
                name: description,
                ping: res.latency ?? 0,
                version: numericVersion,
            };

            resolve(info);
        });
    });
}

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 */
export async function findServers(
    ip: string,
    earlyExit = false,
    timeout = 100,
): Promise<MCServerInfo[]> {
    const servers: MCServerInfo[] = [];
    const startPort = 49000;
    const endPort = 65000;

    const checkPort = (port: number): Promise<number | null> => {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: ip, port, timeout }, () => {
                socket.end();
                resolve(port); // Port is open
            });

            socket.on('error', () => resolve(null)); // Port is closed
            socket.on('timeout', () => {
                socket.destroy();
                resolve(null);
            });
        });
    };

    // This supresses a lot of annoying console output from the mc library
    // TODO: find a better way to do this, it supresses other useful output
    const originalConsoleLog = console.log;
    console.log = () => { };

    for (let port = startPort; port <= endPort; port++) {
        const openPort = await checkPort(port);
        if (openPort) {
            const server = await serverInfo(ip, port, 200, false);
            if (server) {
                servers.push(server);

                if (earlyExit) break;
            }
        }
    }

    // Restore console output
    console.log = originalConsoleLog;

    return servers;
}

/**
 * Gets the MC server info from the host and port.
 */
export async function getServer(
    host: string,
    port: number,
    version: string,
): Promise<MCServerInfo> {
    let server: MCServerInfo | null = null;
    let serverVersion = '';

    // Search for server
    if (port == -1) {
        console.log(`No port provided. Searching for LAN server on host ${host}...`);

        await findServers(host, true).then((servers) => {
            if (servers.length > 0)
                server = servers[0] ?? null;
        });

        if (server == null)
            throw new Error(`No server found on LAN.`);
    } else {
        server = await serverInfo(host, port, 1000, true);
    }

    // Server not found
    if (server == null)
        throw new Error(`MC server not found. (Host: ${host}, Port: ${port}) Check the host and port in settings.js, and ensure the server is running and open to public or LAN.`);

    const serverString = `(Host: ${server.host}, Port: ${server.port}, Version: ${server.version})`;

    if (version === 'auto')
        serverVersion = server.version ?? '';
    else
        serverVersion = version;
    // Server version unsupported / mismatch
    const isSupported = mc.supportedVersions.some((v: string) =>
        serverVersion === v || (serverVersion.startsWith(v) && serverVersion.charAt(v.length) === '.'),
    ); // Checks version or parent version (e.g. if 1.7 is supported then 1.7.2 will be allowed)
    if (!isSupported)
        throw new Error(`MC server was found ${serverString}, but version is unsupported. Supported versions are: ${mc.supportedVersions.join(', ')}.`);
    else if (version !== 'auto' && server.version !== version)
        throw new Error(`MC server was found ${serverString}, but version is incorrect. Expected ${version}, but found ${server.version}. Check the server version in settings.js.`);
    else
        console.log(`MC server found. ${serverString}`);

    return server;
}
