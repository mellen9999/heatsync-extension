import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A local wss server that speaks just enough IRC for the extension's twitch
 * transport: the handshake, the join, and — the part that matters — echoing
 * your own PRIVMSG back the way twitch does, which is what actually puts a
 * sent message on screen.
 *
 * Shared by every check that needs a live twitch chat. It is the one piece of
 * this harness that makes the whole twitch loop testable with no network at
 * all: irc-ws.chat.twitch.tv is pointed at 127.0.0.1 with
 * --host-resolver-rules, so twitch is never contacted.
 *
 * Returns null when openssl is missing — there is no cert to serve TLS with,
 * and the caller has to say out loud what is going unverified rather than
 * quietly passing.
 */
export function startMockIrc(): {
  port: number
  frames: string[]
  push: (raw: string) => void
  stop: () => void
} | null {
  const certDir = mkdtempSync(join(tmpdir(), 'hs-ext-irc-cert-'))
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
       '-days', '1', '-nodes', '-subj', '/CN=irc-ws.chat.twitch.tv'],
      { stdio: 'ignore' },
    )
  } catch (_) {
    rmSync(certDir, { recursive: true, force: true })
    return null
  }

  const frames: string[] = []
  const sockets = new Set<any>()
  const server = Bun.serve({
    port: 0,
    tls: { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
    fetch(req: Request, srv: any) {
      if (srv.upgrade(req)) return undefined as any
      return new Response('no', { status: 400 })
    },
    websocket: {
      open(ws: any) {
        sockets.add(ws)
      },
      close(ws: any) {
        sockets.delete(ws)
      },
      message(ws: any, msg: any) {
        for (const line of String(msg).split('\r\n')) {
          if (!line) continue
          frames.push(line)
          if (line.startsWith('NICK')) {
            ws.send(`:tmi.twitch.tv 001 ${line.slice(5).trim() || 'probeuser'} :Welcome, GLOBALUSERSTATE\r\n`)
          } else if (line.startsWith('JOIN')) {
            ws.send(`:probeuser!p@p.tmi.twitch.tv JOIN ${line.slice(5).trim()}\r\n`)
          } else if (line.startsWith('PRIVMSG')) {
            // Twitch echoes your own PRIVMSG back; that echo is what renders it.
            const m = line.match(/^PRIVMSG (#\S+) :(.*)$/)
            if (m) {
              const echo =
                `@display-name=probeuser;color=#FF8700;user-id=1;id=echo-1 ` +
                `:probeuser!p@p.tmi.twitch.tv PRIVMSG ${m[1]} :${m[2]}\r\n`
              for (const c of sockets) {
                try {
                  c.send(echo)
                } catch (_) {}
              }
            }
          }
        }
      },
    },
  })

  return {
    port: server.port,
    frames,
    push(raw: string) {
      for (const c of sockets) {
        try {
          c.send(raw)
        } catch (_) {}
      }
    },
    stop() {
      server.stop(true)
      rmSync(certDir, { recursive: true, force: true })
    },
  }
}
