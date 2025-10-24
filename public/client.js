// Initialize game elements
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const player1Lives = document.getElementById('player1Lives');
const player2Lives = document.getElementById('player2Lives');
const player1Damage = document.getElementById('player1Damage');
const player2Damage = document.getElementById('player2Damage');
const player1Special = document.getElementById('player1Special');
const player2Special = document.getElementById('player2Special');
const player1Name = document.getElementById('player1Name');
const player2Name = document.getElementById('player2Name');
const characterSelect = document.getElementById('characterSelect');
const startGameBtn = document.getElementById('startGame');
const playerTurnText = document.getElementById('playerTurn');
const gameOverScreen = document.getElementById('gameOverScreen');
const winnerText = document.getElementById('winnerText');
const hitSound = document.getElementById('hitSound');
const jumpSound = document.getElementById('jumpSound');

// WebSocket & networking
function getWebSocketURL() {
    // Use wss for https pages, ws for http. If location.host is empty (file://), fall back to localhost:3000
    const scheme = (location.protocol === 'https:') ? 'wss:' : 'ws:';
    const host = location.host && location.host.length > 0 ? location.host : 'localhost:3000';
    return `${scheme}//${host}`;
}

const wsUrl = getWebSocketURL();
let ws;
try {
    ws = new WebSocket(wsUrl);
} catch (err) {
    console.error('WebSocket creation failed for', wsUrl, err);
}

let myPlayerId = 0;
let controlsLocal = { left:false, right:false, up:false, attack:false, special:false };
// add new controls for dash and grab
controlsLocal.dash = false;
controlsLocal.grab = false;

if (ws) {
    ws.addEventListener('open', () => {
        console.log('Connected to game server at', wsUrl);
        playerTurnText.textContent = 'Connected to server. Select your character.';
    });
    ws.addEventListener('message', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch(e) { return; }
    if (data.type === 'assign') {
        myPlayerId = data.playerId;
        if (myPlayerId > 0) {
            playerTurnText.textContent = `Player ${myPlayerId} - Select your character`;
        } else {
            playerTurnText.textContent = 'Spectator mode (two players already connected)';
            startGameBtn.style.display = 'none';
        }
    }

    if (data.type === 'matchStart') {
        // initialize client-side view of game
        if (data.platforms) game.platforms = data.platforms;
        if (data.players) {
            for (const k of [1,2]) {
                if (data.players[k]) game.players[k] = Object.assign(game.players[k] || {}, data.players[k]);
            }
        }
        characterSelect.style.display = 'none';
        startMatch();
    }

    if (data.type === 'state') {
        if (data.players) {
            for (const k of [1,2]) {
                if (data.players[k]) game.players[k] = Object.assign(game.players[k] || {}, data.players[k]);
            }
        }
        if (data.effects) game.effects = data.effects;
    }

    if (data.type === 'matchEnd') {
        const winnerId = data.winner;
        const winnerTextStr = winnerId === myPlayerId ? 'You win!' : `Player ${winnerId} wins!`;
        endMatch(winnerTextStr);
    }

    if (data.type === 'playerLeft') {
        // show overlay and return to character select
        alert(`Player ${data.playerId} disconnected. Returning to character select.`);
        window.resetGame();
    }
});

} else {
    // WebSocket failed to create — show helpful message
    playerTurnText.textContent = 'Unable to connect to server. Make sure you started server (node server.js) and opened the page via http://localhost:3000';
}

// Character selection
const characters = {
    ninja: {
        color: '#ff4444',
        specialColor: '#ff8888',
        moveSpeed: 7,
        jumpForce: -13,
        attackRange: 50,
        specialMove: (player) => {
            // Throw multiple shurikens
            for (let i = -1; i <= 1; i++) {
                game.effects.push({
                    x: player.x + (player.direction === 1 ? player.width : -20),
                    y: player.y + player.height/2 + (i * 20),
                    velocityX: player.direction * 15,
                    velocityY: i * 2,
                    size: 10,
                    color: '#ff0000',
                    damage: 8,
                    life: 60,
                    owner: player
                });
            }
        }
    },
    knight: {
        color: '#4444ff',
        specialColor: '#8888ff',
        moveSpeed: 5,
        jumpForce: -11,
        attackRange: 70,
        specialMove: (player) => {
            // Charge attack
            player.velocityX = player.direction * 20;
            player.invulnerable = 20;
            game.effects.push({
                x: player.x,
                y: player.y,
                width: player.width,
                height: player.height,
                velocityX: player.direction * 20,
                color: '#0000ff',
                damage: 20,
                life: 15,
                isCharge: true
                ,owner: player
            });
        }
    },
    wizard: {
        color: '#44ff44',
        specialColor: '#88ff88',
        moveSpeed: 4,
        jumpForce: -10,
        attackRange: 40,
        specialMove: (player) => {
            // Create energy field
            game.effects.push({
                x: player.x - 50,
                y: player.y - 50,
                size: 150,
                color: 'rgba(0, 255, 0, 0.3)',
                damage: 1,
                life: 90,
                isField: true,
                owner: player
            });
        }
    }
};

