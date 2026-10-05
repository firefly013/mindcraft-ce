import fs from 'fs';

interface AnalyzedTask {
    type: unknown;
    goal: unknown;
    conversation: unknown;
    agent_count: unknown;
    blueprint: unknown;
    initial_inventory: unknown;
    [key: string]: unknown;
}

// Read and parse the JSON file
const tasks = JSON.parse(fs.readFileSync('./test_multiagent_construction_tasks.json', 'utf8')) as Record<string, AnalyzedTask>;

// Validate format and count variants
const counts: Record<string, number> = {};
const expectedKeys = ['type', 'goal', 'conversation', 'agent_count', 'blueprint', 'initial_inventory'];

Object.keys(tasks).forEach(taskName => {
    const task = tasks[taskName] as AnalyzedTask;

    // Validate task format
    if (!expectedKeys.every(key => key in task)) {
        console.error(`Invalid task format in ${taskName}`);
        return;
    }

    const category = taskName.split('_variant_')[0] as string;
    counts[category] = (counts[category] ?? 0) + 1;
});

console.log('\nVariants per category:');
Object.entries(counts).forEach(([category, count]) => {
    console.log(`${category}: ${count}`);
});

console.log(`\nTotal tasks: ${Object.keys(tasks).length}`);
console.log(`Total categories: ${Object.keys(counts).length}`);
// const expectedTotal = 5 * 3 * 3* 3
//     * 5; // materialLevels * roomCounts * windowStyles * carpetStyles * variants
// console.log(`Expected total tasks: ${expectedTotal}`);
