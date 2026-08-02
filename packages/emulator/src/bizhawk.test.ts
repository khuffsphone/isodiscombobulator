import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { after, describe, it } from 'node:test';

import type { BridgeRequest, EmulatorStatus } from '@romlab/schema';

import { BizHawkAdapter } from './bizhawk.js';

const servers: Server[] = [];

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const ROM = 'a'.repeat(64);

/**
 * Stands in for the C# external tool. The adapter's identity and version gates
 * are the part of BizHawk integration that can be verified without Windows, and
 * they are the part that decides whether a capture counts as evidence.
 */
async function startBridge(status: Partial<EmulatorStatus>): Promise<number> {
  const full: EmulatorStatus = {
    emulator: 'BizHawk',
    emulatorVersion: '2.9.1',
    core: 'Genplus-gx',
    romSha256: ROM,
    frame: 0,
    paused: true,
    ...status,
  };

  const server = createServer((socket: Socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const request = JSON.parse(line) as BridgeRequest;
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              frame: full.frame,
              result: { kind: 'status', status: full },
            })}\n`,
          );
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {});
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

describe('BizHawk adapter identity gates', () => {
  it('connects when the bridge reports the expected ROM', async () => {
    const port = await startBridge({});
    const adapter = new BizHawkAdapter({ port, host: '127.0.0.1' });

    const status = await adapter.connect({ romPath: '/roms/x.bin', romSha256: ROM, timeoutMs: 2_000 });
    assert.equal(status.romSha256, ROM);

    await adapter.disconnect();
  });

  it('refuses a bridge that reports a different ROM', async () => {
    const port = await startBridge({ romSha256: 'b'.repeat(64) });
    const adapter = new BizHawkAdapter({ port, host: '127.0.0.1' });

    await assert.rejects(
      () => adapter.connect({ romPath: '/roms/x.bin', romSha256: ROM, timeoutMs: 2_000 }),
      /Refusing to attribute captures to the wrong cartridge/,
    );
  });

  it('distinguishes "unknown ROM" from "wrong ROM" and says how to fix it', async () => {
    // ApiHawk cannot report the loaded ROM's path, so a bridge started outside
    // ROMLab has no ROMLAB_ROM_PATH and reports an empty hash.
    const port = await startBridge({ romSha256: '', gameName: 'Some Cartridge (JUE)' });
    const adapter = new BizHawkAdapter({ port, host: '127.0.0.1' });

    await assert.rejects(
      () => adapter.connect({ romPath: '/roms/x.bin', romSha256: ROM, timeoutMs: 2_000 }),
      (error: Error) =>
        /could not determine which ROM is loaded/.test(error.message) &&
        /ROMLAB_ROM_PATH/.test(error.message) &&
        /Some Cartridge \(JUE\)/.test(error.message),
    );
  });

  it('refuses an unpinned emulator version', async () => {
    const port = await startBridge({ emulatorVersion: '2.10.0' });
    const adapter = new BizHawkAdapter({ port, host: '127.0.0.1', expectedVersion: '2.9.1' });

    await assert.rejects(
      () => adapter.connect({ romPath: '/roms/x.bin', romSha256: ROM, timeoutMs: 2_000 }),
      /not comparable/,
    );
  });

  it('refuses an unpinned core', async () => {
    const port = await startBridge({ core: 'PicoDrive' });
    const adapter = new BizHawkAdapter({ port, host: '127.0.0.1', expectedCore: 'Genplus-gx' });

    await assert.rejects(
      () => adapter.connect({ romPath: '/roms/x.bin', romSha256: ROM, timeoutMs: 2_000 }),
      /pinned to core/,
    );
  });

  it('refuses to send commands before connecting', async () => {
    const adapter = new BizHawkAdapter({ port: 1 });
    await assert.rejects(() => adapter.send({ op: 'status' }), /not connected/);
  });
});
