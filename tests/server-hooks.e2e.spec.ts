/**
 * The `filter` and `onServerCreated` options: which primitives one request or connection is served, and the server
 * instance built for it, over Streamable HTTP (each adapter and in memory) and stdio.
 */
import { PassThrough } from 'node:stream';
import { Injectable, Module, type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  McpModule,
  McpStdioServer,
  Prompt,
  Resource,
  Tool,
  type McpModuleOptions,
  type McpPrimitives,
  type McpServing,
} from '../lib/index.js';
import { connectMcpClient } from '../lib/testing/index.js';
import { adapters, createApp, urlOf } from './support/adapters.js';
import { connect, eras, text } from './support/clients.js';

@Injectable()
class CatalogTools {
  @Tool({ description: 'Lists the catalog', annotations: { readOnlyHint: true } })
  browse() {
    return 'browsed';
  }

  @Tool({ description: 'Orders an item', inputSchema: z.object({ item: z.string() }) })
  order({ item }: { item: string }) {
    return `ordered ${item}`;
  }

  @Resource({ uri: 'catalog://terms', mimeType: 'text/plain' })
  terms() {
    return 'terms';
  }

  @Prompt({ description: 'Suggests an item' })
  suggest() {
    return 'Suggest an item';
  }
}

/** The `x-plan` header of the request the server is built for, whatever the platform's request looks like. */
function planOf(serving: McpServing): string | undefined {
  const headers = (serving.request as { headers?: Record<string, string | string[] | undefined> } | undefined)?.headers;
  const plan = headers?.['x-plan'];
  return Array.isArray(plan) ? plan[0] : plan;
}

/** Read-only tools for every request; the others only with `x-plan: pro`. */
const byPlan: McpModuleOptions['filter'] = ({ tools }, serving) => ({
  tools: planOf(serving) === 'pro' ? tools : tools.filter((tool) => tool.options.annotations?.readOnlyHint),
});

function moduleWith(options: Partial<McpModuleOptions>): Type<unknown> {
  @Module({
    imports: [McpModule.forRoot({ name: 'hooks', version: '1.0.0', ...options })],
    providers: [CatalogTools],
  })
  class HooksModule {}
  return HooksModule;
}

async function init(module: Type<unknown>) {
  const moduleRef = await Test.createTestingModule({ imports: [module] }).compile();
  return moduleRef.init();
}

const names = (list: { name: string }[]) => list.map((entry) => entry.name).sort();

