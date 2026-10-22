/**
 * Broker MQTT di test (solo verifica locale, non parte dell'app).
 * - WebSocket MQTT su ws://127.0.0.1:9001/mqtt
 * - API HTTP di controllo su http://127.0.0.1:9002 per publish e lettura comandi
 */
import { createServer } from 'node:http';

import aedesFactory from 'aedes';
import websocketStream from 'websocket-stream';

const broker = aedesFactory();
const received = [];

const wsHttp = createServer();
websocketStream.createServer({ server: wsHttp, path: '/mqtt' }, broker.handle);

broker.on('publish', (packet, client) => {
  if (!client) return; // messaggi interni/retained
  received.push({
    topic: packet.topic,
    payload: packet.payload.toString(),
    at: Date.now(),
  });
});

const control = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:9002');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/health') {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === '/commands') {
    res.end(JSON.stringify(received));
    return;
  }
  if (url.pathname === '/publish') {
    const topic = url.searchParams.get('topic');
    const payload = url.searchParams.get('payload') ?? '';
    const retain = url.searchParams.get('retain') === '1';
    if (!topic) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'topic mancante' }));
      return;
    }
    broker.publish({ topic, payload: Buffer.from(payload), qos: 0, retain }, () => {
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

wsHttp.listen(9001, '127.0.0.1', () => console.log('broker-ready 9001'));
control.listen(9002, '127.0.0.1', () => console.log('control-ready 9002'));

const shutdown = () => {
  broker.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
