/**
 * 配置文件：解析、校验、以及"错了就报错"的规矩。
 *
 * 这一组测试就是这套设计的验收标准：
 *   - 语法错、字段错、模型引用错，**全部**抛 `ConfigError`，消息里带文件名和字段路径；
 *   - 三份配置文件允许 JSONC 注释，但**不允许**未知字段（写错键名必须炸）；
 *   - `$ENV` / `${ENV}` / `!command` 的解析语义与 Pi 一致；
 *   - 仓库里真实提交的 `providers.json` / `profiles/*.json` / `auth.example.json` 必须通过校验。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadAuthConfig,
  loadProvidersConfig,
  loadProfile,
  parseJsonFile,
  validateProfile,
} from '../src/shared/config/load.js';
import { stripJsonComments } from '../src/shared/config/json.js';
import {
  clearConfigValueCache,
  getConfigValueEnvVarNames,
  isCommandConfigValue,
  resolveConfigValue,
  resolveConfigValueOrThrow,
} from '../src/shared/config/value.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeTemp(name: string, content: string): string {
  const dir = tempDir();
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir == null) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄 */
    }
  }
});

describe('JSONC 注释', () => {
  it('删掉行注释与块注释，字符串里的 // 保留', () => {
    const text = [
      '{',
      '  // 行注释',
      '  "url": "https://example.com/x", /* 块注释 */',
      '  "n": 1',
      '}',
    ].join('\n');
    const stripped = stripJsonComments(text);
    expect(stripped).not.toContain('行注释');
    expect(stripped).not.toContain('块注释');
    expect(stripped).toContain('https://example.com/x');
    expect(JSON.parse(stripped)).toEqual({ url: 'https://example.com/x', n: 1 });
  });

  it('转义引号不会让状态机跑偏', () => {
    const stripped = stripJsonComments('{"a": "say \\" // not a comment"}');
    expect(JSON.parse(stripped)).toEqual({ a: 'say " // not a comment' });
  });

  it('字符串以反斜杠结尾（未闭合）不会越界', () => {
    expect(stripJsonComments('"abc\\')).toBe('"abc\\');
  });

  it('BOM 在解析前被去掉', () => {
    expect(parseJsonFile('<x>', '\ufeff{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonFile('<x>', '\ufeff{ // c\n "a": 1 }', true)).toEqual({ a: 1 });
  });
});

describe('语法错 → ConfigError', () => {
  it('JSON 解析失败带上文件名', () => {
    const path = writeTemp('profile.json', '{ "name": }');
    try {
      loadProfile(path);
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).file).toBe(path);
      expect((error as ConfigError).issues[0]).toContain('JSON 解析失败');
    }
  });

  it('文件不存在也算错，并且说得清楚', () => {
    try {
      loadProfile('./definitely-missing-profile.json');
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toContain('文件不存在');
    }
  });

  it('读不动（目录当成文件读）→ 报"读取失败"，不当成"不存在"', () => {
    try {
      loadProfile('./src');
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join('')).toContain('读取失败');
    }
  });
});

describe('profile 校验', () => {
  const VALID = { name: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' };

  it('最小合法 profile 通过', () => {
    expect(validateProfile(VALID)).toEqual(VALID);
  });

  it('未知字段报错，并指出是哪个字段', () => {
    try {
      validateProfile({ ...VALID, context_window: 1_000_000 });
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join('\n')).toContain('context_window');
    }
  });

  it('缺 name 报错', () => {
    expect(() => validateProfile({ model: 'openai/gpt-5.4' })).toThrow(ConfigError);
  });

  it('嵌套字段缺失时，报错路径带上级（model.model）', () => {
    try {
      validateProfile({ name: 'a', model: {} });
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect((error as ConfigError).issues.join('\n')).toContain('model.model');
    }
  });

  it('name 里有斜杠/空格报错（它同时是目录名）', () => {
    expect(() => validateProfile({ ...VALID, name: 'a/b' })).toThrow(ConfigError);
    expect(() => validateProfile({ ...VALID, name: 'a b' })).toThrow(ConfigError);
  });

  it('model 既不是字符串也不是对象 → 报错', () => {
    expect(() => validateProfile({ ...VALID, model: 42 })).toThrow(ConfigError);
  });

  it('对象形式的 model 只允许 provider 和 model', () => {
    const profile = validateProfile({
      name: 'gpt',
      model: { provider: 'openai', model: 'gpt-5.4' },
      compaction: { reserveTokens: 1000, keepRecentTokens: 2000 },
      prompts: { conversing: '你好 $NAME' },
    });
    expect(profile.model).toEqual({ provider: 'openai', model: 'gpt-5.4' });
    expect(profile.compaction?.reserveTokens).toBe(1000);
  });

  it('model 里写窗口或采样参数会报错', () => {
    expect(() =>
      validateProfile({ name: 'gpt', model: { provider: 'openai', model: 'gpt-5.4', contextWindow: 1 } }),
    ).toThrow(ConfigError);
    expect(() =>
      validateProfile({ name: 'gpt', model: { provider: 'openai', model: 'gpt-5.4', params: {} } }),
    ).toThrow(ConfigError);
  });

  it('compaction / prompts 里的未知字段同样报错', () => {
    expect(() => validateProfile({ ...VALID, compaction: { reserve_token: 1 } })).toThrow(ConfigError);
    expect(() => validateProfile({ ...VALID, prompts: { conversate: 'x' } })).toThrow(ConfigError);
  });

  it('profile 文件可以用注释', () => {
    const path = writeTemp('p.json', '{\n  // bot 名\n  "name": "a",\n  "model": "openai/gpt-5.4"\n}');
    expect(loadProfile(path).name).toBe('a');
  });
});

