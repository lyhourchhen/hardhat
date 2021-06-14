import { EventEmitter } from "events";

import { EIP1193Provider, RequestArguments } from "../../../types";
import {
  HARDHAT_NETWORK_RESET_EVENT,
  HARDHAT_NETWORK_REVERT_SNAPSHOT_EVENT,
} from "../../constants";
import {
  FailedJsonRpcResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  parseJsonResponse,
  SuccessfulJsonRpcResponse,
} from "../../util/jsonrpc";
import { HardhatError } from "../errors";
import { ERRORS } from "../errors-list";

import { ProviderError } from "./errors";

function isErrorResponse(response: any): response is FailedJsonRpcResponse {
  return typeof response.error !== "undefined";
}

const MAX_RETRIES = 6;
const MAX_RETRY_AWAIT_SECONDS = 5;

const TOO_MANY_REQUEST_STATUS = 429;

export class HttpProvider extends EventEmitter implements EIP1193Provider {
  private _nextRequestId = 1;

  constructor(
    private readonly _url: string,
    private readonly _networkName: string,
    private readonly _extraHeaders: { [name: string]: string } = {},
    private readonly _timeout = 20000
  ) {
    super();
  }

  get url(): string {
    return this._url;
  }

  public async request(args: RequestArguments): Promise<unknown> {
    // We create the error here to capture the stack traces at this point,
    // the async call that follows would probably loose of the stack trace
    const error = new ProviderError("HttpProviderError", -1);

    const jsonRpcRequest = this._getJsonRpcRequest(
      args.method,
      args.params as any[]
    );
    const jsonRpcResponse = await this._fetchJsonRpcResponse(jsonRpcRequest);

    if (isErrorResponse(jsonRpcResponse)) {
      error.message = jsonRpcResponse.error.message;
      error.code = jsonRpcResponse.error.code;
      error.data = jsonRpcResponse.error.data;
      // tslint:disable-next-line only-hardhat-error
      throw error;
    }

    if (args.method === "hardhat_reset") {
      this.emit(HARDHAT_NETWORK_RESET_EVENT);
    }
    if (args.method === "evm_revert") {
      this.emit(HARDHAT_NETWORK_REVERT_SNAPSHOT_EVENT);
    }

    return jsonRpcResponse.result;
  }

  /**
   * Sends a batch of requests. Fails if any of them fails.
   */
  public async sendBatch(
    batch: Array<{ method: string; params: any[] }>
  ): Promise<any[]> {
    // We create the errors here to capture the stack traces at this point,
    // the async call that follows would probably loose of the stack trace
    const error = new ProviderError("HttpProviderError", -1);

    // we need this to sort the responses
    const idToIndexMap: Record<string, number> = {};

    const requests = batch.map((r, i) => {
      const jsonRpcRequest = this._getJsonRpcRequest(r.method, r.params);
      idToIndexMap[jsonRpcRequest.id] = i;
      return jsonRpcRequest;
    });

    const jsonRpcResponses = await this._fetchJsonRpcResponse(requests);

    for (const response of jsonRpcResponses) {
      if (isErrorResponse(response)) {
        error.message = response.error.message;
        error.code = response.error.code;
        error.data = response.error.data;
        // tslint:disable-next-line only-hardhat-error
        throw error;
      }
    }

    // We already know that it has this type, but TS can't infer it.
    const responses = jsonRpcResponses as SuccessfulJsonRpcResponse[];

    // we use the id to sort the responses so that they match the order of the requests
    const sortedResponses = responses
      .map(
        (response) =>
          [idToIndexMap[response.id], response.result] as [number, any]
      )
      .sort(([indexA], [indexB]) => indexA - indexB)
      .map(([, result]) => result);

    return sortedResponses;
  }

  private async _fetchJsonRpcResponse(
    request: JsonRpcRequest,
    retryNumber?: number
  ): Promise<JsonRpcResponse>;
  private async _fetchJsonRpcResponse(
    request: JsonRpcRequest[],
    retryNumber?: number
  ): Promise<JsonRpcResponse[]>;
  private async _fetchJsonRpcResponse(
    request: JsonRpcRequest | JsonRpcRequest[],
    retryNumber?: number
  ): Promise<JsonRpcResponse | JsonRpcResponse[]>;
  private async _fetchJsonRpcResponse(
    request: JsonRpcRequest | JsonRpcRequest[],
    retryNumber = 0
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    const { default: got } = await import("got");

    const requests = Array.isArray(request) ? request : [request];
    const methods = requests.map((r) => r.method);
    const ids = requests.map((r) => r.id);
    const start = new Date();

    try {
      const response = await got(this._url, {
        method: "POST",
        retry: {
          limit: MAX_RETRY_AWAIT_SECONDS,
          maxRetryAfter: MAX_RETRY_AWAIT_SECONDS,
        },
        timeout: this._timeout,
        json: request,
        headers: {
          "Content-Type": "application/json",
          ...this._extraHeaders,
        },
      }).text();

      const result = parseJsonResponse(response);
      const end = new Date();
      const duration = end.getTime() - start.getTime();
      if (duration > 1000) {
        console.log(
          `Request ${ids} - methods ${methods} - duration ${duration}ms`
        );
      }

      return result;
    } catch (error) {
      const end = new Date();
      const duration = end.getTime() - start.getTime();
      if (duration > 1000) {
        console.log(
          `Failed request ${ids} - methods ${methods} - duration ${duration}ms`
        );
      }

      // TODO: Handle got errors

      // // tslint:disable-next-line only-hardhat-error
      // throw new ProviderError(
      //   `Too Many Requests error received from ${url.hostname}`,
      //   -32005 // Limit exceeded according to EIP1474
      // );

      if (error.code === "ECONNREFUSED") {
        throw new HardhatError(
          ERRORS.NETWORK.NODE_IS_NOT_RUNNING,
          { network: this._networkName },
          error
        );
      }

      if (error.type === "request-timeout") {
        throw new HardhatError(ERRORS.NETWORK.NETWORK_TIMEOUT, {}, error);
      }

      // tslint:disable-next-line only-hardhat-error
      throw error;
    }
  }

  private async _retry(
    request: JsonRpcRequest | JsonRpcRequest[],
    seconds: number,
    retryNumber: number
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * seconds));
    return this._fetchJsonRpcResponse(request, retryNumber + 1);
  }

  private _getJsonRpcRequest(
    method: string,
    params: any[] = []
  ): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      method,
      params,
      id: this._nextRequestId++,
    };
  }

  private _shouldRetry(retryNumber: number, retryAfterSeconds: number) {
    if (retryNumber > MAX_RETRIES) {
      return false;
    }

    if (retryAfterSeconds > MAX_RETRY_AWAIT_SECONDS) {
      return false;
    }

    return true;
  }

  private _isRateLimitResponse(response: Response) {
    return response.status === TOO_MANY_REQUEST_STATUS;
  }

  private _getRetryAfterSeconds(response: Response): number | undefined {
    const header = response.headers.get("Retry-After");

    if (header === undefined || header === null) {
      return undefined;
    }

    const parsed = parseInt(header, 10);
    if (isNaN(parsed)) {
      return undefined;
    }

    console.log("Retry-After", parsed);

    return parsed;
  }
}
