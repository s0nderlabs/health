import { describe, expect, test, afterEach } from 'bun:test'
import { IpcServer, IpcClient, type EventMsg } from '../src/ipc.js'
import { join } from 'path'
import { tmpdir } from 'os'

function sockPath(): string {
  return join(tmpdir(), `health-ipc-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
}

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

function makeServer(path: string, target = 'main') {
  const acked: number[] = []
  const disconnects: number[] = []
  const server = new IpcServer(path, {
    eventTarget: () => target,
    onAck: (id) => acked.push(id),
    onSubscriberConnected: () => {},
    onSubscriberDisconnected: () => disconnects.push(Date.now()),
    onRpc: async (method, params) => {
      if (method === 'echo') return { echoed: params }
      if (method === 'big') return { blob: 'x'.repeat(Number(params.size ?? 0)) }
      throw new Error(`no such method ${method}`)
    },
  })
  server.start()
  cleanup.push(() => server.stop())
  return { server, acked, disconnects }
}

function makeClient(path: string, session: string) {
  const received: EventMsg[] = []
  const client = new IpcClient(path, session, async (e) => {
    received.push(e)
  })
  cleanup.push(() => client.stop())
  return { client, received }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await Bun.sleep(20)
  }
}

describe('ipc server/client', () => {
  test('events reach the target session and get acked', async () => {
    const path = sockPath()
    const { server, acked } = makeServer(path)
    const { client, received } = makeClient(path, 'main')
    await client.connectLoop()
    await waitFor(() => server.hasSubscriber())

    const pushed = server.pushEvent({
      id: 42, class: 'recovery.brief', priority: 'info', dedupe_key: 'k',
      content: 'Recovery 55% (amber).', meta: { class: 'recovery.brief' }, created_at: new Date().toISOString(),
    })
    expect(pushed).toBe(true)
    await waitFor(() => received.length === 1 && acked.length === 1)
    expect(received[0].content).toContain('55%')
    expect(acked[0]).toBe(42)
  })

  test('non-target sessions get RPC but never events', async () => {
    const path = sockPath()
    const { server } = makeServer(path, 'main')
    const { client, received } = makeClient(path, 'sidecar')
    await client.connectLoop()
    await Bun.sleep(100)

    expect(server.hasSubscriber()).toBe(false)
    const pushed = server.pushEvent({
      id: 1, class: 'workout.card', priority: 'info', dedupe_key: 'k',
      content: 'x', meta: {}, created_at: new Date().toISOString(),
    })
    expect(pushed).toBe(false)
    expect(received.length).toBe(0)

    const result = await client.rpc<{ echoed: Record<string, unknown> }>('echo', { a: 1 })
    expect(result.echoed).toEqual({ a: 1 })
  })

  test('rpc errors propagate as rejections', async () => {
    const path = sockPath()
    makeServer(path)
    const { client } = makeClient(path, 'main')
    await client.connectLoop()
    await expect(client.rpc('does_not_exist')).rejects.toThrow('no such method')
  })

  test('a multi-MB frame round-trips intact (backpressure, no truncation)', async () => {
    const path = sockPath()
    makeServer(path)
    const { client } = makeClient(path, 'main')
    await client.connectLoop()
    // ~4MB payload: far exceeds any single socket buffer, forcing partial writes.
    const size = 4_000_000
    const result = await client.rpc<{ blob: string }>('big', { size }, 20_000)
    expect(result.blob.length).toBe(size)
    expect(result.blob).toBe('x'.repeat(size))
  })

  test('onSubscriberDisconnected fires only when the TARGET session drops', async () => {
    const path = sockPath()
    const { server, disconnects } = makeServer(path, 'main')
    const side = makeClient(path, 'sidecar')
    await side.client.connectLoop()
    await Bun.sleep(80)
    side.client.stop() // non-target drop: must NOT fire
    await Bun.sleep(120)
    expect(disconnects.length).toBe(0)

    const main = makeClient(path, 'main')
    await main.client.connectLoop()
    await waitFor(() => server.hasSubscriber())
    main.client.stop() // target drop: must fire
    await waitFor(() => disconnects.length === 1)
    expect(disconnects.length).toBe(1)
  })

  test('client reconnects after server restart and events resume', async () => {
    const path = sockPath()
    const first = makeServer(path)
    const { client, received } = makeClient(path, 'main')
    await client.connectLoop()
    await waitFor(() => first.server.hasSubscriber())

    first.server.stop()
    await Bun.sleep(100)

    const second = makeServer(path)
    await waitFor(() => second.server.hasSubscriber(), 5000)
    second.server.pushEvent({
      id: 7, class: 'system.health', priority: 'notable', dedupe_key: 'k7',
      content: 'back', meta: {}, created_at: new Date().toISOString(),
    })
    await waitFor(() => received.length === 1)
    expect(received[0].id).toBe(7)
  })
})