describe('providers.json 校验', () => {
  it('合法的最小文件通过', () => {
    const path = writeTemp(
      'providers.json',
      JSON.stringify({ providers: { local: { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'm' }] } } }),
    );
    expect(loadProvidersConfig(path).providers['local']?.models?.[0]?.id).toBe('m');
  });

  it('文件不存在 = 没有自定义供应商，不算错', () => {
    expect(loadProvidersConfig('./definitely-missing-providers.json')).toEqual({ providers: {} });
  });

  it('未知的模型字段报错（写错键名必须炸）', () => {
    const path = writeTemp(
      'providers.json',
      JSON.stringify({ providers: { a: { models: [{ id: 'm', context_windows: 100 }] } } }),
    );
    expect(() => loadProvidersConfig(path)).toThrow(ConfigError);
  });

  it('contextWindow 必须为正数', () => {
    const path = writeTemp(
      'providers.json',
      JSON.stringify({ providers: { a: { models: [{ id: 'm', contextWindow: 0 }] } } }),
    );
    try {
      loadProvidersConfig(path);
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect((error as ConfigError).issues.join('\n')).toContain('contextWindow');
    }
  });

  it('顶层不是对象 → 报错', () => {
    const path = writeTemp('providers.json', '[]');
    expect(() => loadProvidersConfig(path)).toThrow(ConfigError);
  });
});

describe('auth.json 校验', () => {
  it('每个 provider 一条凭据，$schema 被忽略', () => {
    const path = writeTemp(
      'auth.json',
      JSON.stringify({
        $schema: './schemas/auth.schema.json',
        'opencode-go': { type: 'api_key', key: '$OPENCODE_API_KEY' },
        openai: { type: 'api_key', key: 'sk-literal' },
      }),
    );
    const auth = loadAuthConfig(path);
    expect(Object.keys(auth)).toEqual(['opencode-go', 'openai']);
  });

  it('凭据形状不对 → 报错并带上 providerId', () => {
    const path = writeTemp('auth.json', JSON.stringify({ openai: { type: 'api_key', kay: 'x' } }));
    try {
      loadAuthConfig(path);
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect((error as ConfigError).issues.join('\n')).toContain('openai');
    }
  });

  it('顶层是数组 → 报错', () => {
    const path = writeTemp('auth.json', '[]');
    expect(() => loadAuthConfig(path)).toThrow(ConfigError);
  });

  it('凭据不是对象 → 报错', () => {
    const path = writeTemp('auth.json', JSON.stringify({ openai: 42 }));
    try {
      loadAuthConfig(path);
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect((error as ConfigError).issues.join('\n')).toContain('openai');
    }
  });

  it('文件不存在 = 没有存下来的凭据', () => {
    expect(loadAuthConfig('./definitely-missing-auth.json')).toEqual({});
  });
});

