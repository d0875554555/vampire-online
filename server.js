const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const WORLD_W = 8000, WORLD_H = 8000;
const TICK_RATE = 20;
const DT = 1 / TICK_RATE;

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  let ext = path.extname(filePath);
  let ct = 'text/html';
  if (ext === '.js') ct = 'text/javascript';
  else if (ext === '.css') ct = 'text/css';
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); }
    else { res.writeHead(200, { 'Content-Type': ct }); res.end(content); }
  });
});

const wss = new WebSocket.Server({ server });

let players = {}, sockets = {}, enemies = [], bullets = [], enemyBullets = [], orbs = [];
let elapsed = 0, spawnTimer = 0, bossTimer = 40, killCount = 0, nextEnemyId = 1, nextBulletId = 1;

const ENEMY_STATS = {
  normal: { r: 12, hp: 20, speed: 70, dmg: 8, color: '#e63946', xp: 10 },
  fast:   { r: 8,  hp: 10, speed: 150, dmg: 5, color: '#f4a261', xp: 8 },
  tank:   { r: 20, hp: 80, speed: 38, dmg: 16, color: '#7209b7', xp: 20 },
  ranged: { r: 11, hp: 16, speed: 55, dmg: 6, color: '#2a9d8f', xp: 14 },
  boss:   { r: 34, hp: 800, speed: 35, dmg: 26, color: '#ff006e', xp: 150 }
};

const skillPool = [
  { id: 'dmg', name: 'พลังโจมตี', icon: '🗡️', apply: p => { p.dmg += 5; } },
  { id: 'fireRate', name: 'ความเร็วยิง', icon: '⚡', apply: p => { p.fireRate = Math.max(0.08, p.fireRate * 0.85); } },
  { id: 'speed', name: 'ความเร็วเดิน', icon: '👟', apply: p => { p.speed += 15; } },
  { id: 'maxhp', name: 'พลังชีวิตสูงสุด', icon: '❤️', apply: p => { p.maxHp += 20; p.hp = Math.min(p.maxHp, p.hp + 20); } },
  { id: 'range', name: 'ระยะตรวจจับ', icon: '🎯', apply: p => { p.range += 80; } },
  { id: 'multishot', name: 'ยิงหลายทาง', icon: '✴️', cond: p => p.projectileCount < 6, apply: p => { p.projectileCount = Math.min(6, p.projectileCount + 1); } },
  { id: 'pierce', name: 'กระสุนทะลุ', icon: '🌀', cond: p => p.pierce < 5, apply: p => { p.pierce = Math.min(5, p.pierce + 1); } },
  { id: 'heal', name: 'ฮีลทันที', icon: '💚', apply: p => { p.hp = Math.min(p.maxHp, p.hp + (p.maxHp - p.hp) * 0.5); } },
  { id: 'orbit', name: 'ใบมีดหมุน', icon: '🌪️', cond: p => p.orbitCount < 6, apply: p => { p.orbitCount = Math.min(6, p.orbitCount + 1); } },
  { id: 'orbitdmg', name: 'พลังใบมีด', icon: '💥', cond: p => p.orbitCount > 0, apply: p => { p.orbitDamage += 5; } },
  { id: 'magnet', name: 'แม่เหล็กดูดของ', icon: '🧲', apply: p => { p.magnetRadius += 100; } }
];