let selectedCharacters = { p1: null, p2: null };
let currentPlayer = 1;
let animationId = null; // store requestAnimationFrame id
let selectedLocalCharacter = null; // the character this client clicked
// animation system
const animations = {}; // playerId -> { name, time, duration }
let cameraShake = 0;
function startAnim(player, name, durationMs) {
    if (!player || !player.id) return;
    animations[player.id] = { name, time: 0, duration: Math.max(50, durationMs || 300) };
    player.animTimer = 0;
    player.animState = name;
    // small camera feedback for big attacks
    if (name === 'sword_slash' || name === 'fireball_cast') cameraShake = Math.max(cameraShake, 6);
}

function updateAnimations(dtMs) {
    const toRemove = [];
    for (const pidStr of Object.keys(animations)) {
        const pid = Number(pidStr);
        const a = animations[pid];
        a.time += dtMs;
        const progress = Math.min(1, a.time / a.duration);
        const player = game.players[pid];
        if (player) player.animProgress = progress;

        // at specific animation progress spawn FX / shake
        if (a.name === 'katana_slash' && progress > 0.25 && !a._katanaHit) {
            // spawn a strong slash particle
            game.effects.push({ type: 'katanaSlash', x: player.x + (player.direction===1?player.width+18: -18)+player.direction*6, y: player.y + player.height/2, velocityX: player.direction*2, velocityY: 0, size: 18, color: 'rgba(255,255,255,0.98)', life: 18, damage: 0 });
            a._katanaHit = true; cameraShake = Math.max(cameraShake, 8);
        }
        if (a.name === 'sword_slash' && progress > 0.35 && !a._swordHit) {
            game.effects.push({ type:'swordArc', x: player.x + (player.direction===1?player.width+12: player.x-12), y: player.y + player.height/2, velocityX:0, velocityY:0, size:1, color:'rgba(255,240,200,0.9)', life:20 });
            a._swordHit = true; cameraShake = Math.max(cameraShake, 10);
        }
        if (a.name === 'fireball_cast' && progress > 0.5 && !a._fireSent) {
            // spawn a larger cosmetic fireball for visual punch
            game.effects.push({ type: 'fireball', x: player.x + (player.direction===1?player.width: -20), y: player.y + player.height/2, velocityX: player.direction*12, velocityY:0, size: 18, color: '#ff3300', life: 100, damage: 0, trail: true });
            a._fireSent = true; cameraShake = Math.max(cameraShake, 12);
        }

        if (a.time >= a.duration) toRemove.push(pid);
    }
    for (const pid of toRemove) {
        const a = animations[pid];
        delete animations[pid];
        const p = game.players[pid]; if (p) { p.animProgress = 0; p.animState = 'idle'; }
    }
    // decay cameraShake
    cameraShake = Math.max(0, cameraShake - (dtMs * 0.01));
}

// Character selection event listeners
document.querySelectorAll('.character-option').forEach(option => {
    option.addEventListener('click', () => {
        const character = option.dataset.character;
        document.querySelectorAll('.character-option').forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
    // Register selection locally so the UI updates immediately
    selectedLocalCharacter = character;
    // also store into selectedCharacters for the current player id (if assigned)
    if (myPlayerId > 0) selectedCharacters[`p${myPlayerId}`] = character;
        playerTurnText.textContent = `Selected: ${character}`;
        startGameBtn.style.display = 'block';
        // If server already assigned us an id, send selection immediately
        if (myPlayerId > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'select', character }));
        }
    });
});

// Start button: apply character choices and begin the match
startGameBtn.addEventListener('click', () => {
    const chosen = selectedLocalCharacter || selectedCharacters[`p${myPlayerId}`] || 'ninja';
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'select', character: chosen }));
        ws.send(JSON.stringify({ type: 'ready' }));
    }
    startGameBtn.style.display = 'none';
    playerTurnText.textContent = 'Waiting for opponent...';
});

