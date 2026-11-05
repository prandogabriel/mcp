// Module and options
export { McpModule } from './mcp.module.js';
export {
  MCP_MODULE_OPTIONS,
  type McpModuleAsyncOptions,
  type McpModuleRootOptions,
  type McpOptionsFactory,
} from './mcp.module-definition.js';
export type {
  McpAuthOptions,
  McpHttpOptions,
  McpModuleOptions,
  McpModuleStructure,
  McpPrimitives,
  McpServing,
  McpStdioOptions,
} from './interfaces/index.js';

// Tools, resources, prompts: decorators on provider methods, and what the methods receive
export * from './decorators/index.js';
export type {
  McpCallKind,
  McpContext,
  McpProtocolEra,
  McpSchema,
  PromptOptions,
  ResourceOptions,
  ResourceTemplateOptions,
  ToolOptions,
} from './interfaces/index.js';

// Enhancers: the execution context of MCP calls
export { McpExecutionContext, type McpContextType } from './context/index.js';

// Authorization: the server as an OAuth resource server
export type { McpTokenVerifier } from './interfaces/index.js';

// Transports: Streamable HTTP (the endpoint's controller) and stdio
export { McpHttpService } from './http/mcp-http.service.js';
export { McpStdioLogger, McpStdioServer, type McpStdioListenOptions } from './stdio/index.js';

// The discovered primitives, for inspection
export {
  McpRegistry,
  type McpPromptEntry,
  type McpResourceEntry,
  type McpResourceTemplateEntry,
  type McpToolEntry,
} from './services/mcp-registry.service.js';