function makePlayer(id, name) {
  return {
    id, name, x: WORLD_W / 2 + Math.random() * 100 - 50, y: WORLD_H / 2 + Math.random() * 100 - 50,
    r: 14, hp: 100, maxHp: 100, speed: 180, dmg: 10, fireRate: 0.5, lastShot: 0,
    level: 1, xp: 0, xpNext: 20, range: 380, projectileCount: 1, pierce: 0,
    orbitCount: 0, orbitDamage: 8, orbitRadius: 70, orbitAngle: 0, magnetRadius: 120,
    inputDx: 0, inputDy: 0, alive: true, pendingLevelUps: 0
  };
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const id in sockets) if (sockets[id].readyState === WebSocket.OPEN) sockets[id].send(msg);
}
function sendTo(id, obj) {
  if (sockets[id] && sockets[id].readyState === WebSocket.OPEN) sockets[id].send(JSON.stringify(obj));
}
function nearestPlayer(x, y) {
  let best = null, bd = Infinity;
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function pickEnemyType() {
  let pool = ['normal', 'normal', 'normal'];
  if (elapsed > 10) pool.push('fast', 'fast');
  if (elapsed > 25) pool.push('ranged');
  if (elapsed > 45) pool.push('tank');
  return pool[Math.floor(Math.random() * pool.length)];
}
function spawnEnemy(type, anchor) {
  const s = ENEMY_STATS[type];
  const angle = Math.random() * Math.PI * 2;
  const dist = 600 + Math.random() * 300;
  let x = anchor.x + Math.cos(angle) * dist, y = anchor.y + Math.sin(angle) * dist;
  x = Math.max(s.r, Math.min(WORLD_W - s.r, x));
  y = Math.max(s.r, Math.min(WORLD_H - s.r, y));
  const hpBoost = 1 + elapsed / 35;
  enemies.push({ id: nextEnemyId++, type, x, y, r: s.r, hp: s.hp * hpBoost, maxHp: s.hp * hpBoost, speed: s.speed, dmg: s.dmg, color: s.color, xp: s.xp, shootTimer: type === 'ranged' ? Math.random() * 2 : 0 });
}
function spawnBoss() {
  const any = Object.values(players)[0];
  if (!any) return;
  spawnEnemy('boss', any);
  broadcast({ t: 'bossAlert' });
}
function killEnemy(e) {
  killCount++;
  if (Math.random() < 0.08) orbs.push({ x: e.x, y: e.y, value: 20, heal: true });
  else orbs.push({ x: e.x, y: e.y, value: e.xp, heal: false });
}
function checkLevelUp(p) {
  let leveled = false;
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext; p.level++; p.xpNext = Math.floor(p.xpNext * 1.25);
    p.pendingLevelUps++; leveled = true;
  }
  if (leveled) offerLevelUp(p);
}
function offerLevelUp(p) {
  const avail = skillPool.filter(s => !s.cond || s.cond(p));
  const shuffled = [...avail].sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, 3).map(s => ({ id: s.id, name: s.name, icon: s.icon }));
  sendTo(p.id, { t: 'levelup', d: { options: picks } });
}

wss.on('connection', (ws) => {
  let myId = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'join') {
      myId = 'p' + Math.random().toString(36).slice(2, 9);
      const name = (m.d && m.d.name ? m.d.name : 'Player').slice(0, 16);
      players[myId] = makePlayer(myId, name);
      sockets[myId] = ws;
      sendTo(myId, { t: 'joined', d: { id: myId, world: { w: WORLD_W, h: WORLD_H } } });
    } else if (m.t === 'input' && myId && players[myId]) {
      players[myId].inputDx = m.d.dx || 0;
      players[myId].inputDy = m.d.dy || 0;
    } else if (m.t === 'skillPick' && myId && players[myId]) {
      const p = players[myId];
      const skill = skillPool.find(s => s.id === m.d.id);
      if (skill && (!skill.cond || skill.cond(p))) skill.apply(p);
      p.pendingLevelUps--;
      if (p.pendingLevelUps > 0) offerLevelUp(p);
    }
  });
  ws.on('close', () => { if (myId) { delete players[myId]; delete sockets[myId]; } });
});

