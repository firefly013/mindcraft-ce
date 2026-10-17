#!/usr/bin/env node
/**
 * 由 TypeScript 里的 TypeBox 定义生成 JSON Schema，供编辑器补全与校验。
 *
 * 与 Pi 同一套路（`packages/coding-agent/scripts/generate-schemas.ts`）：
 * schema 是**产物**，真源是 `src/shared/config/schema.ts`。
 * 生成的文件随仓库提交，`npm run generate:schemas` 重新生成。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TSchema } from 'typebox';
import { AUTH_CONFIG_SCHEMA, PROVIDERS_CONFIG_SCHEMA, PROFILE_SCHEMA } from '../src/shared/config/schema.js';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const schemaDraft = 'https://json-schema.org/draft/2020-12/schema';
const generatedComment =
  'This file is generated from TypeScript source. Do not edit it manually; run npm run generate:schemas.';

interface SchemaArtifact {
  filename: `${string}.schema.json`;
  schema: TSchema;
}

const schemaArtifacts: readonly SchemaArtifact[] = [
  { filename: 'providers.schema.json', schema: PROVIDERS_CONFIG_SCHEMA },
  { filename: 'auth.schema.json', schema: AUTH_CONFIG_SCHEMA },
  { filename: 'profile.schema.json', schema: PROFILE_SCHEMA },
];

function serialize(artifact: SchemaArtifact): string {
  return `${JSON.stringify(
    {
      $schema: schemaDraft,
      $id: `./schemas/${artifact.filename}`,
      $comment: generatedComment,
      ...artifact.schema,
    },
    null,
    2,
  )}\n`;
}

for (const artifact of schemaArtifacts) {
  const path = resolve(packageDirectory, 'schemas', artifact.filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialize(artifact), 'utf-8');
  console.log(`Generated schemas/${artifact.filename}`);
}
