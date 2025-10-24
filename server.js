import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> playerId

app.use(express.static(path.join(__dirname, "public")));

// Authoritative game state on server
const game = {
  players: {
    1: null,
    2: null
  },
  platforms: [
    { x: 200, y: 500, width: 400, height: 20 },
    { x: 100, y: 350, width: 200, height: 20 },
    { x: 500, y: 350, width: 200, height: 20 }
  ],
  effects: [],
  gravity: 0.5,
  attackCooldown: 20,
  specialCooldown: 60
};

// Helper to add effects with safety clamps to avoid runaway values
function addEffect(e) {
  const MAX_W = 800, MAX_H = 600;
  const effect = Object.assign({}, e);
  effect.x = Math.max(0, Math.min(MAX_W, Number(effect.x) || 0));
  effect.y = Math.max(0, Math.min(MAX_H, Number(effect.y) || 0));
  effect.velocityX = Number(effect.velocityX) || 0;
  effect.velocityY = Number(effect.velocityY) || 0;
  effect.size = Math.max(2, Math.min(200, Number(effect.size) || 10));
  effect.life = Math.max(1, Math.min(600, Number(effect.life) || 60));
  effect.damage = Number(effect.damage) || 0;
  game.effects.push(effect);
  return effect;
}
function createEmptyPlayer(id) {
  return {
    id,
    x: id === 1 ? 200 : 600,
    y: 300,
    width: 50,
    height: 80,
    velocityX: 0,
    velocityY: 0,
    lives: 3,
    damage: 0,
    color: id === 1 ? '#ff4444' : '#4444ff',
    direction: id === 1 ? 1 : -1,
    attackCooldown: 0,
    specialCooldown: 0,
    dashCooldown: 0,
    grabCooldown: 0,
    specialMeter: 0,
    invulnerable: 0,
    stunned: 0,
    controls: { left:false, right:false, up:false, attack:false, special:false, dash:false, grab:false },
    character: null,
    ready: false,
    action: null,
    actionTimer: 0
  };
}

function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(str);
  }
}

// Assign player IDs: first connection -> 1, second -> 2
wss.on('connection', (ws) => {
  let assigned = null;
  // find free slot
  if (!game.players[1]) {
    game.players[1] = createEmptyPlayer(1);
    clients.set(ws, 1);
    assigned = 1;
  } else if (!game.players[2]) {
    game.players[2] = createEmptyPlayer(2);
    clients.set(ws, 2);
    assigned = 2;
  } else {
    // spectator for now
    clients.set(ws, 0);
    assigned = 0;
  }

  ws.send(JSON.stringify({ type: 'assign', playerId: assigned }));

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch(e){ return; }
    const pid = clients.get(ws) || 0;

    if (data.type === 'input' && pid > 0 && game.players[pid]) {
      // update controls
      game.players[pid].controls = data.controls;
    }

    if (data.type === 'select' && pid > 0 && game.players[pid]) {
      game.players[pid].character = data.character;
      // apply simple character stats
      const c = data.character;
      if (c === 'ninja') {
        game.players[pid].moveSpeed = 7; game.players[pid].jumpForce = -13; game.players[pid].attackRange = 50;
        game.players[pid].color = '#ff4444';
      } else if (c === 'knight') {
        game.players[pid].moveSpeed = 5; game.players[pid].jumpForce = -11; game.players[pid].attackRange = 70;
        game.players[pid].color = '#4444ff';
      } else if (c === 'wizard') {
        game.players[pid].moveSpeed = 4; game.players[pid].jumpForce = -10; game.players[pid].attackRange = 40;
        game.players[pid].color = '#44ff44';
      }
      broadcast({ type: 'playerUpdate', players: sanitizePlayers() });
    }

    if (data.type === 'ready' && pid > 0 && game.players[pid]) {
      game.players[pid].ready = true;
      // if both ready and both present -> start
      if (game.players[1] && game.players[2] && game.players[1].ready && game.players[2].ready) {
        startServerMatch();
      }
    }
  });

  ws.on('close', () => {
    const pid = clients.get(ws);
    clients.delete(ws);
    if (pid && game.players[pid]) {
      // mark player slot empty
      game.players[pid] = null;
      // notify others
      broadcast({ type: 'playerLeft', playerId: pid });
    }
  });
});

