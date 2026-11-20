import * as THREE from 'three';
import { Client } from 'colyseus.js';
import { createGameSession } from './game-session.js';
import './style.css';

const status = document.querySelector('#status');
const authArea = document.querySelector('#auth');
const playArea = document.querySelector('#play');
let csrf = '';
let scene, camera, renderer, avatar;
const gameSession = createGameSession({
  joinRoom: () => {
    const client = new Client(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/colyseus`);
    return client.joinOrCreate('game');
  },
  onChat: message => { const li = document.createElement('li'); li.textContent = `${message.username}: ${message.message}`; document.querySelector('#messages').append(li); },
  onRoom: joinedRoom => {
    setupScene();
    playArea.hidden = false;
    const syncPlayer = state => { const player = state.players.get(joinedRoom.sessionId); if (player && avatar) avatar.position.set(player.x, player.y + 0.9, player.z); };
    joinedRoom.onStateChange(syncPlayer);
    syncPlayer(joinedRoom.state);
  },
});
const keys = new Set();
let animationActive = false;
let lastMoveSent = 0;
const handleKeyDown = event => { if (!['INPUT', 'TEXTAREA'].includes(event.target?.tagName)) keys.add(event.key.toLowerCase()); };
const handleKeyUp = event => keys.delete(event.key.toLowerCase());
const clearKeys = () => keys.clear();
async function csrfToken() { const response = await fetch('/api/csrf-token', { credentials: 'include' }); csrf = (await response.json()).csrfToken; }
async function request(path, body) { await csrfToken(); const response = await fetch(`/api/${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error ?? 'Request failed'); return data; }
for (const [id, action] of [['register','register'],['login','login']]) document.querySelector(`#${id}`).addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const submitButton = form.querySelector('button[type="submit"], button:not([type])'); if (submitButton?.disabled) return; if (submitButton) submitButton.disabled = true; const values = Object.fromEntries(new FormData(form)); try { const data = await request(action, values); status.textContent = `Welcome, ${data.user.username}`; if (action === 'login') await startGame(); } catch (error) { status.textContent = error.message; } finally { if (submitButton) submitButton.disabled = false; } });
async function startGame() {
  authArea.hidden = true;
  try {
    await gameSession.start(true);
  } catch { authArea.hidden = false; playArea.hidden = true; status.textContent = 'Could not connect to the game. Sign in and try again.'; }
}
function setupScene() {
  const host = document.querySelector('#scene');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x172033);
  camera = new THREE.PerspectiveCamera(70, host.clientWidth / 360, 0.1, 100);
  camera.position.set(0, 4, 8);
  camera.lookAt(0, 0, 0);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(host.clientWidth, 360);
  host.replaceChildren(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 2));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x34543d }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  avatar = new THREE.Mesh(new THREE.BoxGeometry(1, 1.8, 1), new THREE.MeshStandardMaterial({ color: 0xffbd4a }));
  avatar.position.y = 0.9;
  scene.add(avatar);

  keys.clear();
  lastMoveSent = 0;
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', clearKeys);
  animationActive = true;
  const clock = new THREE.Clock();
  function animate() {
    if (!animationActive) return;
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.05);
    let dx = Number(keys.has('d')) - Number(keys.has('a'));
    let dz = Number(keys.has('s')) - Number(keys.has('w'));
    const length = Math.hypot(dx, dz);
    if (length > 0) {
      dx /= length;
      dz /= length;
      avatar.position.x += dx * 5 * delta;
      avatar.position.z += dz * 5 * delta;
      const now = performance.now();
      if (gameSession.connected && now - lastMoveSent >= 50) {
        gameSession.sendMove(dx, dz);
        lastMoveSent = now;
      }
    }
    renderer.render(scene, camera);
  }
  animate();
}
document.querySelector('#chat').addEventListener('submit', event => { event.preventDefault(); const input = event.currentTarget.elements.message; gameSession.sendChat(input.value); input.value = ''; });
async function returnToLogin(message) {
  animationActive = false;
  keys.clear();
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  window.removeEventListener('blur', clearKeys);
  gameSession.disconnect();
  document.querySelector('#messages').replaceChildren();
  document.querySelector('#scene').replaceChildren();
  renderer?.dispose();
  renderer = undefined;
  avatar = undefined;
  playArea.hidden = true;
  authArea.hidden = false;
  status.textContent = message;
}
document.querySelector('#logout').addEventListener('click', async () => { try { await request('logout', {}); } catch {} await returnToLogin('Signed out'); });
fetch('/api/me', { credentials: 'include' }).then(async response => response.ok ? response.json() : null).then(data => { if (data) { status.textContent = `Welcome back, ${data.user.username}`; return startGame(); } }).catch(() => {}).finally(() => { if (!gameSession.connected) { playArea.hidden = true; authArea.hidden = false; } });