// Allow starting with Enter
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && characterSelect.style.display !== 'none') {
        startGameBtn.click();
    }
});

// Game state
const game = {
    players: {
        1: {
            x: 200,
            y: 300,
            width: 50,
            height: 80,
            velocityX: 0,
            velocityY: 0,
            lives: 3,
            damage: 0,
            color: '#ff4444',
            direction: 1,
            isAttacking: false,
            isSpecial: false,
            canDoubleJump: true,
            invulnerable: 0,
            stunned: 0
        },
        2: {
            x: 600,
            y: 300,
            width: 50,
            height: 80,
            velocityX: 0,
            velocityY: 0,
            lives: 3,
            damage: 0,
            color: '#4444ff',
            direction: -1,
            isAttacking: false,
            isSpecial: false,
            canDoubleJump: true,
            invulnerable: 0,
            stunned: 0
        }
    },
    platforms: [
        {
            x: 200,
            y: 500,
            width: 400,
            height: 20,
            color: '#666'
        },
        {
            x: 100,
            y: 350,
            width: 200,
            height: 20,
            color: '#666'
        },
        {
            x: 500,
            y: 350,
            width: 200,
            height: 20,
            color: '#666'
        }
    ],
    effects: [],
    gravity: 0.5,
    jumpForce: -12,
    moveSpeed: 6,
    attackRange: 60,
    attackCooldown: 20,
    specialCooldown: 60
};

// Controls
const keys = {
    player1: {
        left: false,
        right: false,
        up: false,
        attack: false,
        special: false
    },
    player2: {
        left: false,
        right: false,
        up: false,
        attack: false,
        special: false
    }
};

