/**
 * Relay Server — intermediário entre o app Android e a página web de controle.
 * Nenhum dos dois precisa de IP público nem estar na mesma rede: os dois fazem
 * conexões DE SAÍDA para este servidor (que sim precisa de IP público / domínio).
 *
 * Fluxo:
 *  1. App conecta e se registra:      {"role":"device","deviceId":"abc123","pin":"482913"}
 *  2. Navegador conecta e entra:      {"role":"controller","deviceId":"abc123","pin":"482913"}
 *  3. Servidor valida o PIN e vincula as duas conexões.
 *  4. Frames de tela (binário) fluem device -> controller.
 *     Comandos de toque (JSON texto) fluem controller -> device.
 *
 * Deploy: Render, Railway, Fly.io, ou qualquer VPS com Node 18+.
 * Essas plataformas já entregam HTTPS/WSS automaticamente — o app deve
 * conectar em wss://seu-app.onrender.com (não ws://).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', devicesOnline: devices.size }));
    return;
  }

  // Serve a própria página de controle (painel web) direto deste servidor,
  // assim dá pra acessar o painel por um link, de qualquer aparelho,
  // sem precisar abrir um arquivo .html local.
  if (req.url === '/' || req.url === '/control.html') {
    const filePath = path.join(PUBLIC_DIR, 'control.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end('Não foi possível carregar a página de controle.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  res.writeHead(404);
  res.end('Não encontrado.');
});

const wss = new WebSocket.Server({ server });

// deviceId -> { socket, pin, controller }
const devices = new Map();

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
}

wss.on('connection', (ws) => {
  let registered = null; // { role, deviceId }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    // Frames de vídeo (binário) só existem depois de registrado como device
    if (isBinary) {
      if (registered && registered.role === 'device') {
        const entry = devices.get(registered.deviceId);
        if (entry && entry.controller) {
          entry.controller.send(data, { binary: true });
        }
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return; // ignora mensagens inválidas
    }

    // --- Registro inicial ---
    if (!registered) {
      if (msg.role === 'device' && msg.deviceId && msg.pin) {
        const existing = devices.get(msg.deviceId);
        if (existing && existing.socket && existing.socket.readyState === WebSocket.OPEN) {
          existing.socket.close(4000, 'replaced'); // nova sessão do mesmo deviceId substitui a antiga
        }
        devices.set(msg.deviceId, { socket: ws, pin: msg.pin, controller: null });
        registered = { role: 'device', deviceId: msg.deviceId };
        safeSend(ws, { type: 'registered' });
        return;
      }

      if (msg.role === 'controller' && msg.deviceId && msg.pin) {
        const entry = devices.get(msg.deviceId);
        if (!entry) {
          safeSend(ws, { type: 'error', message: 'device-offline' });
          ws.close(4004, 'device-offline');
          return;
        }
        if (entry.pin !== msg.pin) {
          safeSend(ws, { type: 'error', message: 'wrong-pin' });
          ws.close(4003, 'wrong-pin');
          return;
        }
        if (entry.controller && entry.controller.readyState === WebSocket.OPEN) {
          safeSend(ws, { type: 'error', message: 'already-controlled' });
          ws.close(4009, 'already-controlled');
          return;
        }
        entry.controller = ws;
        registered = { role: 'controller', deviceId: msg.deviceId };
        safeSend(ws, { type: 'connected' });
        safeSend(entry.socket, { type: 'controller-status', connected: true });
        return;
      }

      return; // mensagem de registro inválida
    }

    // --- Mensagens após registrado ---
    if (registered.role === 'controller') {
      // comandos de toque / teclas / qualidade -> repassa pro device
      const entry = devices.get(registered.deviceId);
      if (entry) safeSend(entry.socket, data.toString());
    } else if (registered.role === 'device') {
      // mensagens de texto do device (ex: device-info, battery) -> repassa pro controller
      const entry = devices.get(registered.deviceId);
      if (entry && entry.controller) safeSend(entry.controller, data.toString());
    }
  });

  ws.on('close', () => {
    if (!registered) return;
    const entry = devices.get(registered.deviceId);
    if (!entry) return;

    if (registered.role === 'device' && entry.socket === ws) {
      if (entry.controller) safeSend(entry.controller, { type: 'device-offline' });
      devices.delete(registered.deviceId);
    } else if (registered.role === 'controller' && entry.controller === ws) {
      entry.controller = null;
      safeSend(entry.socket, { type: 'controller-status', connected: false });
    }
  });
});

// Ping/pong a cada 30s para derrubar conexões mortas (comum em redes móveis)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Relay server ouvindo na porta ${PORT}`);
});
