// Temporary stand-in so Compose can start the service; replaced by Next.js in 1.5.
import { createServer } from 'node:http';
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('dashboard placeholder\n');
}).listen(3000, '0.0.0.0');