// Input handling (send local controls to server)
document.addEventListener('keydown', (e) => {
    let changed = false;
    switch(e.key) {
        case 'a': controlsLocal.left = true; changed = true; break;
        case 'd': controlsLocal.right = true; changed = true; break;
        case 'w': controlsLocal.up = true; changed = true; break;
        case 'f': controlsLocal.attack = true; changed = true; break;
        case 'g': controlsLocal.special = true; changed = true; break;
        case 'e': controlsLocal.dash = true; changed = true; break;
        case 'r': controlsLocal.grab = true; changed = true; break;
        case 'ArrowLeft': controlsLocal.left = true; changed = true; break;
        case 'ArrowRight': controlsLocal.right = true; changed = true; break;
        case 'ArrowUp': controlsLocal.up = true; changed = true; break;
        case 'Shift': controlsLocal.attack = true; changed = true; break;
        case 'Control': controlsLocal.special = true; changed = true; break;
    }
    if (changed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', controls: controlsLocal }));
});

document.addEventListener('keyup', (e) => {
    let changed = false;
    switch(e.key) {
        case 'a': controlsLocal.left = false; changed = true; break;
        case 'd': controlsLocal.right = false; changed = true; break;
        case 'w': controlsLocal.up = false; changed = true; break;
        case 'f': controlsLocal.attack = false; changed = true; break;
        case 'g': controlsLocal.special = false; changed = true; break;
        case 'e': controlsLocal.dash = false; changed = true; break;
        case 'r': controlsLocal.grab = false; changed = true; break;
        case 'ArrowLeft': controlsLocal.left = false; changed = true; break;
        case 'ArrowRight': controlsLocal.right = false; changed = true; break;
        case 'ArrowUp': controlsLocal.up = false; changed = true; break;
        case 'Shift': controlsLocal.attack = false; changed = true; break;
        case 'Control': controlsLocal.special = false; changed = true; break;
    }
    if (changed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', controls: controlsLocal }));
});

// Game functions
function updatePlayer(player, controls) {
    if (player.stunned > 0) {
        player.stunned--;
        return;
    }

    if (player.invulnerable > 0) {
        player.invulnerable--;
    }

    // Per-character movement/jump/attack stats (fall back to defaults)
    const mv = player.moveSpeed ?? game.moveSpeed;
    const jf = player.jumpForce ?? game.jumpForce;
    const ar = player.attackRange ?? game.attackRange;

    // Movement
    if (controls.left && !controls.right) {
        player.velocityX = -mv;
        player.direction = -1;
    } else if (controls.right && !controls.left) {
        player.velocityX = mv;
        player.direction = 1;
    } else {
        player.velocityX *= 0.8; // Friction
    }

    // Check if on any platform (tolerant feet check)
    let onPlatform = false;
    for (const platform of game.platforms) {
        const feet = player.y + player.height;
        if (feet >= platform.y - 3 && feet <= platform.y + 10 &&
            player.x + player.width > platform.x &&
            player.x < platform.x + platform.width) {
            onPlatform = true;
            break;
        }
    }

    // Jumping and double jumping
    if (controls.up) {
        if (onPlatform) {
            player.velocityY = jf;
            player.canDoubleJump = true;
            if (jumpSound) { try { jumpSound.currentTime = 0; jumpSound.play(); } catch(e){} }
        } else if (player.canDoubleJump && !player.wasJumping) {
            player.velocityY = jf * 0.8;
            player.canDoubleJump = false;
            if (jumpSound) { try { jumpSound.currentTime = 0; jumpSound.play(); } catch(e){} }
        }
    }
    player.wasJumping = controls.up;

    // Attack cooldown
    if (player.attackCooldown > 0) player.attackCooldown--;
    if (player.specialCooldown > 0) player.specialCooldown--;

    // Attacks
    player.isAttacking = controls.attack && player.attackCooldown === 0;
    if (player.isAttacking) {
        player.attackCooldown = game.attackCooldown;
    }

    // Special attacks (require meter)
    player.isSpecial = controls.special && player.specialCooldown === 0 && (player.specialMeter || 0) >= 20;
    if (player.isSpecial) {
        player.specialCooldown = game.specialCooldown;
        // consume some meter
        player.specialMeter = Math.max(0, (player.specialMeter || 0) - 20);
        if (player.specialMove) {
            player.specialMove(player);
        } else {
            game.effects.push({
                x: player.x + (player.direction === 1 ? player.width : -50),
                y: player.y + player.height/2,
                velocityX: player.direction * 10,
                size: 20,
                color: player.color,
                damage: 15,
                owner: player
            });
        }
    }

    // Apply physics
    player.velocityY += game.gravity;
    player.x += player.velocityX;
    player.y += player.velocityY;

    // Platform collisions
    let isOnPlatform = false;
    for (const platform of game.platforms) {
        if (player.velocityY >= 0 &&
            player.y + player.height > platform.y &&
            player.y < platform.y &&
            player.x + player.width > platform.x &&
            player.x < platform.x + platform.width) {
            player.y = platform.y - player.height;
            player.velocityY = 0;
            isOnPlatform = true;
        }
    }

    // Screen bounds
    if (player.x < 0) player.x = 0;
    if (player.x + player.width > canvas.width) player.x = canvas.width - player.width;
    if (player.y < 0) {
        player.y = 0;
        player.velocityY = 0;
    }
    if (player.y + player.height > canvas.height) {
        player.lives--;
        player.damage = 0;
        player.x = player.x < canvas.width/2 ? 200 : 600;
        player.y = 100;
        player.velocityX = 0;
        player.velocityY = 0;
        player.invulnerable = 60;
        player.canDoubleJump = true;
    }
}

function checkAttackCollision(attacker, defender) {
    if (defender.invulnerable > 0) return;

    if (attacker.isAttacking) {
        const ar = attacker.attackRange ?? game.attackRange;
        const attackBox = {
            x: attacker.direction === 1 ? attacker.x + attacker.width : attacker.x - ar,
            y: attacker.y,
            width: ar,
            height: attacker.height
        };

        if (attackBox.x < defender.x + defender.width &&
            attackBox.x + attackBox.width > defender.x &&
            attackBox.y < defender.y + defender.height &&
            attackBox.y + attackBox.height > defender.y) {
            const knockbackPower = 10 + (defender.damage * 0.2);
            defender.velocityX = attacker.direction * knockbackPower;
            defender.velocityY = -knockbackPower;
            defender.damage += 10;
            defender.stunned = 10;
            createHitEffect(defender.x + defender.width/2, defender.y + defender.height/2);
            // reward attacker with special meter
            attacker.specialMeter = Math.min(100, (attacker.specialMeter || 0) + 5);
            if (hitSound) { try { hitSound.currentTime = 0; hitSound.play(); } catch(e){} }
        }
    }
}

function createHitEffect(x, y) {
    for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        game.effects.push({
            x: x,
            y: y,
            velocityX: Math.cos(angle) * 5,
            velocityY: Math.sin(angle) * 5,
            size: 5,
            color: '#fff',
            life: 20
        });
    }
}

function updateEffects() {
    for (let i = game.effects.length - 1; i >= 0; i--) {
        const effect = game.effects[i];
        effect.x += effect.velocityX;
        effect.y += effect.velocityY;
        if (effect.life !== undefined) {
            effect.life--;
            if (effect.life <= 0) {
                game.effects.splice(i, 1);
                continue;
            }
        }
        // periodic field effects (damage over time)
        effect.ticks = (effect.ticks || 0) + 1;
        if (effect.isField && effect.ticks % 15 === 0) {
            for (let j = 1; j <= 2; j++) {
                const player = game.players[j];
                if (player === effect.owner) continue; // don't damage owner
                // circle collision
                const dx = effect.x + (effect.size||0)/2 - (player.x + player.width/2);
                const dy = effect.y + (effect.size||0)/2 - (player.y + player.height/2);
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < (effect.size||0)/2) {
                    player.damage += effect.damage || 1;
                    player.velocityY = -5;
                    player.stunned = 8;
                    if (effect.owner) effect.owner.specialMeter = Math.min(100, (effect.owner.specialMeter||0) + (effect.damage||1));
                }
            }
        }
        
        // Cosmetic trails and projectiles (client-side visuals only)
        if (effect.type === 'fireball' && effect.trail) {
            // spawn small ember particles behind
            if (Math.random() < 0.6) {
                game.effects.push({ x: effect.x - (effect.velocityX||0)/2 + (Math.random()-0.5)*6, y: effect.y + (Math.random()-0.5)*6, velocityX: (Math.random()-0.5)*0.6, velocityY: -Math.random()*0.5, size: 3 + Math.random()*3, color: 'rgba(255,160,50,0.9)', life: 20 });
            }
        }

        // Cosmetic sword/katana trail collisions -> spawn hit VFX when overlapping visually
        if ((effect.type === 'katanaSlash' || effect.type === 'katanaTrail' || effect.type === 'swordArc' || effect.type === 'proj' || effect.type === 'fireball') && effect.damage) {
            for (let j = 1; j <= 2; j++) {
                const player = game.players[j];
                if (!player) continue;
                if (effect.x > player.x && effect.x < player.x + player.width && effect.y > player.y && effect.y < player.y + player.height) {
                    createHitEffect(effect.x, effect.y);
                    // remove cosmetic projectile locally
                    game.effects.splice(i, 1);
                    break;
                }
            }
        }
    }
}

