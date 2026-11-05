import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  hostHeaderValidationResponse,
  localhostAllowedOrigins,
  originValidationResponse,
  type AuthInfo,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { McpAuthGate } from '../auth/mcp-auth-gate.js';
import type { McpModuleOptions } from '../interfaces/mcp-module-options.interface.js';
import type { McpTokenVerifier } from '../interfaces/mcp-token-verifier.interface.js';
import { MCP_HTTP_ENDPOINT, MCP_MODULE_OPTIONS, MCP_TOKEN_VERIFIER } from '../mcp.constants.js';
import { McpServerFactory } from '../services/mcp-server.factory.js';
import { RequestBodyTooLargeError, toWebRequest, writeWebResponse } from './node-http.util.js';

/** The HTTP request behind the SDK's request, for the server instance built for it. */
interface PlatformRequestStore {
  request: unknown;
}

/**
 * The Streamable HTTP endpoint: one SDK handler (`createMcpHandler()`) serving every request statelessly, from a
 * server instance built per request, behind the module's Host/Origin checks and OAuth gate. The endpoint's
 * controller hands it the platform's request and response; the in-memory test client calls `fetch()`.
 */
@Injectable()
export class McpHttpService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('McpModule');
  private readonly platformRequests = new AsyncLocalStorage<PlatformRequestStore>();
  private readonly handler: McpHttpHandler;
  private readonly auth: McpAuthGate | undefined;
  private readonly maxBodySize: number;
  /** The hostnames the `Host` header must name; `undefined`, not checked. */
  private readonly allowedHosts: string[] | undefined;
  /** The origins an `Origin` header must name; `undefined`, not checked. */
  private readonly allowedOrigins: string[] | undefined;

  constructor(
    factory: McpServerFactory,
    @Inject(MCP_MODULE_OPTIONS) private readonly options: McpModuleOptions,
    @Inject(MCP_HTTP_ENDPOINT) private readonly endpoint: { path: string | null },
    private readonly adapterHost: HttpAdapterHost,
    @Optional() @Inject(MCP_TOKEN_VERIFIER) verifier?: McpTokenVerifier | null,
  ) {
    const http = options.http ?? {};
    this.maxBodySize = http.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE;
    this.allowedHosts = hostnames(http.allowedHosts, 'allowedHosts');
    // On by default: a page on another site, in a user's browser, must not reach the server (requests without an
    // Origin, from clients outside a browser, pass).
    this.allowedOrigins =
      http.allowedOrigins === false ? undefined : (hostnames(http.allowedOrigins, 'allowedOrigins') ?? localhostAllowedOrigins());
    if (options.auth) {
      const configured = options.auth.verifier;
      if (!verifier && typeof configured === 'function') {
        throw new TypeError(
          'McpModule: the forRootAsync() factory returned `auth.verifier` as a class. Return an instance (inject what ' +
            'it needs into the factory), or pass the class to forRoot(), where Nest instantiates it.',
        );
      }
      this.auth = new McpAuthGate(options.auth, verifier ?? (configured as McpTokenVerifier), this.logger);
    }

    this.handler = createMcpHandler(
      async ({ era, authInfo, requestInfo }) => {
        try {
          return await factory.create({
            era,
            transport: 'http',
            authInfo,
            requestInfo,
            request: this.platformRequests.getStore()?.request,
          });
        } catch (error) {
          this.logger.error(`Could not build the MCP server: ${(error as Error)?.message}`, (error as Error)?.stack);
          throw error;
        }
      },
      {
        ...(http.legacy && { legacy: http.legacy }),
        ...(http.responseMode && { responseMode: http.responseMode }),
        maxRequestBodySize: this.maxBodySize,
        // Rejected requests (a wrong protocol version, missing headers) are reported here too: the client has its
        // answer, so they are debug output.
        onerror: (error) => this.logger.debug?.(`MCP request rejected: ${error.message}`),
      },
    );
  }

  /** Serves the protected resource metadata, at the origin's root (no global prefix), when `auth` is configured. */
  onModuleInit() {
    const adapter = this.adapterHost?.httpAdapter;
    if (!this.auth || !adapter || this.endpoint.path === null) {
      return;
    }
    const metadata = this.auth.metadata;
    for (const path of this.auth.metadataPaths) {
      adapter.get(path, (_request: unknown, response: unknown) => {
        adapter.setHeader(response, 'Access-Control-Allow-Origin', '*');
        adapter.setHeader(response, 'Cache-Control', 'public, max-age=3600');
        adapter.reply(response, metadata, 200);
      });
    }
  }

  async onApplicationShutdown() {
    await this.handler.close();
  }

  /**
   * Serves one web-standard request: Host and Origin checks, the bearer token (with `auth`), then the SDK. What the
   * in-memory test client (`@nestjs/mcp/testing`) calls.
   */
  async fetch(request: Request, { parsedBody, platformRequest }: { parsedBody?: unknown; platformRequest?: unknown } = {}) {
    const rejected =
      (this.allowedHosts && hostHeaderValidationResponse(request, this.allowedHosts)) ||
      (this.allowedOrigins && originValidationResponse(request, this.allowedOrigins));
    if (rejected) {
      return rejected;
    }

    let authInfo: AuthInfo | undefined;
    if (this.auth) {
      const result = await this.auth.authenticate(request);
      if (result instanceof Response) {
        return result;
      }
      authInfo = result;
    }

    return this.platformRequests.run({ request: platformRequest }, () =>
      this.handler.fetch(request, {
        ...(authInfo && { authInfo }),
        ...(parsedBody !== undefined && { parsedBody }),
      }),
    );
  }

  /**
   * Serves the endpoint's route: the platform's request and response (Express's, the Node adapter's, or Fastify's,
   * whose reply is hijacked) to a web-standard request and back.
   */
  async serve(platformRequest: unknown, platformResponse: unknown): Promise<void> {
    const { req, res, body } = this.unwrap(platformRequest, platformResponse);
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) {
        abort.abort();
      }
    });

    let response: Response;
    try {
      const parsed = body !== undefined;
      const request = await toWebRequest(req, { parsed, signal: abort.signal, maxBodySize: this.maxBodySize });
      response = await this.fetch(request, { ...(parsed && { parsedBody: body }), platformRequest });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        response = jsonRpcError(413, error.message);
      } else {
        this.logger.error(`MCP request failed: ${(error as Error)?.message}`, (error as Error)?.stack);
        response = jsonRpcError(500, 'Internal server error');
      }
    }
    await writeWebResponse(response, res, abort.signal).catch((error) => {
      this.logger.debug?.(`MCP response stream ended early: ${(error as Error)?.message}`);
      res.destroy();
    });
  }

  private unwrap(platformRequest: unknown, platformResponse: unknown) {
    if (this.adapterHost.httpAdapter?.getType() === 'fastify') {
      const request = platformRequest as { raw: IncomingMessage; body?: unknown };
      const reply = platformResponse as { raw: ServerResponse; hijack(): void };
      reply.hijack();
      return { req: request.raw, res: reply.raw, body: request.body };
    }
    // Express and the Node adapter: Node's own request and response, with the parsed body on `body`.
    const req = platformRequest as IncomingMessage & { body?: unknown };
    return { req, res: platformResponse as ServerResponse, body: req.body };
  }
}

function hostnames(value: unknown, option: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new TypeError(
      `McpModule: \`http.${option}\` must be a list of hostnames, such as ["localhost", "app.example.com"]` +
        (option === 'allowedOrigins' ? ', or false to turn the Origin check off.' : '.'),
    );
  }
  return [...value];
}

function jsonRpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: status === 500 ? -32603 : -32000, message }, id: null }, { status });
}
