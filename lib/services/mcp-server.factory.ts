import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  requireScopes,
  ResourceTemplate as SdkResourceTemplate,
  type CallToolResult,
  type GetPromptResult,
  type InputRequiredResult,
  type ReadResourceResult,
  type ScopeChallengeHandler,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { McpCallKind, McpContext } from '../interfaces/mcp-context.interface.js';
import type { McpModuleOptions } from '../interfaces/mcp-module-options.interface.js';
import type { McpPrimitives, McpServing } from '../interfaces/mcp-serving.interface.js';
import { MCP_MODULE_OPTIONS } from '../mcp.constants.js';
import { McpObserve } from '../observe/mcp-observe.service.js';
import { INTERNAL_ERROR_MESSAGE, toolErrorResult, toProtocolError } from '../utils/errors.util.js';
import { toCallToolResult, toGetPromptResult, toReadResourceResult } from '../utils/results.util.js';
import {
  McpRegistry,
  type McpPromptEntry,
  type McpResourceEntry,
  type McpResourceTemplateEntry,
  type McpToolEntry,
} from './mcp-registry.service.js';

export type { McpServing };

type ToolCallback = (args: unknown, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult>;
type ToolCallbackWithoutArgs = (ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult>;

/**
 * Builds the SDK server instances: one per HTTP request (`createMcpHandler()`), one per stdio connection
 * (`serveStdio()`), each with the primitives of the registry the `filter` option picks (all of them without it), whose
 * callbacks run the methods through Nest's enhancers. Building one costs a registration per primitive; schemas were
 * checked and converted at startup.
 */
@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger('McpModule');

  constructor(
    private readonly registry: McpRegistry,
    private readonly observe: McpObserve,
    @Inject(MCP_MODULE_OPTIONS) private readonly options: McpModuleOptions,
  ) {}

  async create(serving: McpServing): Promise<McpServer> {
    const primitives = await this.select(serving);
    const { name, version, title, description, websiteUrl, icons, instructions } = this.options;
    const server = new McpServer(
      {
        name,
        version,
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(websiteUrl !== undefined && { websiteUrl }),
        ...(icons !== undefined && { icons }),
      },
      { ...(instructions !== undefined && { instructions }) },
    );

    for (const tool of primitives.tools) {
      this.registerTool(server, tool, serving);
    }
    for (const resource of primitives.resources) {
      const { title, description, mimeType, size, annotations, icons, _meta, cacheHint } = resource.options;
      server.registerResource(
        resource.name,
        resource.uri,
        {
          ...defined({ title, description, mimeType, size, annotations, icons, _meta, cacheHint }),
          ...scopeChallenge(resource.options.scopes),
        },
        (uri, ctx) => this.readResource(resource, {}, uri, ctx, serving),
      );
    }
    for (const template of primitives.resourceTemplates) {
      const { title, description, mimeType, annotations, icons, _meta, cacheHint } = template.options;
      server.registerResource(
        template.name,
        new SdkResourceTemplate(template.uriTemplate, { list: undefined }),
        {
          ...defined({ title, description, mimeType, annotations, icons, _meta, cacheHint }),
          ...scopeChallenge(template.options.scopes),
        },
        (uri, variables, ctx) => this.readResource(template, variables, uri, ctx, serving),
      );
    }
    for (const prompt of primitives.prompts) {
      this.registerPrompt(server, prompt, serving);
    }
    await this.options.onServerCreated?.(server, serving);
    return server;
  }

  /** The registry's primitives the `filter` option keeps for `serving`; all of them without it. */
  private async select(serving: McpServing): Promise<McpPrimitives> {
    const all: McpPrimitives = {
      tools: [...this.registry.tools],
      resources: [...this.registry.resources],
      resourceTemplates: [...this.registry.resourceTemplates],
      prompts: [...this.registry.prompts],
    };
    if (!this.options.filter) {
      return all;
    }
    const kept = await this.options.filter(all, serving);
    return {
      tools: subset(all.tools, kept?.tools, 'tools'),
      resources: subset(all.resources, kept?.resources, 'resources'),
      resourceTemplates: subset(all.resourceTemplates, kept?.resourceTemplates, 'resourceTemplates'),
      prompts: subset(all.prompts, kept?.prompts, 'prompts'),
    };
  }

  private registerTool(server: McpServer, tool: McpToolEntry, serving: McpServing) {
    const { title, description, annotations, icons, _meta } = tool.options;
    const config = {
      ...defined({ title, description, annotations, icons, _meta }),
      ...(tool.inputSchema && { inputSchema: tool.inputSchema }),
      ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
      ...scopeChallenge(tool.options.scopes),
    };
    // Without an input schema the SDK calls back with the context alone.
    const callback: ToolCallback | ToolCallbackWithoutArgs = tool.inputSchema
      ? (args: unknown, ctx: ServerContext) => this.callTool(tool, args, ctx, serving)
      : (ctx: ServerContext) => this.callTool(tool, {}, ctx, serving);
    server.registerTool(tool.name, config as Parameters<McpServer['registerTool']>[1], callback as never);
  }

  private registerPrompt(server: McpServer, prompt: McpPromptEntry, serving: McpServing) {
    const { title, description, icons, _meta } = prompt.options;
    const config = {
      ...defined({ title, description, icons, _meta }),
      ...(prompt.argsSchema && { argsSchema: prompt.argsSchema }),
      ...scopeChallenge(prompt.options.scopes),
    };
    const callback = prompt.argsSchema
      ? (args: unknown, ctx: ServerContext) => this.getPrompt(prompt, args, ctx, serving)
      : (ctx: ServerContext) => this.getPrompt(prompt, {}, ctx, serving);
    server.registerPrompt(prompt.name, config as never, callback as never);
  }

  private async callTool(
    tool: McpToolEntry,
    input: unknown,
    ctx: ServerContext,
    serving: McpServing,
  ): Promise<CallToolResult | InputRequiredResult> {
    this.observe.nameOperation(`tools/call ${tool.name}`);
    let value: unknown;
    try {
      value = await tool.handler(input ?? {}, this.createContext('tool', tool.name, undefined, ctx, serving));
    } catch (error) {
      // Nest's exception handler has run the filters, and logged what was not an HttpException.
      return toolErrorResult(error);
    }
    try {
      return toCallToolResult(value, tool.outputSchema !== undefined);
    } catch (error) {
      this.logger.error(`${tool.where} returned a value that is not a tool result`, (error as Error)?.stack);
      return { content: [{ type: 'text', text: INTERNAL_ERROR_MESSAGE }], isError: true };
    }
  }

  private async readResource(
    entry: McpResourceEntry | McpResourceTemplateEntry,
    variables: unknown,
    uri: URL,
    ctx: ServerContext,
    serving: McpServing,
  ): Promise<ReadResourceResult | InputRequiredResult> {
    this.observe.nameOperation(`resources/read ${'uriTemplate' in entry ? entry.uriTemplate : entry.uri}`);
    let value: unknown;
    try {
      value = await entry.handler({ ...(variables as object) }, this.createContext('resource', entry.name, uri, ctx, serving));
    } catch (error) {
      throw toProtocolError(error, uri);
    }
    try {
      return toReadResourceResult(value, uri, entry.options.mimeType);
    } catch (error) {
      try {
        this.logger.error(
          `${entry.where} returned a value that could not be converted to a resource result`,
          (error as Error)?.stack,
        );
      } catch {
        // A diagnostic failure must not replace the sanitized protocol error.
      }
      throw new ProtocolError(ProtocolErrorCode.InternalError, INTERNAL_ERROR_MESSAGE);
    }
  }

  private async getPrompt(
    prompt: McpPromptEntry,
    args: unknown,
    ctx: ServerContext,
    serving: McpServing,
  ): Promise<GetPromptResult | InputRequiredResult> {
    this.observe.nameOperation(`prompts/get ${prompt.name}`);
    let value: unknown;
    try {
      value = await prompt.handler(args ?? {}, this.createContext('prompt', prompt.name, undefined, ctx, serving));
    } catch (error) {
      throw toProtocolError(error);
    }
    try {
      return toGetPromptResult(value, prompt.options.description);
    } catch (error) {
      this.logger.error(`${prompt.where}: ${(error as Error).message}`);
      throw toProtocolError(error);
    }
  }

  private createContext(
    kind: McpCallKind,
    name: string,
    uri: URL | undefined,
    server: ServerContext,
    serving: McpServing,
  ): McpContext {
    return {
      kind,
      name,
      ...(uri && { uri }),
      transport: serving.transport,
      era: serving.era,
      authInfo: server.http?.authInfo ?? serving.authInfo,
      request: serving.request,
      requestInfo: server.http?.req ?? serving.requestInfo,
      sessionId: server.sessionId,
      signal: server.mcpReq.signal,
      server,
      reportProgress: async (progress, total, message) => {
        const progressToken = server.mcpReq._meta?.progressToken;
        if (progressToken === undefined) {
          return;
        }
        await server.mcpReq.notify({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress,
            ...(total !== undefined && { total }),
            ...(message !== undefined && { message }),
          },
        });
      },
    };
  }
}

/**
 * The entries of `kept`, which must come from `all`: an entry made up by the filter would carry a handler that Nest's
 * enhancers never wrapped.
 */
function subset<T>(all: readonly T[], kept: readonly T[] | undefined, key: keyof McpPrimitives): readonly T[] {
  if (kept === undefined) {
    return all;
  }
  if (!Array.isArray(kept)) {
    throw new TypeError(`McpModule: the \`filter\` option returned \`${key}\` that is not an array.`);
  }
  const known = new Set(all);
  if (kept.some((entry) => !known.has(entry))) {
    throw new TypeError(
      `McpModule: the \`filter\` option returned an entry in \`${key}\` it was not given. ` +
        'Return a subset of what it receives.',
    );
  }
  return kept;
}

function scopeChallenge(scopes: string[] | undefined): { scopeChallenge?: ScopeChallengeHandler } {
  return scopes?.length ? { scopeChallenge: requireScopes(...(scopes as [string, ...string[]])) } : {};
}

/** `values` without its `undefined` entries: the SDK copies config fields as they are onto the wire. */
function defined<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}