function draw() {
    // camera shake and transform
    ctx.save();
    if (cameraShake && cameraShake > 0.01) {
        const sx = (Math.random() * 2 - 1) * cameraShake;
        const sy = (Math.random() * 2 - 1) * cameraShake;
        ctx.translate(sx, sy);
    }
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw platforms
    for (const platform of game.platforms) {
        ctx.fillStyle = platform.color;
        ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
    }

    // Draw effects behind players (improved visuals)
    for (const effect of game.effects) {
        // prefer explicit effect.type rendering
        if (effect.type === 'fireball') {
            // core fireball
            ctx.save();
            const gradient = ctx.createRadialGradient(effect.x, effect.y, 0, effect.x, effect.y, Math.max(8, effect.size||12));
            gradient.addColorStop(0, effect.color || '#ff6600');
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = gradient;
            ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.size||12, 0, Math.PI*2); ctx.fill();
            // flame core
            ctx.fillStyle = 'rgba(255,180,60,0.6)'; ctx.beginPath(); ctx.arc(effect.x - (effect.velocityX||0)/3, effect.y, (effect.size||12)/2, 0, Math.PI*2); ctx.fill();
            ctx.restore();
            continue;
        }
        if (effect.type === 'katanaTrail' || effect.type === 'katanaSlash') {
            ctx.save(); ctx.strokeStyle = effect.color || '#fff'; ctx.lineWidth = 6; ctx.globalAlpha = 0.9;
            ctx.beginPath(); ctx.moveTo(effect.x - (effect.velocityX||0)*2, effect.y - 4); ctx.lineTo(effect.x + (effect.velocityX||0)*2, effect.y + 4); ctx.stroke(); ctx.restore();
            continue;
        }
        if (effect.type === 'swordArc') {
            ctx.save(); ctx.fillStyle = effect.color || 'rgba(220,220,255,0.9)'; ctx.globalAlpha = 0.9;
            ctx.beginPath(); ctx.ellipse(effect.x, effect.y, 60, 30, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();
            continue;
        }
        if (effect.type === 'dashLine') {
            ctx.save(); ctx.strokeStyle = effect.color || 'rgba(255,255,255,0.6)'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(effect.x, effect.y); ctx.lineTo(effect.x + (effect.velocityX||0)*2, effect.y); ctx.stroke(); ctx.restore();
            continue;
        }
        if (effect.isField || effect.type === 'specialField') {
            const r = effect.size || 150;
            const g = ctx.createRadialGradient(effect.x, effect.y, 0, effect.x, effect.y, r);
            g.addColorStop(0, effect.color || 'rgba(0,255,0,0.45)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(effect.x, effect.y, r/2, 0, Math.PI*2);
            ctx.fill();
            continue;
        }
        if (effect.isCharge || effect.type === 'charge' || effect.type === 'proj' || effect.type === 'flare') {
            if (effect.isCharge || effect.type === 'charge') {
                ctx.save(); ctx.fillStyle = effect.color || '#00f'; ctx.globalAlpha = 0.9; ctx.fillRect(effect.x, effect.y, effect.width || 40, effect.height || 20); ctx.restore(); continue;
            }
            if (effect.type === 'flare') {
                ctx.save(); ctx.fillStyle = effect.color || 'rgba(255,140,30,0.25)'; ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.size || 40, 0, Math.PI*2); ctx.fill(); ctx.restore(); continue;
            }
            // generic projectile
            ctx.fillStyle = effect.color || '#fff'; ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.size || 6, 0, Math.PI * 2); ctx.fill(); continue;
        }
        // fallback
        ctx.fillStyle = effect.color || '#fff';
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, effect.size || 6, 0, Math.PI * 2);
        ctx.fill();
    }

    // Draw players with articulated bodies + animated limbs
    const now = performance.now() / 1000;
    for (let i = 1; i <= 2; i++) {
        const player = game.players[i];
        drawCharacter(player, i, now);
    }

    // Update HUD
    player1Lives.textContent = `P1 Lives: ${game.players[1].lives}`;
    player2Lives.textContent = `P2 Lives: ${game.players[2].lives}`;
    player1Damage.textContent = `${Math.floor(game.players[1].damage)}%`;
    player2Damage.textContent = `${Math.floor(game.players[2].damage)}%`;
    // Update special meters
    const p1 = game.players[1];
    const p2 = game.players[2];
    player1Special.style.width = `${Math.min(100, Math.floor(p1.specialMeter || 0))}%`;
    player2Special.style.width = `${Math.min(100, Math.floor(p2.specialMeter || 0))}%`;
    ctx.restore();
}

