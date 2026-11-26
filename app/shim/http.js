// node:http for the page. createServer() keeps the companion's request handler;
// the page's fetch('/api/...') and EventSource('/api/events') call it directly
// (see request/subscribe), so no network is involved.
import { EventEmitter } from 'events';
import { rt } from './runtime.js';

function makeReq(method, url, body) {
  const req = new EventEmitter();
  Object.assign(req, {
    method,
    url,
    headers: { host: '127.0.0.1:7331', 'content-type': 'application/json', 'user-agent': navigator.userAgent },
    async *[Symbol.asyncIterator]() {
      if (body) yield body;
    },
  });
  return req;
}

function makeRes(onWrite, onEnd) {
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 200,
    headers: {},
    writeHead(status, headers) {
      res.statusCode = status;
      Object.assign(res.headers, headers);
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
    },
    write(chunk) {
      onWrite?.(String(chunk));
      return true;
    },
    end(chunk) {
      onEnd?.(chunk == null ? '' : String(chunk), res);
    },
  });
  return res;
}

export function createServer(handler) {
  const server = new EventEmitter();
  server.listen = (port, host, cb) => {
    server.port = port;
    rt.server = server;
    setTimeout(() => cb?.());
    return server;
  };
  server.address = () => ({ port: server.port, address: '127.0.0.1' });
  server.close = () => server.emit('close');
  /** One API call: resolves { status, body }. */
  server.request = (method, url, body) =>
    new Promise((resolve) => {
      const res = makeRes(null, (data, r) => resolve({ status: r.statusCode, body: data }));
      Promise.resolve(handler(makeReq(method, url, body), res)).catch((e) => resolve({ status: 500, body: JSON.stringify({ error: e.message }) }));
    });
  /** The event stream: onChunk gets raw SSE text. Returns a function that closes it. */
  server.subscribe = (url, onChunk) => {
    const req = makeReq('GET', url, '');
    const res = makeRes(onChunk, null);
    handler(req, res);
    return () => req.emit('close');
  };
  return server;
}
export default { createServer };