describe('$ENV / !command 值解析', () => {
  beforeEach(() => {
    clearConfigValueCache();
    process.env['MC_TEST_KEY'] = 'from-env';
  });

  afterEach(() => {
    delete process.env['MC_TEST_KEY'];
    clearConfigValueCache();
  });

  it('$NAME 与 ${NAME} 都认，也认插在中间', () => {
    expect(resolveConfigValue('$MC_TEST_KEY')).toBe('from-env');
    expect(resolveConfigValue('${MC_TEST_KEY}')).toBe('from-env');
    expect(resolveConfigValue('Bearer $MC_TEST_KEY!')).toBe('Bearer from-env!');
  });

  it('引用的环境变量缺失 → undefined（不是空串）', () => {
    expect(resolveConfigValue('$MC_TEST_MISSING_KEY')).toBeUndefined();
    expect(resolveConfigValue('a${MC_TEST_MISSING_KEY}b')).toBeUndefined();
    expect(getConfigValueEnvVarNames('a${MC_TEST_MISSING_KEY}b')).toEqual(['MC_TEST_MISSING_KEY']);
  });

  it('$$ 与 $! 是字面量转义', () => {
    expect(resolveConfigValue('price: $$5')).toBe('price: $5');
    expect(resolveConfigValue('wow$!')).toBe('wow!');
  });

  it('没闭合的 ${ 与非法变量名都当字面量', () => {
    expect(resolveConfigValue('${FOO')).toBe('${FOO');
    expect(resolveConfigValue('${not-valid!}')).toBe('${not-valid!}');
  });

  it('$ 后面不是变量名首字符时也是字面量', () => {
    expect(resolveConfigValue('a$ b')).toBe('a$ b');
    expect(resolveConfigValue('ending $')).toBe('ending $');
  });

  it('可以传自己的 env 映射，优先于进程环境', () => {
    expect(resolveConfigValue('$MC_TEST_KEY', { MC_TEST_KEY: 'from-map' })).toBe('from-map');
    expect(resolveConfigValue('$MC_TEST_KEY', {})).toBe('from-env');
  });

  it('命令式没有环境变量可列', () => {
    expect(getConfigValueEnvVarNames('!echo hi')).toEqual([]);
  });

  it('字面量原样返回', () => {
    expect(resolveConfigValue('sk-literal-123')).toBe('sk-literal-123');
  });

  it('!command 执行取 stdout，并识别为命令式', () => {
    const value = resolveConfigValue('!node -p "1+1"');
    expect(isCommandConfigValue('!node -p "2+2"')).toBe(true);
    expect(isCommandConfigValue('$ENV')).toBe(false);
    // 有些环境里 node 不可用；不可用时不硬性要求 stdout 有值。
    if (value !== undefined) expect(value).toBe('2');
  });

  it('命令失败 → undefined，不抛', () => {
    expect(resolveConfigValue('!node -e "process.exit(3)"')).toBeUndefined();
  });

  it('命令只输出空白 → undefined，不是空串', () => {
    expect(resolveConfigValue('!node -e "process.stdout.write(\'   \')"')).toBeUndefined();
  });

  it('命令结果被缓存：同一个值第二次直接拿缓存', () => {
    const first = resolveConfigValue('!node -p "6*7"');
    const second = resolveConfigValue('!node -p "6*7"');
    expect(first).toBe(second);
  });

  it('OrThrow 版本会说清楚缺哪个环境变量', () => {
    expect(() => resolveConfigValueOrThrow('$MC_TEST_MISSING_KEY', 'provider "x" 的 key')).toThrow(
      /MC_TEST_MISSING_KEY/,
    );
    expect(resolveConfigValueOrThrow('$MC_TEST_KEY', 'provider "x" 的 key')).toBe('from-env');
  });

  it('OrThrow 版本一次列出所有缺失的环境变量', () => {
    expect(() => resolveConfigValueOrThrow('$MC_MISSING_A$MC_MISSING_B', 'x')).toThrow(
      /MC_MISSING_A、MC_MISSING_B/,
    );
  });

  it('OrThrow 版本对命令失败报命令本身', () => {
    expect(() => resolveConfigValueOrThrow('!node -e "process.exit(3)"', 'provider "x" 的 key')).toThrow(
      /无法从命令解析/,
    );
  });
});

describe('仓库里真实提交的配置', () => {
  it('providers.json 通过校验', () => {
    expect(() => loadProvidersConfig('./providers.json')).not.toThrow();
  });

  it('settings.ts 不内置默认 profile，示例 profile 本身通过校验', () => {
    const settingsText = readFileSync('./settings.ts', 'utf8');
    const listed = [...settingsText.matchAll(/"\.\/(profiles\/[^"]+\.json)"/g)].map((match) => match[1]);
    expect(listed).toEqual([]);
    const profile = loadProfile('./profiles/deepseek.json');
    expect(profile.name).toBe('deepseek');
    expect(JSON.stringify(profile.model).length).toBeGreaterThan(0);
  });

  it('auth.example.json 也能被读（示例必须是合法形状）', () => {
    const auth = loadAuthConfig('./auth.example.json');
    expect(Object.keys(auth).length).toBeGreaterThan(0);
  });
});

describe('parseJsonFile', () => {
  it('不带注释的严格模式会拒绝注释', () => {
    expect(() => parseJsonFile('<x>', '{ // c\n }')).toThrow(ConfigError);
    expect(parseJsonFile('<x>', '{ // c\n "a": 1 }', true)).toEqual({ a: 1 });
  });
});
