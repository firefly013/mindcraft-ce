import * as Mindcraft from '../mindcraft/mindcraft.js';
import settings from '../../settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

interface InitMindcraftArgs {
    mindserver_port: number;
}

function parseArguments(): InitMindcraftArgs {
    const parsed = yargs(hideBin(process.argv))
        .option('mindserver_port', {
            type: 'number',
            describe: 'Mindserver port',
            default: Number(settings.mindserver_port)
        })
        .help()
        .alias('help', 'h')
        .parseSync();
    return {
        mindserver_port: parsed.mindserver_port ?? Number(settings.mindserver_port),
    };
}

const args = parseArguments();

settings.mindserver_port = args.mindserver_port;

// Preserve the original call semantics: the legacy JS passed the port as the
// first argument (host_public slot), i.e. truthy whenever a port is set,
// while now also forwarding it to the typed `port` parameter.
void Mindcraft.init(Boolean(settings.mindserver_port), settings.mindserver_port);

console.log(`Mindcraft initialized with MindServer at localhost:${settings.mindserver_port}`);
