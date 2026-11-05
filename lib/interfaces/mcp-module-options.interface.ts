import type { ControllerOptions, ModuleMetadata, Type } from '@nestjs/common';
import type { Icon, McpServer } from '@modelcontextprotocol/server';
import type { McpPrimitives, McpServing } from './mcp-serving.interface.js';
import type { McpTokenVerifier } from './mcp-token-verifier.interface.js';

/** How the Streamable HTTP endpoint serves requests. */
export interface McpHttpOptions {
  /**
   * How 2025-era clients (an `initialize` handshake, no per-request `_meta` envelope) are served:
   * `'stateless'` (default) answers each of their requests on its own, from the same tools, resources and prompts;
   * `'reject'` makes the endpoint 2026-07-28 only, answering them with the unsupported-protocol-version error.
   * Either way the endpoint keeps no session between requests, so it works behind any load balancer.
   */
  legacy?: 'stateless' | 'reject';
  /**
   * Response shape for 2026-07-28 requests: `'auto'` (default) answers with a JSON body, upgraded to an SSE stream
   * when the method sends something before its result (progress); `'sse'` always streams; `'json'` never does and
   * drops progress notifications.
   */
  responseMode?: 'auto' | 'json' | 'sse';
  /**
   * Hostnames (port-agnostic) the `Host` header must name, e.g. `['localhost', '127.0.0.1', '[::1]']`; other
   * requests get 403. This is what stops DNS rebinding against a server bound to localhost. Not checked unless set.
   */
  allowedHosts?: string[];
  /**
   * The origins a request's `Origin` header must name, when it has one; other requests get 403. Requests without one
   * (assistants, CLIs, hosted connectors: every client outside a browser) always pass, so this decides which web
   * pages may call the endpoint from a browser. Hostnames, port-agnostic (`'app.example.com'`); a browser extension's
   * id, its origin's hostname; or `'<scheme>://*'` for every extension of a browser (`'moz-extension://*'`). A list
   * replaces the default; `false` turns the check off.
   * Default: `localhostAllowedOrigins()` from `@modelcontextprotocol/server` (`localhost`, `127.0.0.1`, `[::1]`).
   */
  allowedOrigins?: string[] | false;
  /**
   * Upper bound in bytes on a request body the module reads itself. Bodies the HTTP platform already parsed are
   * bounded by its own body parser (for Express, `app.useBodyParser('json', { limit })`). Default 4 MiB.
   */
  maxRequestBodySize?: number;
}

/**
 * The MCP server as an OAuth 2.1 resource server: every HTTP request carries an access token from one of
 * `authorizationServers`, issued for `resource`.
 */
export interface McpAuthOptions {
  /**
   * Verifies the tokens. In `forRoot()`, a class (instantiated by Nest, so it can inject what it needs; its
   * dependencies come from global modules or the `imports` option) or an instance; from the `forRootAsync()` factory,
   * an instance.
   */
  verifier: McpTokenVerifier | Type<McpTokenVerifier>;
  /**
   * The canonical URI of this MCP server, e.g. `https://api.example.com/mcp`: what clients pass as the OAuth
   * `resource` parameter, and the audience a token must have been issued for (RFC 8707). The protected resource
   * metadata is served at its path-aware well-known location (`/.well-known/oauth-protected-resource/mcp`).
   */
  resource: string;
  /** Issuer URLs of the authorization servers whose tokens are accepted, advertised in the metadata (RFC 9728). */
  authorizationServers: string[];
  /** Scopes advertised in the metadata, for clients to request: the minimal set for basic use. */
  scopesSupported?: string[];
  /** Scopes every request's token must carry; others get 403 `insufficient_scope`. */
  requiredScopes?: string[];
  /** `resource_name` in the metadata. */
  resourceName?: string;
  /** `resource_documentation` in the metadata: a URL. */
  resourceDocumentation?: string;
}

export interface McpStdioOptions {
  /**
   * How a connection that opens with the 2025 `initialize` handshake is served: `'serve'` (default) pins it to the
   * 2025 era; `'reject'` answers it with the unsupported-protocol-version error and waits for a 2026-07-28 opening.
   */
  legacy?: 'serve' | 'reject';
}

/** `forRoot()`'s options, and what the `forRootAsync()` factory returns. */
export interface McpModuleOptions {
  /** The server's name, reported to clients (`serverInfo.name`). */
  name: string;
  /** The server's version (`serverInfo.version`). */
  version: string;
  /** Display name of the server. */
  title?: string;
  description?: string;
  websiteUrl?: string;
  icons?: Icon[];
  /** Instructions for the model on how to use the server, sent to clients. */
  instructions?: string;
  /**
   * The modules whose providers are searched for tools, resources and prompts. Default: every module of the
   * application.
   */
  include?: Function[];
  /**
   * Picks the primitives one HTTP request or stdio connection is served, before its server instance registers them:
   * a primitive left out is neither listed nor callable there (a call to it gets the SDK's unknown-tool, -prompt or
   * -resource error, before any guard runs). It receives every primitive the application declares and returns subsets
   * of them; a key it leaves out keeps all of its kind. For what a token's scopes do not cover, `scopes` lists the
   * primitive and challenges the call (step-up authorization); `filter` hides it, for feature flags, tenants or
   * clients that cannot ask for more scopes. Called once per request (HTTP) or connection (stdio); when it throws,
   * the request fails rather than being served everything.
   */
  filter?: (
    primitives: McpPrimitives,
    serving: McpServing,
  ) => Partial<McpPrimitives> | Promise<Partial<McpPrimitives>>;
  /**
   * Called with each server instance once it has registered its primitives, before it serves its request or
   * connection: for libraries that wrap an `McpServer` (analytics, tracing). When it throws, the request fails.
   */
  onServerCreated?: (server: McpServer, serving: McpServing) => void | Promise<void>;
  http?: McpHttpOptions;
  /** OAuth for the HTTP endpoint. Without it, the endpoint accepts every request its route lets through. */
  auth?: McpAuthOptions;
  stdio?: McpStdioOptions;
}

/**
 * What only the top level of `forRoot()` and `forRootAsync()` takes, because the module's routes and imports must be
 * known when it is defined.
 */
export interface McpModuleStructure {
  /**
   * Path of the Streamable HTTP endpoint, a route like any controller's: the global prefix and versioning apply to
   * it. Default `'mcp'`. `false` serves no HTTP endpoint (a stdio-only application).
   */
  path?: string | false;
  /**
   * The endpoint's version, when versioning is enabled, as `@Controller({ version })` takes it: e.g.
   * `VERSION_NEUTRAL` keeps it at `/mcp` when `enableVersioning()` sets a `defaultVersion`. (`version` is the server's
   * own version.)
   */
  endpointVersion?: ControllerOptions['version'];
  /**
   * Class decorators applied to the controller that serves `path`, e.g. `[Public()]` to exempt it from a global
   * authentication guard, or `[UseGuards(ApiKeyGuard)]`.
   */
  decorators?: ClassDecorator[];
  /** Modules whose exports a `verifier` class injects. */
  imports?: ModuleMetadata['imports'];
}

/** What a class passed to `forRootAsync({ useClass })` implements. */
export interface McpOptionsFactory {
  createMcpOptions(): McpModuleOptions | Promise<McpModuleOptions>;
}
