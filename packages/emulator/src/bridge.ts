import { createConnection, type Socket } from 'node:net';

import { isBridgeResponse, type BridgeRequest, type BridgeResponse, type FrameCommand } from '@romlab/schema';

import { EmulatorError } from './adapter.js';

/**
 * Client for the ROMLab bridge protocol: newline-delimited JSON over TCP.
 *
 * Requests carry a monotonic id and responses echo it, so a slow command can
 * never be mistaken for the answer to the next one. Text-over-TCP was chosen
 * deliberately: when a capture desyncs, an operator can attach to the port and
 * read the conversation.
 */
export class BridgeClient {
  private socket?: Socket;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve: (response: BridgeResponse) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly defaultTimeoutMs = 15_000,
  ) {}

  async connect(timeoutMs = this.defaultTimeoutMs): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new EmulatorError(
            `Timed out after ${timeoutMs}ms connecting to the ROMLab bridge at ${this.host}:${this.port}. ` +
              'Is the ROMLab external tool loaded in BizHawk?',
            'bridge_connect_timeout',
          ),
        );
      }, timeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.onData(chunk));
        socket.on('error', (error) => this.failAll(error));
        socket.on('close', () => this.failAll(new EmulatorError('Bridge closed the connection.', 'bridge_closed')));
        this.socket = socket;
        resolve();
      });

      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new EmulatorError(`Bridge connection failed: ${error.message}`, 'bridge_connect_failed'));
      });
    });
  }

  async send(command: FrameCommand, timeoutMs = this.defaultTimeoutMs): Promise<BridgeResponse> {
    const socket = this.socket;
    if (!socket) throw new EmulatorError('Bridge is not connected.', 'not_connected');

    const id = this.nextId++;
    const request: BridgeRequest = { id, command };

    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new EmulatorError(
            `Bridge did not answer ${command.op} within ${timeoutMs}ms.`,
            'bridge_timeout',
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined as Socket | undefined;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.end(() => resolve()));
    socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A malformed line means the transcript is no longer trustworthy; failing
      // every request beats silently correlating the wrong response.
      this.failAll(new EmulatorError(`Bridge sent a line that is not JSON: ${line}`, 'bridge_protocol_error'));
      return;
    }

    if (!isBridgeResponse(parsed)) {
      this.failAll(new EmulatorError(`Bridge sent an unrecognised message: ${line}`, 'bridge_protocol_error'));
      return;
    }

    const waiter = this.pending.get(parsed.id);
    if (!waiter) return; // Late answer to a request that already timed out.
    this.pending.delete(parsed.id);
    waiter.resolve(parsed);
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