setInterval(() => {
  elapsed += DT;
  spawnTimer -= DT;
  const spawnInterval = Math.max(0.3, 1.2 - elapsed * 0.01);
  if (spawnTimer <= 0 && Object.keys(players).length > 0) {
    const list = Object.values(players);
    spawnEnemy(pickEnemyType(), list[Math.floor(Math.random() * list.length)]);
    spawnTimer = spawnInterval;
  }
  bossTimer -= DT;
  if (bossTimer <= 0 && Object.keys(players).length > 0) { spawnBoss(); bossTimer = 55 + Math.random() * 20; }

  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    const len = Math.hypot(p.inputDx, p.inputDy) || 1;
    if (p.inputDx !== 0 || p.inputDy !== 0) {
      p.x += (p.inputDx / len) * p.speed * DT;
      p.y += (p.inputDy / len) * p.speed * DT;
      p.x = Math.max(p.r, Math.min(WORLD_W - p.r, p.x));
      p.y = Math.max(p.r, Math.min(WORLD_H - p.r, p.y));
    }
    p.lastShot -= DT;
    if (p.lastShot <= 0) {
      let target = null, bd = Infinity;
      for (const e of enemies) { const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2; if (d < bd) { bd = d; target = e; } }
      if (target && Math.sqrt(bd) < p.range) {
        const baseAng = Math.atan2(target.y - p.y, target.x - p.x);
        const count = p.projectileCount, spread = Math.PI / 9, startOff = -((count - 1) / 2) * spread;
        for (let i = 0; i < count; i++) {
          const ang = baseAng + startOff + i * spread;
          bullets.push({ id: nextBulletId++, owner: id, x: p.x, y: p.y, vx: Math.cos(ang) * 400, vy: Math.sin(ang) * 400, dmg: p.dmg, r: 5, life: 1.5, pierceLeft: p.pierce, hitList: [] });
        }
        p.lastShot = p.fireRate;
      }
    }
    p.orbitAngle += DT * 3;
    if (p.orbitCount > 0) {
      for (let i = 0; i < p.orbitCount; i++) {
        const ang = p.orbitAngle + i * (Math.PI * 2 / p.orbitCount);
        const bx = p.x + Math.cos(ang) * p.orbitRadius, by = p.y + Math.sin(ang) * p.orbitRadius;
        for (let j = enemies.length - 1; j >= 0; j--) {
          const e = enemies[j];
          if (Math.hypot(bx - e.x, by - e.y) < 12 + e.r) {
            e.hp -= p.orbitDamage * DT;
            if (e.hp <= 0) { killEnemy(e); enemies.splice(j, 1); }
          }
        }
      }
    }
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * DT; b.y += b.vy * DT; b.life -= DT;
    if (b.life <= 0) { bullets.splice(i, 1); continue; }
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (b.hitList.includes(e.id)) continue;
      if (Math.hypot(b.x - e.x, b.y - e.y) < b.r + e.r) {
        e.hp -= b.dmg; b.hitList.push(e.id);
        if (e.hp <= 0) {
          killEnemy(e);
          const owner = players[b.owner];
          if (owner) { owner.xp += e.xp; checkLevelUp(owner); }
          enemies.splice(j, 1);
        }
        if (b.pierceLeft <= 0) bullets.splice(i, 1); else b.pierceLeft--;
        break;
      }
    }
  }

  for (const e of enemies) {
    const target = nearestPlayer(e.x, e.y);
    if (target) {
      const ang = Math.atan2(target.y - e.y, target.x - e.x);
      e.x += Math.cos(ang) * e.speed * DT; e.y += Math.sin(ang) * e.speed * DT;
      const d = Math.hypot(target.x - e.x, target.y - e.y);
      if (d < target.r + e.r) target.hp -= e.dmg * DT;
      if (e.type === 'ranged') {
        e.shootTimer -= DT;
        if (e.shootTimer <= 0 && d < 450) {
          const sAng = Math.atan2(target.y - e.y, target.x - e.x);
          enemyBullets.push({ x: e.x, y: e.y, vx: Math.cos(sAng) * 220, vy: Math.sin(sAng) * 220, dmg: e.dmg, r: 5, life: 3 });
          e.shootTimer = 2 + Math.random();
        }
      }
    }
  }

  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i];
    b.x += b.vx * DT; b.y += b.vy * DT; b.life -= DT;
    if (b.life <= 0) { enemyBullets.splice(i, 1); continue; }
    for (const id in players) {
      const p = players[id];
      if (!p.alive) continue;
      if (Math.hypot(b.x - p.x, b.y - p.y) < p.r + b.r) { p.hp -= b.dmg; enemyBullets.splice(i, 1); break; }
    }
  }

  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i]; let taken = false;
    for (const id in players) {
      const p = players[id];
      if (!p.alive) continue;
      const d = Math.hypot(p.x - o.x, p.y - o.y);
      if (d < p.magnetRadius) {
        const ang = Math.atan2(p.y - o.y, p.x - o.x);
        o.x += Math.cos(ang) * 250 * DT; o.y += Math.sin(ang) * 250 * DT;
      }
      if (d < p.r + 6) {
        if (o.heal) p.hp = Math.min(p.maxHp, p.hp + o.value);
        else { p.xp += o.value; checkLevelUp(p); }
        taken = true; break;
      }
    }
    if (taken) orbs.splice(i, 1);
  }

  for (const id in players) {
    const p = players[id];
    if (p.alive && p.hp <= 0) {
      p.alive = false;
      sendTo(id, { t: 'dead', d: { elapsed: Math.floor(elapsed), level: p.level, kills: killCount } });
    }
  }

  broadcast({
    t: 'state',
    d: {
      elapsed: Math.floor(elapsed), kills: killCount,
      players: Object.values(players).map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, level: p.level, xp: p.xp, xpNext: p.xpNext, orbitCount: p.orbitCount, orbitAngle: p.orbitAngle, orbitRadius: p.orbitRadius, alive: p.alive, dmg: p.dmg, projectileCount: p.projectileCount, pierce: p.pierce })),
      enemies: enemies.map(e => ({ id: e.id, type: e.type, x: e.x, y: e.y, r: e.r, hp: e.hp, maxHp: e.maxHp, color: e.color })),
      bullets: bullets.map(b => ({ x: b.x, y: b.y, r: b.r })),
      enemyBullets: enemyBullets.map(b => ({ x: b.x, y: b.y, r: b.r })),
      orbs: orbs.map(o => ({ x: o.x, y: o.y, heal: o.heal }))
    }
  });
}, 1000 / TICK_RATE);

server.listen(process.env.PORT || 8080, () => {
  console.log('Vampire Online server running on port ' + (process.env.PORT || 8080));
});