describe.each(adapters.map((adapter) => adapter.name))('filter over HTTP, %s', (adapter) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(adapter, moduleWith({ filter: byPlan }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(eras)('serves each request the primitives it picks, %s client', async (era) => {
    const url = await urlOf(app);
    const free = await connect(url, era);
    const pro = await connect(url, era, { 'x-plan': 'pro' });

    expect(names((await free.listTools()).tools)).toEqual(['browse']);
    expect(names((await pro.listTools()).tools)).toEqual(['browse', 'order']);
    expect(text(await pro.callTool({ name: 'order', arguments: { item: 'tea' } }))).toBe('ordered tea');

    await free.close();
    await pro.close();
  });

  it.each(eras)('answers a call to a primitive it left out as an unknown tool, %s client', async (era) => {
    const client = await connect(await urlOf(app), era);
    const call = client.callTool({ name: 'order', arguments: { item: 'tea' } }).then(
      (result) => ({ result }),
      (error: Error) => ({ error }),
    );
    const outcome = await call;
    if ('error' in outcome) {
      expect(outcome.error.message).toMatch(/order/);
    } else {
      expect(outcome.result).toMatchObject({ isError: true });
      expect(text(outcome.result)).toMatch(/order/);
      expect(text(outcome.result)).not.toBe('ordered tea');
    }
    await client.close();
  });
});

describe('filter', () => {
  it('keeps every primitive of a kind it leaves out', async () => {
    const moduleRef = await init(moduleWith({ filter: () => ({ tools: [] }) }));
    const client = await connectMcpClient(moduleRef);

    expect((await client.listTools()).tools).toEqual([]);
    expect(names((await client.listResources()).resources)).toEqual(['terms']);
    expect(names((await client.listPrompts()).prompts)).toEqual(['suggest']);

    await client.close();
    await moduleRef.close();
  });

  it('receives every primitive and what the server is built for, and may be async', async () => {
    const calls: { primitives: McpPrimitives; serving: McpServing }[] = [];
    const moduleRef = await init(
      moduleWith({
        filter: async (primitives, serving) => {
          calls.push({ primitives, serving });
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { tools: primitives.tools.filter((tool) => tool.name === 'order'), prompts: [] };
        },
      }),
    );
    const client = await connectMcpClient(moduleRef, { headers: { 'x-plan': 'free' } });

    expect(names((await client.listTools()).tools)).toEqual(['order']);
    expect((await client.listPrompts()).prompts).toEqual([]);

    const [{ primitives, serving }] = calls;
    expect(names([...primitives.tools])).toEqual(['browse', 'order']);
    expect(names([...primitives.resources])).toEqual(['terms']);
    expect(primitives.resourceTemplates).toEqual([]);
    expect(names([...primitives.prompts])).toEqual(['suggest']);
    expect(serving).toMatchObject({ transport: 'http', era: 'modern' });
    expect(planOf(serving)).toBe('free');

    await client.close();
    await moduleRef.close();
  });

  it('cannot change what the application declares for later requests', async () => {
    let first = true;
    const moduleRef = await init(
      moduleWith({
        filter: (primitives) => {
          if (first) {
            first = false;
            (primitives.tools as unknown[]).length = 0;
          }
          return {};
        },
      }),
    );
    const spoiled = await connectMcpClient(moduleRef);
    await spoiled.listTools();
    await spoiled.close();

    const client = await connectMcpClient(moduleRef);
    expect(first).toBe(false);
    expect(names((await client.listTools()).tools)).toEqual(['browse', 'order']);

    await client.close();
    await moduleRef.close();
  });

  it('fails the request, rather than serving everything, when it throws', async () => {
    const app = await createApp(
      'express',
      moduleWith({
        filter: () => {
          throw new Error('flag service is down');
        },
      }),
    );
    await expect(connect(await urlOf(app), 'legacy').then((client) => client.listTools())).rejects.toThrow();
    await app.close();
  });

  it('fails the request when it returns an entry it was not given', async () => {
    const app = await createApp(
      'express',
      moduleWith({
        filter: ({ tools }) => ({ tools: [{ ...tools[0]!, name: 'forged' }] }),
      }),
    );
    await expect(connect(await urlOf(app), 'legacy').then((client) => client.listTools())).rejects.toThrow();
    await app.close();
  });
});

describe('onServerCreated', () => {
  it('receives each server instance before it serves, with what it is built for', async () => {
    const seen: { server: McpServer; serving: McpServing }[] = [];
    const moduleRef = await init(
      moduleWith({
        filter: byPlan,
        onServerCreated: async (server, serving) => {
          seen.push({ server, serving });
          server.registerTool('whoami', { description: 'Added by the hook' }, async () => ({
            content: [{ type: 'text', text: planOf(serving) ?? 'none' }],
          }));
        },
      }),
    );
    const client = await connectMcpClient(moduleRef, { headers: { 'x-plan': 'pro' } });

    expect(names((await client.listTools()).tools)).toEqual(['browse', 'order', 'whoami']);
    expect(text(await client.callTool({ name: 'whoami', arguments: {} }))).toBe('pro');

    // One instance per request, and none of them shared.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen.map(({ server }) => server)).size).toBe(seen.length);
    expect(seen.every(({ serving }) => serving.transport === 'http')).toBe(true);

    await client.close();
    await moduleRef.close();
  });

  it('fails the request when it throws', async () => {
    const app = await createApp(
      'express',
      moduleWith({
        onServerCreated: () => {
          throw new Error('instrumentation failed');
        },
      }),
    );
    await expect(connect(await urlOf(app), 'legacy').then((client) => client.listTools())).rejects.toThrow();
    await app.close();
  });
});

describe('over stdio', () => {
  it('applies both to the connection, as a stdio serving', async () => {
    const servings: McpServing[] = [];
    const moduleRef = await init(
      moduleWith({
        filter: ({ tools }, serving) => {
          servings.push(serving);
          return { tools: tools.filter((tool) => tool.name === 'browse') };
        },
        onServerCreated: (_server, serving) => void servings.push(serving),
      }),
    );
    const stdio = moduleRef.get(McpStdioServer);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const listening = stdio.listen({ stdin, stdout });

    const responses = new Map<number, any>();
    let buffer = '';
    stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.id !== undefined) {
          responses.set(message.id, message);
        }
      }
    });
    const send = (message: object) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const response = async (id: number) => {
      await vi.waitFor(() => expect(responses.has(id)).toBe(true));
      return responses.get(id);
    };

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
    });
    expect((await response(1)).result).toBeDefined();
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });

    expect(names((await response(2)).result.tools)).toEqual(['browse']);
    expect(servings.length).toBe(2);
    expect(servings.every((serving) => serving.transport === 'stdio' && serving.era === 'legacy')).toBe(true);

    stdin.end();
    await listening;
    await moduleRef.close();
  });
});
