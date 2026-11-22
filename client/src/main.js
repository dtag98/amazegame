import * as THREE from 'three';
import { Client } from 'colyseus.js';
import { createGameSession } from './game-session.js';
import './style.css';

const status = document.querySelector('#status');
const authArea = document.querySelector('#auth');
const accountArea = document.querySelector('#account');
const welcome = document.querySelector('#welcome');
const connectButton = document.querySelector('#connect-game');
const logoutButton = document.querySelector('#logout');
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
    accountArea.hidden = true;
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
async function responseJson(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (response.status >= 500) throw new Error('Authentication is temporarily unavailable. Please try again in a few seconds.');
    throw new Error('The server returned an unexpected response. Please try again.');
  }
  try { return await response.json(); }
  catch { throw new Error('The server returned an invalid response. Please try again.'); }
}
async function csrfToken() {
  const retryDelays = [2000, 4000, 8000, 12000];
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch('/api/csrf-token', { credentials: 'include' });
      const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
      if ((!isJson || [502, 503, 504].includes(response.status)) && attempt < retryDelays.length) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      const data = await responseJson(response);
      if (!response.ok) throw new Error(data.error ?? 'Could not prepare the authentication request.');
      if (typeof data.csrfToken !== 'string') throw new Error('Could not prepare the authentication request. Please try again.');
      csrf = data.csrfToken;
      return;
    } catch (error) {
      if (error instanceof TypeError && attempt < retryDelays.length) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }
}
async function request(path, body) { await csrfToken(); const response = await fetch(`/api/${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }); const data = await responseJson(response); if (!response.ok) throw new Error(data.error ?? 'Request failed'); return data; }
for (const [id, action] of [['register','register'],['login','login']]) document.querySelector(`#${id}`).addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"], button:not([type])');
  if (submitButton?.disabled) return;
  if (submitButton) submitButton.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    const data = await request(action, values);
    if (action === 'login') showSignedIn(data.user);
    else status.textContent = `Account created for ${data.user.username}. Sign in to continue.`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});
function showSignedIn(user) {
  authArea.hidden = true;
  accountArea.hidden = false;
  playArea.hidden = true;
  logoutButton.hidden = false;
  connectButton.disabled = false;
  connectButton.textContent = 'Connect to game';
  welcome.textContent = `Welcome, ${user.username}`;
  status.textContent = 'You are signed in. Connect to the game when you are ready.';
}
async function startGame() {
  connectButton.disabled = true;
  connectButton.textContent = 'Connecting…';
  status.textContent = 'Connecting to the game…';
  try {
    await gameSession.start(true);
    if (!gameSession.connected) throw new Error('The server did not establish a game session.');
    accountArea.hidden = true;
    playArea.hidden = false;
    status.textContent = '';
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` ${error.message}` : ' Please try again.';
    returnToGameLobby(`Could not connect to the game.${reason} You are still signed in; you can retry.`);
  } finally {
    if (!accountArea.hidden) {
      connectButton.disabled = false;
      connectButton.textContent = 'Try again';
    }
  }
}
connectButton.addEventListener('click', startGame);
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
function clearGameView() {
  animationActive = false;
  keys.clear();
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  window.removeEventListener('blur', clearKeys);
  document.querySelector('#messages').replaceChildren();
  document.querySelector('#scene').replaceChildren();
  renderer?.dispose();
  renderer = undefined;
  avatar = undefined;
}
function returnToGameLobby(message) {
  clearGameView();
  gameSession.disconnect();
  authArea.hidden = true;
  accountArea.hidden = false;
  playArea.hidden = true;
  logoutButton.hidden = false;
  connectButton.disabled = false;
  connectButton.textContent = 'Try again';
  status.textContent = message;
}
logoutButton.addEventListener('click', async () => {
  try { await request('logout', {}); } catch {}
  clearGameView();
  gameSession.disconnect();
  accountArea.hidden = true;
  logoutButton.hidden = true;
  playArea.hidden = true;
  authArea.hidden = false;
  status.textContent = 'Signed out';
});
fetch('/api/me', { credentials: 'include' })
  .then(async response => response.ok ? response.json() : null)
  .then(data => { if (data?.user) showSignedIn(data.user); })
  .catch(() => {});
