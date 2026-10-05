// NOTE: the runtime template (bots/lintTemplate.js, read as text by
// src/agent/coder.js) uses `../../../src/...` because generated code is
// written under bots/<name>/action-code/ (three levels deep). This .ts twin
// lives directly under bots/, so its imports use `../src/...` for
// type-checking.
import * as skills from '../src/agent/library/skills.js';
// Imports below are intentionally available for code injected at
// `/* CODE HERE */` by src/agent/coder.js (runtime reads the .js twin as
// text). Unused-import warnings are off repo-wide for this reason.
import * as world from '../src/agent/library/world.js';
import Vec3 from 'vec3';

const log = skills.log;

// eslint-disable-next-line require-await -- injected code may await; the skeleton itself does not
export async function main(bot: any): Promise<void> {
    /* CODE HERE */
    log(bot, 'Code finished.');
}
