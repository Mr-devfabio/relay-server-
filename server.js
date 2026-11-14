/**
 * Relay Server — intermediário entre o app Android e a página web de controle.
 * Nenhum dos dois precisa de IP público nem estar na mesma rede: os dois fazem
 * conexões DE SAÍDA para este servidor (que sim precisa de IP público / domínio).
 *
 * Fluxo:
 *  1. App conecta e se registra:
 *       {"role":"device","deviceId":"abc123","pin":"482913",
 *        "model":"samsung SM-G991B","phone":"+5511999998888","alias":"joao-celular"}
 *  2. Navegador conecta e entra (por deviceId OU identifier):
 *       {"role":"controller","deviceId":"abc123","pin":"482913"}
 *       {"role":"controller","identifier":"joao-celular","pin":"482913"}
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

// deviceId -> { socket, pin, model, phone, alias, controller }
const devices = new Map();
// chave lowercase -> deviceId  (aceita deviceId, model, phone, phone-digits, alias)
const identityIndex = new Map();

// ---------------------------------------------------------------------------
// Índice de identidades
// ---------------------------------------------------------------------------

function indexIdentities(deviceId, { model, phone, alias }) {
  const keys = new Set();
  const push = (v) => {
    if (!v) return;
    const k = String(v).toLowerCase().trim();
    if (k) keys.add(k);
  };

  push(deviceId);
  push(model);
  push(phone);
  push(alias);
  if (phone) {
    const digits = String(phone).replace(/[^0-9]/g, '');
    if (digits) keys.add(digits);
  }

  for (const k of keys) identityIndex.set(k, deviceId);
  return keys; // devolvemos para poder limpar no disconnect
}

function clearIdentities(keys) {
  if (!keys) return;
  for (const k of keys) {
    if (identityIndex.get(k) === undefined) continue;
    identityIndex.delete(k);
  }
}

function resolveIdentifier(identifier) {
  if (!identifier) return null;
  const q = String(identifier).toLowerCase().trim();
  if (!q) return null;
  // 1) match direto
  const direct = identityIndex.get(q);
  if (direct) return direct;
  // 2) se for telefone com máscara, tenta só dígitos
  const digits = q.replace(/[^0-9]/g, '');
  if (digits) {
    const byDigits = identityIndex.get(digits);
    if (byDigits) return byDigits;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', devicesOnline: devices.size }));
    return;
  }

  if (req.url === '/devices') {
    const list = [];
    for (const [deviceId, entry] of devices.entries()) {
      const online = entry.socket && entry.socket.readyState === WebSocket.OPEN;
      if (!online) continue;
      list.push({
        deviceId,
        pin: entry.pin,
        model: entry.model || '',
        phone: entry.phone || '',
        alias: entry.alias || '',
        beingControlled: !!(entry.controller && entry.controller.readyState === WebSocket.OPEN)
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ devices: list }));
    return;
  }

  if (req.url === '/' || req.url === '/control.html') {
    const filePath = path.join(PUBLIC_DIR, 'control.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        console.error('Falha ao ler control.html em', filePath, err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(
          'Não foi possível carregar a página de controle.\n' +
          'O servidor não encontrou o arquivo public/control.html.\n' +
          'Verifique se essa pasta foi enviada junto no deploy.'
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Não encontrado.');
});

const wss = new WebSocket.Server({ server });

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  let registered = null; // { role, deviceId, identityKeys? }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    // Frames binários: só device envia, e só se houver controller.
    if (isBinary) {
      if (registered && registered.role === 'device') {
        const entry = devices.get(registered.deviceId);
        if (entry && entry.controller
            && entry.controller.readyState === WebSocket.OPEN) {
          entry.controller.send(data, { binary: true });
        }
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    // -----------------------------------------------------------------
    // Registro inicial
    // -----------------------------------------------------------------
    if (!registered) {
      if (msg.role === 'device' && msg.deviceId && msg.pin) {
        const existing = devices.get(msg.deviceId);
        if (existing && existing.socket
            && existing.socket.readyState === WebSocket.OPEN) {
          existing.socket.close(4000, 'replaced');
        }
        // Se o device estava registrado antes, limpa as chaves antigas
        if (existing && existing.identityKeys) {
          clearIdentities(existing.identityKeys);
        }

        const identityKeys = indexIdentities(msg.deviceId, {
          model: msg.model,
          phone: msg.phone,
          alias: msg.alias
        });

        devices.set(msg.deviceId, {
          socket: ws,
          pin: msg.pin,
          model: msg.model || '',
          phone: msg.phone || '',
          alias: msg.alias || '',
          controller: null,
          identityKeys
        });
        registered = { role: 'device', deviceId: msg.deviceId };
        safeSend(ws, { type: 'registered' });
        return;
      }

      if (msg.role === 'controller' && msg.pin) {
        // Aceita deviceId OU identifier
        let targetId = msg.deviceId;
        if (msg.identifier) {
          const resolved = resolveIdentifier(msg.identifier);
          if (resolved) targetId = resolved;
        }
        if (!targetId) {
          safeSend(ws, { type: 'error', message: 'device-offline' });
          ws.close(4004, 'device-offline');
          return;
        }

        const entry = devices.get(targetId);
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
        registered = { role: 'controller', deviceId: targetId };
        safeSend(ws, { type: 'connected', deviceId: targetId });
        safeSend(entry.socket, { type: 'controller-status', connected: true });
        return;
      }

      return;
    }

    // -----------------------------------------------------------------
    // Mensagens após registrado
    // -----------------------------------------------------------------
    if (registered.role === 'controller') {
      const entry = devices.get(registered.deviceId);
      if (entry && entry.socket
          && entry.socket.readyState === WebSocket.OPEN) {
        safeSend(entry.socket, data.toString());
      }
    } else if (registered.role === 'device') {
      const entry = devices.get(registered.deviceId);
      if (entry && entry.controller
          && entry.controller.readyState === WebSocket.OPEN) {
        safeSend(entry.controller, data.toString());
      }
    }
  });

  ws.on('close', () => {
    if (!registered) return;
    const entry = devices.get(registered.deviceId);
    if (!entry) return;

    if (registered.role === 'device' && entry.socket === ws) {
      if (entry.controller
          && entry.controller.readyState === WebSocket.OPEN) {
        safeSend(entry.controller, { type: 'device-offline' });
      }
      clearIdentities(entry.identityKeys);
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