function sanitizePlayers() {
  const out = {};
  for (const k of [1,2]) {
    const p = game.players[k];
    if (!p) { out[k] = null; continue; }
    out[k] = {
      id: p.id, x: p.x, y: p.y, width: p.width, height: p.height,
      velocityX: p.velocityX, velocityY: p.velocityY, lives: p.lives,
      damage: p.damage, color: p.color, direction: p.direction,
      specialMeter: p.specialMeter, invulnerable: p.invulnerable, stunned: p.stunned,
      action: p.action || null, actionTimer: p.actionTimer || 0,
      grabbedBy: p.grabbedBy || null, grabbedTimer: p.grabbedTimer || 0, holding: p.holding || null
    };
  }
  return out;
}

// Server-side game loop
let serverInterval = null;
function startServerMatch() {
  // reset state
  game.effects = [];
  for (const k of [1,2]) {
    if (game.players[k]) {
      game.players[k].x = k===1?200:600; game.players[k].y = 300;
      game.players[k].velocityX = 0; game.players[k].velocityY = 0;
      game.players[k].lives = 3; game.players[k].damage = 0; game.players[k].specialMeter = 0;
      game.players[k].invulnerable = 0; game.players[k].stunned = 0; game.players[k].attackCooldown = 0; game.players[k].specialCooldown = 0;
    }
  }
  broadcast({ type: 'matchStart', players: sanitizePlayers(), platforms: game.platforms });

  if (serverInterval) clearInterval(serverInterval);
  serverInterval = setInterval(() => {
    tickServer();
    // sanitize effects (remove direct owner references to avoid circular / large payloads)
    const sanitizedEffects = game.effects.map(e => {
      const copy = Object.assign({}, e);
      if (copy.owner && copy.owner.id) { copy.ownerId = copy.owner.id; }
      delete copy.owner;
      return copy;
    });
    broadcast({ type: 'state', players: sanitizePlayers(), effects: sanitizedEffects });
    // check for game over
    if (game.players[1] && game.players[2]) {
      if (game.players[1].lives <= 0 || game.players[2].lives <= 0) {
        const winner = (game.players[1].lives > 0) ? 1 : 2;
        broadcast({ type: 'matchEnd', winner });
        clearInterval(serverInterval);
        serverInterval = null;
      }
    }
  }, 1000/30);
}