function gameLoop() {
    // Render loop only — authoritative state comes from server
    const now = performance.now();
    const dtMs = Math.max(0, now - (window._lastFrameTime || now));
    window._lastFrameTime = now;
    // Update client-side animations and cosmetic effects
    try { updateAnimations(dtMs); } catch (e) { console.error('updateAnimations error', e); }
    try { updateEffects(); } catch (e) { console.error('updateEffects error', e); }
    draw();
    animationId = requestAnimationFrame(gameLoop);
}

function resetGame() {
    game.players[1].lives = 3;
    game.players[2].lives = 3;
    game.players[1].x = 200;
    game.players[1].y = 300;
    game.players[2].x = 600;
    game.players[2].y = 300;
    game.players[1].velocityX = 0;
    game.players[1].velocityY = 0;
    game.players[2].velocityX = 0;
    game.players[2].velocityY = 0;
}

// Apply a character's stats to a player object
function applyCharacterToPlayer(playerIndex, characterKey) {
    const char = characters[characterKey] || characters.ninja;
    const p = game.players[playerIndex];
    p.color = char.color;
    p.moveSpeed = char.moveSpeed;
    p.jumpForce = char.jumpForce;
    p.attackRange = char.attackRange;
    p.specialMove = char.specialMove;
    p.attackCooldown = 0;
    p.specialCooldown = 0;
    p.damage = 0;
    p.specialMeter = 0;
    p.invulnerable = 0;
    p.stunned = 0;
}

