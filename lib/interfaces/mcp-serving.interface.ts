import type { AuthInfo } from '@modelcontextprotocol/server';
import type {
  McpPromptEntry,
  McpResourceEntry,
  McpResourceTemplateEntry,
  McpToolEntry,
} from '../services/mcp-registry.service.js';
import type { McpProtocolEra } from './mcp-context.interface.js';

/** What a server instance serves: one HTTP request, or one stdio connection. */
export interface McpServing {
  era: McpProtocolEra;
  transport: 'http' | 'stdio';
  /** The verified access token, with the module's `auth` option (HTTP only). */
  authInfo?: AuthInfo;
  /** The web-standard request (HTTP). */
  requestInfo?: Request;
  /** The HTTP platform's request (HTTP through the endpoint's route). */
  request?: unknown;
}

/**
 * The tools, resources, resource templates and prompts a server instance registers: what the `filter` option receives
 * (every primitive the application declares) and returns (the ones this request or connection is served).
 */
export interface McpPrimitives {
  tools: readonly McpToolEntry[];
  resources: readonly McpResourceEntry[];
  resourceTemplates: readonly McpResourceTemplateEntry[];
  prompts: readonly McpPromptEntry[];
}
