import * as THREE from 'three';
import { Client } from '@colyseus/sdk';
import { SESSION_ENDED_CLOSE_CODE } from '../../shared/auth.js';
import { appendChatMessage, createGameSession } from './game-session.js';
import './style.css';

const status = document.querySelector('#status');
const authArea = document.querySelector('#auth');
const accountArea = document.querySelector('#account');
const welcome = document.querySelector('#welcome');
const connectButton = document.querySelector('#connect-game');
const logoutButton = document.querySelector('#logout');
const playArea = document.querySelector('#play');
const messages = document.querySelector('#messages');
const sceneHost = document.querySelector('#scene');
const sessionUpdates = new BroadcastChannel('amazegame-session');
let authBusy = false;
let accountVersion = 0;
let logoutVersion = 0;
let scene, camera, renderer, avatar;
const gameSession = createGameSession({
  joinRoom: () => {
    const client = new Client(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/colyseus`);
    return client.joinOrCreate('game');
  },
  onChat: message => appendChatMessage(messages, message),
  onRoomLeft: code => {
    if (code === SESSION_ENDED_CLOSE_CODE) returnToLogin('Your session ended. Sign in again.');
    else returnToGameLobby('Disconnected from the game. You can reconnect.');
  },
  onRoom: joinedRoom => {
    joinedRoom.reconnection.enabled = false;
    accountArea.hidden = true;
    playArea.hidden = false;
    setupScene();
    const syncPlayer = state => {
      const player = state?.players?.get?.(joinedRoom.sessionId);
      if (player && avatar) avatar.position.set(player.x, player.y + 0.9, player.z);
    };
    joinedRoom.onStateChange(syncPlayer);
    syncPlayer(joinedRoom.state);
  },
});
const keys = new Set();
let animationFrame;
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
      return data.csrfToken;
    } catch (error) {
      if (error instanceof TypeError && attempt < retryDelays.length) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }
}
async function request(path, body) {
  const csrf = await csrfToken();
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
  });
  if (response.status === 204 && path === 'logout') return;
  const data = await responseJson(response);
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
for (const action of ['register', 'login']) {
  const form = document.querySelector(`#${action}`);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (authBusy) return;
    const submitButton = form.querySelector('button');
    const version = logoutVersion;
    authBusy = true;
    submitButton.disabled = true;
    try {
      const { user } = await request(action, Object.fromEntries(new FormData(form)));
      form.reset();
      if (action === 'login') {
        const currentUser = version === logoutVersion ? user : await readCurrentIdentity();
        if (currentUser) showSignedIn(currentUser);
        else returnToLogin('Your session ended. Sign in again.');
      } else {
        const login = document.querySelector('#login');
        login.elements.username.value = user.username;
        login.elements.password.focus();
        status.textContent = `Account created for ${user.username}. Sign in to continue.`;
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submitButton.disabled = false;
      authBusy = false;
    }
  });
}
function showSignedIn(user) {
  accountVersion++;
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
  if (connectButton.disabled || logoutButton.hidden || authBusy) return;
  const version = accountVersion;
  connectButton.disabled = true;
  connectButton.textContent = 'Connecting…';
  status.textContent = 'Connecting to the game…';
  try {
    await gameSession.start(true);
    if (version !== accountVersion) return;
    if (!gameSession.connected) throw new Error('The server did not establish a game session.');
    accountArea.hidden = true;
    playArea.hidden = false;
    status.textContent = '';
  } catch (error) {
    if (version !== accountVersion) return;
    const reason = error instanceof Error && error.message ? ` ${error.message}` : ' Please try again.';
    let expired = false;
    try { expired = (await readIdentity()) === null; }
    catch { /* Keep the retry action available while the identity endpoint is unreachable. */ }
    if (version === accountVersion) {
      if (expired) returnToLogin('Your session ended. Sign in again.');
      else returnToGameLobby(`Could not connect to the game.${reason} You can retry.`);
    }
  }
}
connectButton.addEventListener('click', startGame);
function setupScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x172033);
  camera = new THREE.PerspectiveCamera(70, sceneHost.clientWidth / 360, 0.1, 100);
  camera.position.set(0, 4, 8);
  camera.lookAt(0, 0, 0);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(sceneHost.clientWidth, 360);
  sceneHost.replaceChildren(renderer.domElement);
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
  const clock = new THREE.Clock();
  function animate() {
    animationFrame = requestAnimationFrame(animate);
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
  cancelAnimationFrame(animationFrame);
  animationFrame = undefined;
  keys.clear();
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  window.removeEventListener('blur', clearKeys);
  messages.replaceChildren();
  sceneHost.replaceChildren();
  scene?.traverse(object => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      object.material.dispose();
    }
  });
  renderer?.dispose();
  scene = undefined;
  camera = undefined;
  renderer = undefined;
  avatar = undefined;
}
function returnToGameLobby(message) {
  accountVersion++;
  gameSession.disconnect();
  clearGameView();
  authArea.hidden = true;
  accountArea.hidden = false;
  playArea.hidden = true;
  logoutButton.hidden = false;
  connectButton.disabled = false;
  connectButton.textContent = 'Try again';
  status.textContent = message;
}
function returnToLogin(message) {
  accountVersion++;
  gameSession.disconnect();
  clearGameView();
  accountArea.hidden = true;
  logoutButton.hidden = true;
  playArea.hidden = true;
  authArea.hidden = false;
  welcome.textContent = '';
  status.textContent = message;
}
logoutButton.addEventListener('click', async () => {
  if (authBusy) return;
  authBusy = true;
  logoutButton.disabled = true;
  try {
    await request('logout', {});
    returnToLogin('Signed out.');
    sessionUpdates.postMessage('logout');
  } catch {
    if (!logoutButton.hidden) status.textContent = 'Could not sign out. Please try again.';
  } finally {
    logoutButton.disabled = false;
    authBusy = false;
  }
});

async function readIdentity() {
  const response = await fetch('/api/me', { credentials: 'include', signal: AbortSignal.timeout(8000) });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Could not check your sign-in status.');
  const { user } = await responseJson(response);
  return user;
}

async function readCurrentIdentity() {
  let user;
  let version;
  do {
    version = logoutVersion;
    user = await readIdentity();
  } while (version !== logoutVersion);
  return user;
}

sessionUpdates.addEventListener('message', async event => {
  if (event.data !== 'logout') return;
  logoutVersion++;
  if (logoutButton.hidden) return;
  const version = accountVersion;
  try {
    if ((await readCurrentIdentity()) === null && version === accountVersion) {
      returnToLogin('Your session ended. Sign in again.');
    }
  } catch { /* A room also receives the server's close event when its session ends. */ }
});

async function restoreAccount() {
  try {
    const user = await readCurrentIdentity();
    if (user) {
      showSignedIn(user);
      return;
    }
  } catch {
    status.textContent = 'Could not check your sign-in status.';
  }
  authArea.hidden = false;
}

restoreAccount();