// Articulated character renderer + cosmetic VFX when actions occur
function drawCharacter(player, index, t) {
    // track previous action so we can spawn cosmetic VFX once
    player.prevAction = player.prevAction || null;
    if (player.action && player.action !== player.prevAction) {
        // spawn cosmetic visuals for specific actions
        if (player.action === 'attack_sword') {
            // wide sword arc
            const sx = player.direction === 1 ? player.x + player.width + 6 : player.x - 6;
            const sy = player.y + player.height/2;
            game.effects.push({ type:'swordArc', x: sx, y: sy, velocityX:0, velocityY:0, size: 1, color:'rgba(220,220,255,0.9)', life: 18, ownerId: player.id });
            startAnim(player, 'sword_slash', 400);
        }
        if (player.action === 'attack_katana') {
            // quick katana trail
            const sx = player.direction === 1 ? player.x + player.width + 8 : player.x - 8;
            const sy = player.y + player.height/2;
            game.effects.push({ type:'katanaTrail', x: sx, y: sy, velocityX: player.direction*2, velocityY: 0, size: 10, color:'rgba(255,255,255,0.95)', life: 14, ownerId: player.id });
            startAnim(player, 'katana_slash', 260);
        }
        if (player.action === 'attack_fireball') {
            // cosmetic small fireball
            const sx = player.direction === 1 ? player.x + player.width + 6 : player.x - 6;
            game.effects.push({ type:'fireball', x: sx, y: player.y + player.height/2, velocityX: player.direction*10, velocityY:0, size:10, color:'#ff8800', life: 80, ownerId: player.id, trail:true });
            startAnim(player, 'fireball_cast', 420);
        }
        if (player.action === 'dash') {
            // speed lines
            for (let i=0;i<3;i++) game.effects.push({ type:'dashLine', x: player.x + (player.direction===1? -10: player.width+10), y: player.y + 10 + i*6, velocityX: player.direction*6, velocityY:0, size:8, color:'rgba(255,255,255,0.6)', life: 12 });
            startAnim(player, 'dash', 300);
        }
        if (player.action === 'special') {
            // generic special: spawn a field as cosmetic
            game.effects.push({ type:'specialField', x: player.x + player.width/2, y: player.y + player.height/2, size: 80, color: 'rgba(100,200,255,0.35)', life: 30, ownerId: player.id });
            startAnim(player, 'special', 600);
        }
    }
    player.prevAction = player.action;

    // visible while not flickering invulnerable
    const visible = (player.invulnerable === 0 || Math.floor(player.invulnerable/3) % 2 === 0);

    // determine animation state
    player.animState = player.animState || 'idle';
    if (player.action) {
        if (player.action.startsWith('attack')) player.animState = 'attack';
        else player.animState = player.action;
        player.animTimer = player.animTimer || 0; player.animTimer++;
    } else if (Math.abs(player.velocityX) > 1) { player.animState = 'run'; player.animTimer = (player.animTimer||0) + 1; }
    else if (player.velocityY < -1) { player.animState = 'jump'; player.animTimer = 0; }
    else { player.animState = 'idle'; player.animTimer = 0; }

    // body center
    const cx = player.x + player.width/2;
    const cy = player.y + player.height/2;
    const torsoW = player.width * 0.6;
    const torsoH = player.height * 0.5;

    // limb animation
    const speedFactor = Math.min(1, Math.abs(player.velocityX || 0) / 8);
    const legAngle = Math.sin(t * 12 + index) * 0.6 * speedFactor;
    const armAngle = Math.sin(t * 14 + index*1.3) * 0.4 * speedFactor;

    if (visible) {
        ctx.save();
        // torso
        ctx.fillStyle = player.color || '#999';
        ctx.fillRect(cx - torsoW/2, cy - torsoH/2, torsoW, torsoH);
    // head (small bob when running)
    const headY = player.y + 18 + (player.animState === 'run' ? Math.sin(player.animTimer * 0.2) * 2 : 0);
    ctx.beginPath(); ctx.fillStyle = '#f6e0c3'; ctx.arc(cx, headY, 12, 0, Math.PI*2); ctx.fill();
    // eye
    ctx.fillStyle = '#000'; ctx.fillRect(cx + (player.direction===1?6:-10), headY - 6, 4, 4);

        // arms (pose changes for attack/dash/grab)
        const armY = cy - torsoH/4;
        const handX = cx + (player.direction === 1 ? 1 : -1) * (torsoW/2 + 12);
        ctx.strokeStyle = '#f6e0c3'; ctx.lineWidth = 6; ctx.lineCap = 'round';
        if (player.animState === 'attack') {
            // striking pose
            const swing = Math.sin((player.animTimer||0) * 0.8) * 18;
            ctx.beginPath(); ctx.moveTo(cx + (torsoW/2), armY); ctx.lineTo(handX + player.direction * swing, armY + 6); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx - (torsoW/2), armY); ctx.lineTo(cx - (torsoW/2) - 6, armY + 6); ctx.stroke();
        } else if (player.animState === 'dash') {
            // tucked arms while dashing
            ctx.beginPath(); ctx.moveTo(cx - (torsoW/2) , armY); ctx.lineTo(cx - (torsoW/2) - 2, armY + 6); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx + (torsoW/2), armY); ctx.lineTo(cx + (torsoW/2) + 2, armY + 6); ctx.stroke();
        } else if (player.animState === 'grab') {
            ctx.beginPath(); ctx.moveTo(cx + (torsoW/2), armY); ctx.lineTo(handX + player.direction*4, armY); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx - (torsoW/2), armY); ctx.lineTo(cx - (torsoW/2) - 4, armY); ctx.stroke();
        } else {
            ctx.beginPath(); ctx.moveTo(cx - (torsoW/2) , armY); ctx.lineTo(cx - (torsoW/2) - Math.sin(armAngle) * 8, armY + Math.cos(armAngle) * 12); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx + (torsoW/2), armY); ctx.lineTo(handX, armY + Math.sin(armAngle) * 6); ctx.stroke();
        }

        // legs
        const footY = player.y + player.height;
        ctx.strokeStyle = '#333'; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(cx - 8, cy + torsoH/2); ctx.lineTo(cx - 8 + Math.sin(legAngle) * 12, footY); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + 8, cy + torsoH/2); ctx.lineTo(cx + 8 - Math.sin(legAngle) * 12, footY); ctx.stroke();

        ctx.restore();
    }

    // character-specific decorations / weapons
    if (player.character === 'knight') {
        ctx.save(); ctx.fillStyle = '#ccc';
        const swordX = player.direction === 1 ? player.x + player.width + 4 : player.x - 18;
        const swordY = player.y + player.height/2 - 6;
        ctx.fillRect(swordX, swordY, 16, 4);
        ctx.restore();
    } else if (player.character === 'ninja') {
        // draw katana: thin blade with slight rotation
        ctx.save();
        ctx.translate(player.x + player.width/2, player.y + player.height/2);
        const angle = player.direction === 1 ? -0.25 : 0.25;
        ctx.rotate(angle);
        ctx.fillStyle = '#ddd';
        ctx.fillRect(player.direction===1?18:-34, -3, 40, 6);
        ctx.fillStyle = '#6b4f31'; ctx.fillRect(player.direction===1?18:-34, -7, 8, 4); // hilt
        ctx.restore();
    } else if (player.character === 'wizard') {
        ctx.save(); const gx = player.x + player.width/2; const gy = player.y + player.height/2; const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, 40); grad.addColorStop(0, 'rgba(200,255,200,0.9)'); grad.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(gx, gy, 16, 0, Math.PI*2); ctx.fill(); ctx.restore();
    }

    // attack arc
    if (player.action === 'attack' || player.isAttacking) {
        ctx.save(); ctx.fillStyle = 'rgba(255,220,80,0.5)';
        const ar = player.attackRange ?? game.attackRange;
        const attackX = player.direction === 1 ? player.x + player.width : player.x - ar;
        ctx.beginPath(); ctx.ellipse(attackX + ar/2, player.y + player.height/2, ar/2, player.height/2, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();
    }

    // if this player is holding someone, draw a grab indicator
    if (player.holding) {
        ctx.save(); ctx.strokeStyle = 'rgba(255,200,80,0.9)'; ctx.lineWidth = 3;
        const hx = player.x + (player.direction===1? player.width : 0);
        const hy = player.y + player.height/2;
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + (player.direction===1?20:-20), hy); ctx.stroke();
        ctx.restore();
    }
}

function startMatch() {
    // reset some runtime state
    game.effects = [];
    // ensure players positioned
    game.players[1].x = 200; game.players[1].y = 300;
    game.players[2].x = 600; game.players[2].y = 300;
    // start loop
    if (!animationId) animationId = requestAnimationFrame(gameLoop);
}

function endMatch(winner) {
    // stop loop
    if (animationId) cancelAnimationFrame(animationId);
    animationId = null;
    // show overlay
    winnerText.textContent = `${winner} wins!`;
    gameOverScreen.style.display = 'block';
}

// Allow Reset from the game over screen
window.resetGame = function() {
    gameOverScreen.style.display = 'none';
    characterSelect.style.display = 'flex';
    // clear selections so players can reselect or keep previous
    document.querySelectorAll('.character-option').forEach(opt => opt.classList.remove('selected'));
    selectedCharacters = { p1: null, p2: null };
    currentPlayer = 1;
    playerTurnText.textContent = 'Player 1 Select';
    startGameBtn.style.display = 'none';
};