function tickServer() {
  // update effects
  for (let i = game.effects.length -1; i>=0; i--) {
    const e = game.effects[i];
    e.x += (Number(e.velocityX) || 0);
    e.y += (Number(e.velocityY) || 0);
    if (e.life !== undefined) { e.life--; if (e.life<=0) { game.effects.splice(i,1); continue; } }
    // projectiles collision
    if (e.damage) {
      for (const k of [1,2]) {
        const p = game.players[k];
        if (!p) continue;
        if (e.owner === p) continue;
        if (e.x > p.x && e.x < p.x + p.width && e.y > p.y && e.y < p.y + p.height) {
          p.damage += Number(e.damage) || 0;
          const evx = Number(e.velocityX) || 0;
          p.velocityX = Math.sign(evx) * (10 + p.damage * 0.1);
          p.velocityY = -10;
          // clamp velocities to reasonable bounds
          const MAX_V = 60;
          p.velocityX = Math.max(-MAX_V, Math.min(MAX_V, p.velocityX));
          p.velocityY = Math.max(-MAX_V, Math.min(MAX_V, p.velocityY));
          p.stunned = 15;
          // reward owner
          if (e.owner) e.owner.specialMeter = Math.min(100, (e.owner.specialMeter||0) + (Number(e.damage)||0)*2);
          game.effects.splice(i,1);
          break;
        }
      }
    }
  }

  // update players
  for (const k of [1,2]) {
    const p = game.players[k];
    if (!p) continue;
    if (p.stunned > 0) { p.stunned--; continue; }
    if (p.invulnerable > 0) p.invulnerable--;
  if (p.dashCooldown > 0) p.dashCooldown--;
  if (p.grabCooldown > 0) p.grabCooldown--;

    const controls = p.controls || {};
    const mv = p.moveSpeed ?? 6;
    const jf = p.jumpForce ?? -12;

    if (controls.left && !controls.right) { p.velocityX = -mv; p.direction = -1; }
    else if (controls.right && !controls.left) { p.velocityX = mv; p.direction = 1; }
    else p.velocityX *= 0.8;

    // check on platform
    let onPlatform = false;
    for (const platform of game.platforms) {
      const feet = p.y + p.height;
      if (feet >= platform.y - 3 && feet <= platform.y + 10 && p.x + p.width > platform.x && p.x < platform.x + platform.width) { onPlatform = true; break; }
    }

    if (controls.up) {
      if (onPlatform) { p.velocityY = jf; p.canDoubleJump = true; }
      else if (p.canDoubleJump && !p.wasJumping) { p.velocityY = jf * 0.8; p.canDoubleJump = false; }
    }
    p.wasJumping = controls.up;

    if (p.attackCooldown > 0) p.attackCooldown--;
    if (p.specialCooldown > 0) p.specialCooldown--;

    // if player is grabbed, they cannot act; they will be positioned by their captor
    if (p.grabbedBy) {
      const holder = game.players[p.grabbedBy];
      if (holder) {
        // attach to holder position
        p.x = holder.x + (holder.direction===1 ? holder.width + 6 : -p.width - 6);
        p.y = holder.y + holder.height/2 - p.height/2;
        // decrement grabbed timer
        if (p.grabbedTimer !== undefined) {
          p.grabbedTimer--;
          if (p.grabbedTimer <= 0) {
            // release
            p.grabbedBy = null;
            holder.holding = null;
          }
        }
      } else {
        // holder disconnected
        p.grabbedBy = null;
      }
      // skip normal action processing for grabbed players
      continue;
    }

    // Dash (explicit input)
    if (controls.dash && p.dashCooldown === 0) {
      p.dashCooldown = 60; p.action = 'dash'; p.actionTimer = 18;
      p.velocityX = p.direction * Math.max(14, (p.moveSpeed||6)*2);
      p.invulnerable = 6;
    }

    if (controls.attack && p.attackCooldown === 0) {
      // if holding someone, release with small damage
      if (p.holding) {
        const hid = p.holding;
        const held = game.players[hid];
        if (held && held.grabbedBy === p.id) {
          p.attackCooldown = game.attackCooldown;
          p.action = 'release'; p.actionTimer = 10;
          // deal small damage and throw
          held.damage += 5;
          held.velocityX = p.direction * 8; held.velocityY = -6; held.stunned = 12;
          held.grabbedBy = null; held.grabbedTimer = 0;
          p.holding = null;
          p.specialMeter = Math.min(100, (p.specialMeter||0) + 6);
          // skip normal attack handling
          continue;
        }
      }
      p.attackCooldown = game.attackCooldown;
      // choose move variant based on character and whether airborne
      // determine if on ground (approx)
      let onPlatform = false;
      for (const platform of game.platforms) {
        const feet = p.y + p.height;
        if (feet >= platform.y - 3 && feet <= platform.y + 10 && p.x + p.width > platform.x && p.x < platform.x + platform.width) { onPlatform = true; break; }
      }

      if (onPlatform) {
        // ground attack / dash-attack
        if (Math.abs(p.velocityX) > (p.moveSpeed ?? 6) * 0.9) {
          // running dash attack
          p.action = 'dash'; p.actionTimer = 14;
          p.velocityX = p.direction * Math.max(12, (p.moveSpeed||6)*2);
          // small hitbox in front
          const ar = (p.attackRange ?? 60) * 0.7;
          const attackBox = { x: p.direction===1? p.x+p.width : p.x-ar, y: p.y+10, width: ar, height: p.height-20 };
          for (const j of [1,2]) {
            if (j===k) continue; const d = game.players[j]; if (!d) continue;
            if (attackBox.x < d.x + d.width && attackBox.x + attackBox.width > d.x && attackBox.y < d.y + d.height && attackBox.y + attackBox.height > d.y) {
              const dmg = (p.character === 'knight') ? 18 : (p.character === 'ninja' ? 12 : 10);
              d.damage += dmg; d.velocityX = p.direction * (10 + d.damage*0.1); d.velocityY = -8; d.stunned = 12;
              p.specialMeter = Math.min(100, (p.specialMeter||0) + 6);
            }
          }
        } else {
          // standing ground attack, character-specific
          if (p.character === 'knight') {
            p.action = 'attack_sword'; p.actionTimer = 16;
            const ar = (p.attackRange ?? 70) * 1.2;
            const attackBox = { x: p.direction===1? p.x+p.width : p.x-ar, y: p.y, width: ar, height: p.height };
            for (const j of [1,2]) {
              if (j===k) continue; const d = game.players[j]; if (!d) continue;
              if (attackBox.x < d.x + d.width && attackBox.x + attackBox.width > d.x && attackBox.y < d.y + d.height && attackBox.y + attackBox.height > d.y) {
                const dmg = 20; d.damage += dmg; d.velocityX = p.direction * (12 + d.damage*0.12); d.velocityY = -12; d.stunned = 16;
                p.specialMeter = Math.min(100, (p.specialMeter||0) + 8);
              }
            }
          } else if (p.character === 'ninja') {
            p.action = 'attack_katana'; p.actionTimer = 10;
            const ar = (p.attackRange ?? 50);
            const attackBox = { x: p.direction===1? p.x+p.width : p.x-ar, y: p.y+10, width: ar, height: p.height-20 };
            for (const j of [1,2]) {
              if (j===k) continue; const d = game.players[j]; if (!d) continue;
              if (attackBox.x < d.x + d.width && attackBox.x + attackBox.width > d.x && attackBox.y < d.y + d.height && attackBox.y + attackBox.height > d.y) {
                const dmg = 14; d.damage += dmg; d.velocityX = p.direction * (9 + d.damage*0.1); d.velocityY = -9; d.stunned = 10;
                p.specialMeter = Math.min(100, (p.specialMeter||0) + 6);
              }
            }
          } else if (p.character === 'wizard') {
            // wizard ground attack -> small fireball
            p.action = 'attack_fireball'; p.actionTimer = 14;
            addEffect({ type: 'fireball', x: p.x + (p.direction===1?p.width:-20), y: p.y + p.height/2, velocityX: p.direction*10, velocityY: 0, size: 12, color:'#ff7700', damage:10, life: 80, owner: p });
            p.specialMeter = Math.min(100, (p.specialMeter||0) + 4);
          } else {
            p.action = 'attack'; p.actionTimer = 12;
            const ar = p.attackRange ?? 60;
            const attackBox = { x: p.direction===1? p.x+p.width : p.x-ar, y: p.y, width: ar, height: p.height };
            for (const j of [1,2]) {
              if (j===k) continue; const d = game.players[j]; if (!d) continue;
              if (attackBox.x < d.x + d.width && attackBox.x + attackBox.width > d.x && attackBox.y < d.y + d.height && attackBox.y + attackBox.height > d.y) {
                const knockback = 10 + (d.damage * 0.2);
                d.velocityX = p.direction * knockback; d.velocityY = -knockback; d.damage += 10; d.stunned = 10;
                p.specialMeter = Math.min(100, (p.specialMeter||0) + 5);
              }
            }
          }
        }
      } else {
        // air attack variants
        p.action = 'air_attack'; p.actionTimer = 12;
        for (const j of [1,2]) {
          if (j===k) continue; const d = game.players[j]; if (!d) continue;
          const ar = (p.attackRange ?? 60);
          const attackBox = { x: p.x - 10, y: p.y - 10, width: p.width + 20, height: p.height + 20 };
          if (attackBox.x < d.x + d.width && attackBox.x + attackBox.width > d.x && attackBox.y < d.y + d.height && attackBox.y + attackBox.height > d.y) {
            const dmg = (p.character === 'knight') ? 18 : (p.character === 'ninja' ? 14 : 12);
            d.damage += dmg; d.velocityX = p.direction * (10 + d.damage*0.1); d.velocityY = -8; d.stunned = 12;
            p.specialMeter = Math.min(100, (p.specialMeter||0) + 6);
          }
        }
      }
    }

    if (controls.special && p.specialCooldown === 0 && (p.specialMeter||0) >= 20) {
      p.specialCooldown = game.specialCooldown; p.specialMeter = Math.max(0, (p.specialMeter||0)-20);
      p.action = 'special'; p.actionTimer = 30;
      // simple generic projectile if no specialMove logic
      if (p.character === 'ninja') {
        // katana spin: short-range circular slashes around player
        for (let a = 0; a < 6; a++) {
          const ang = (a / 6) * Math.PI * 2;
          addEffect({ type: 'katanaSlash', x: p.x + p.width/2 + Math.cos(ang)*30, y: p.y + p.height/2 + Math.sin(ang)*12, velocityX: Math.cos(ang)*2, velocityY: Math.sin(ang)*1, size:10, color:'#fff', damage:6, life:30, owner:p });
        }
      } else if (p.character === 'knight') {
        // heavy charge - existing behavior
  p.velocityX = p.direction*20; p.invulnerable = 20; addEffect({ type:'charge', x:p.x,y:p.y,width:p.width,height:p.height,velocityX:p.direction*20,color:'#00f',damage:20,life:20,owner:p,isCharge:true });
      } else if (p.character === 'wizard') {
        // wizard special: large fast fireball with trail
        const speed = 16;
  addEffect({ type:'fireball', x: p.x + (p.direction===1?p.width:-20), y: p.y + p.height/2, velocityX: p.direction*speed, velocityY: 0, size: 14, color:'#ff4400', damage:18, life:120, owner: p, trail: true });
        // small burst
  addEffect({ type:'flare', x: p.x + (p.direction===1?p.width:0), y: p.y + 8, velocityX: 0, velocityY: 0, size: 40, color:'rgba(255,140,30,0.25)', damage:0, life:12, owner: p });
      } else {
  addEffect({ type:'proj', x: p.x + (p.direction===1?p.width:-50), y: p.y + p.height/2, velocityX: p.direction*10, size:20, color:p.color, damage:15, life:60, owner:p });
      }
    }

    // Grab (close-range grab -> throw)
    if (controls.grab && p.grabCooldown === 0) {
      // check close opponent
      const range = 40;
      for (const j of [1,2]) {
        if (j === k) continue; const d = game.players[j]; if (!d) continue;
        if (Math.abs((p.x + p.width/2) - (d.x + d.width/2)) < range && Math.abs((p.y + p.height/2) - (d.y + d.height/2)) < 30) {
          // successful grab: attach opponent to p until p uses an attack/special or timeout
          p.grabCooldown = 90; p.action = 'grab'; p.actionTimer = 24;
          d.grabbedBy = p.id; d.grabbedTimer = 180; // frames
          d.velocityX = 0; d.velocityY = 0; d.stunned = 0;
          p.holding = d.id;
          p.specialMeter = Math.min(100, (p.specialMeter||0) + 8);
          break;
        }
      }
    }

    // decrement action timer
    if (p.actionTimer > 0) {
      p.actionTimer--;
      if (p.actionTimer <= 0) p.action = null;
    }

    // physics
    p.velocityY += game.gravity;
    p.x += p.velocityX;
    p.y += p.velocityY;

    // clamp velocities to avoid runaway values (protect against NaN/Infinity)
    const MAX_VEL = 60;
    if (!isFinite(p.velocityX) || Math.abs(p.velocityX) > MAX_VEL) p.velocityX = Math.max(-MAX_VEL, Math.min(MAX_VEL, Number(p.velocityX) || 0));
    if (!isFinite(p.velocityY) || Math.abs(p.velocityY) > MAX_VEL) p.velocityY = Math.max(-MAX_VEL, Math.min(MAX_VEL, Number(p.velocityY) || 0));
    // guard against NaN/Infinity positions
    if (!isFinite(p.x) || !isFinite(p.y)) {
      p.x = (p.id === 1) ? 200 : 600;
      p.y = 300;
      p.velocityX = 0; p.velocityY = 0;
    }

    // collisions with platforms
    for (const platform of game.platforms) {
      if (p.velocityY >= 0 && p.y + p.height > platform.y && p.y < platform.y && p.x + p.width > platform.x && p.x < platform.x + platform.width) {
        p.y = platform.y - p.height; p.velocityY = 0; onPlatform = true;
      }
    }

    // bounds and respawn
    if (p.x < 0) p.x = 0; if (p.x + p.width > 800) p.x = 800 - p.width; if (p.y < 0) { p.y = 0; p.velocityY = 0; }
    if (p.y + p.height > 600) { p.lives--; p.damage = 0; p.x = (p.x < 400)?200:600; p.y = 100; p.velocityX=0; p.velocityY=0; p.invulnerable=60; p.canDoubleJump = true; }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
