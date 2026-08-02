import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { after, describe, it } from 'node:test';

import type { BridgeRequest, BridgeResponse } from '@romlab/schema';

import { BridgeClient } from './bridge.js';

const servers: Server[] = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Stands in for the C# external tool so the wire protocol is tested for real. */
async function startFakeBridge(
  handler: (request: BridgeRequest, socket: Socket) => void,
): Promise<number> {
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handler(JSON.parse(line) as BridgeRequest, socket);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {});
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

function reply(socket: Socket, response: BridgeResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

describe('bridge protocol', () => {
  it('correlates responses to requests by id', async () => {
    const port = await startFakeBridge((request, socket) => {
      reply(socket, { id: request.id, ok: true, frame: 42, result: { kind: 'none' } });
    });

    const client = new BridgeClient('127.0.0.1', port, 2_000);
    await client.connect();

    const response = await client.send({ op: 'advance', frames: 1 });
    assert.equal(response.ok, true);
    assert.equal(response.ok && response.frame, 42);

    await client.close();
  });

  it('does not mix up two commands answered out of order', async () => {
    const port = await startFakeBridge((request, socket) => {
      const delay = request.command.op === 'status' ? 60 : 5;
      const frame = request.command.op === 'status' ? 100 : 200;
      setTimeout(() => reply(socket, { id: request.id, ok: true, frame, result: { kind: 'none' } }), delay);
    });

    const client = new BridgeClient('127.0.0.1', port, 2_000);
    await client.connect();

    const [slow, fast] = await Promise.all([
      client.send({ op: 'status' }),
      client.send({ op: 'advance', frames: 1 }),
    ]);

    assert.equal(slow.ok && slow.frame, 100);
    assert.equal(fast.ok && fast.frame, 200);

    await client.close();
  });

  it('handles a response split across TCP chunks', async () => {
    const port = await startFakeBridge((request, socket) => {
      const payload = JSON.stringify({ id: request.id, ok: true, frame: 7, result: { kind: 'none' } });
      socket.write(payload.slice(0, 10));
      setTimeout(() => socket.write(`${payload.slice(10)}\n`), 20);
    });

    const client = new BridgeClient('127.0.0.1', port, 2_000);
    await client.connect();

    const response = await client.send({ op: 'status' });
    assert.equal(response.ok && response.frame, 7);

    await client.close();
  });

  it('surfaces an error response instead of hanging', async () => {
    const port = await startFakeBridge((request, socket) => {
      reply(socket, {
        id: request.id,
        ok: false,
        error: { code: 'no_such_savestate', message: 'unknown label' },
      });
    });

    const client = new BridgeClient('127.0.0.1', port, 2_000);
    await client.connect();

    const response = await client.send({ op: 'loadState', label: 'missing' });
    assert.equal(response.ok, false);
    assert.equal(!response.ok && response.error.code, 'no_such_savestate');

    await client.close();
  });

  it('times out rather than waiting forever for a silent bridge', async () => {
    const port = await startFakeBridge(() => {});

    const client = new BridgeClient('127.0.0.1', port, 100);
    await client.connect();

    await assert.rejects(() => client.send({ op: 'status' }), /did not answer status/);
    await client.close();
  });

  it('fails outstanding requests when the bridge sends garbage', async () => {
    const port = await startFakeBridge((_request, socket) => {
      socket.write('this is not json\n');
    });

    const client = new BridgeClient('127.0.0.1', port, 2_000);
    await client.connect();

    await assert.rejects(() => client.send({ op: 'status' }), /not JSON/);
    await client.close();
  });

  it('reports a refused connection clearly', async () => {
    // Port 1 is reserved and never listening in this environment.
    const client = new BridgeClient('127.0.0.1', 1, 500);
    await assert.rejects(() => client.connect(), /Bridge connection failed|timed out/i);
  });
});
