// ---------- Config ----------
const CHUNK_SIZE = 256 * 1024;       // 256KB chunks over the data channel — big enough to be fast, small enough to stay smooth
const PEER_WAIT_TIMEOUT_MS = 15000;  // how long we wait for the receiver before falling back to temp storage
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ---------- View switching ----------
const views = ['home', 'waiting', 'receive', 'sending', 'done', 'error'];
function showView(name) {
  views.forEach(v => document.getElementById('view-' + v).classList.toggle('active', v === name));
}

// ---------- Helpers ----------
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(bytes < 10 ? 2 : 1) + ' ' + units[i];
}

function setProgress(fillEl, labelEl, pct) {
  fillEl.style.width = pct + '%';
  labelEl.textContent = pct + '%';
}

// ============================================================
//  SENDER SIDE
// ============================================================

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const selectedFileBox = document.getElementById('selectedFile');
const sfName = document.getElementById('sfName');
const sfSize = document.getElementById('sfSize');
const sfRemove = document.getElementById('sfRemove');
const createLinkBtn = document.getElementById('createLinkBtn');

let selectedFile = null;

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) selectFile(fileInput.files[0]);
});
sfRemove.addEventListener('click', (e) => {
  e.stopPropagation();
  selectedFile = null;
  selectedFileBox.classList.add('hidden');
  createLinkBtn.disabled = true;
  fileInput.value = '';
});

function selectFile(file) {
  selectedFile = file;
  sfName.textContent = file.name;
  sfSize.textContent = fmtSize(file.size);
  selectedFileBox.classList.remove('hidden');
  createLinkBtn.disabled = false;
}

let senderWs = null;
let senderPC = null;
let senderChannel = null;
let peerJoinTimer = null;
let fallbackUploadXhr = null;
let roomCode = null;

createLinkBtn.addEventListener('click', startSendFlow);
document.getElementById('cancelSendBtn').addEventListener('click', () => location.reload());
document.getElementById('restartBtn').addEventListener('click', () => location.reload());
document.getElementById('errorRestartBtn').addEventListener('click', () => location.reload());

async function startSendFlow() {
  if (!selectedFile) return;

  const res = await fetch('/api/room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: selectedFile.name, size: selectedFile.size, type: selectedFile.type }),
  });
  const data = await res.json();
  roomCode = data.code;

  const link = `${location.origin}/?room=${roomCode}`;
  document.getElementById('shareLink').value = link;
  showView('waiting');

  senderWs = new WebSocket(WS_URL);
  senderWs.onopen = () => {
    senderWs.send(JSON.stringify({ type: 'register-sender', code: roomCode }));
  };

  senderWs.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'peer-joined') {
      clearTimeout(peerJoinTimer);
      if (fallbackUploadXhr) return; // backup upload already kicked off, let it finish
      document.getElementById('waitingLine').textContent = 'Receiver connected — starting direct transfer…';
      await startP2PSend();
    }

    if (msg.type === 'signal') {
      await handleSenderSignal(msg.data);
    }

    if (msg.type === 'peer-left') {
      // no-op for sender; if mid-transfer this would already have errored the data channel
    }
  };

  // Give the receiver PEER_WAIT_TIMEOUT_MS to show up live; otherwise fall back to temp storage
  peerJoinTimer = setTimeout(() => {
    startFallbackUpload();
  }, PEER_WAIT_TIMEOUT_MS);
}

document.getElementById('copyLinkBtn').addEventListener('click', () => {
  const input = document.getElementById('shareLink');
  input.select();
  navigator.clipboard.writeText(input.value);
  const btn = document.getElementById('copyLinkBtn');
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = 'Copy'), 1500);
});

// ---- P2P send path ----
async function startP2PSend() {
  showView('sending');
  document.querySelector('#view-sending h2').textContent = 'Sending directly…';

  senderPC = new RTCPeerConnection(ICE_SERVERS);
  senderChannel = senderPC.createDataChannel('file', { ordered: true });
  senderChannel.bufferedAmountLowThreshold = 4 * 1024 * 1024; // 4MB

  senderPC.onicecandidate = (e) => {
    if (e.candidate) {
      senderWs.send(JSON.stringify({ type: 'signal', data: { kind: 'ice', candidate: e.candidate } }));
    }
  };

  senderChannel.onopen = () => sendFileOverChannel();

  const offer = await senderPC.createOffer();
  await senderPC.setLocalDescription(offer);
  senderWs.send(JSON.stringify({ type: 'signal', data: { kind: 'offer', sdp: offer } }));
}

async function handleSenderSignal(data) {
  if (data.kind === 'answer') {
    await senderPC.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.kind === 'ice') {
    try { await senderPC.addIceCandidate(data.candidate); } catch (e) {}
  }
}

function sendFileOverChannel() {
  const file = selectedFile;
  const total = file.size;
  let offset = 0;

  // header first: filename/size/type as JSON, so the receiver knows what's coming
  senderChannel.send(JSON.stringify({ __header: true, name: file.name, size: file.size, type: file.type }));

  const reader = new FileReader();

  function sendNextChunk() {
    if (offset >= total) {
      senderChannel.send(JSON.stringify({ __end: true }));
      document.querySelector('#view-sending h2').textContent = 'Done';
      setTimeout(() => {
        document.getElementById('doneTitle').textContent = 'Transfer complete';
        document.getElementById('doneSub').textContent = `${file.name} was sent directly to the other device.`;
        showView('done');
      }, 400);
      return;
    }
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  }

  reader.onload = () => {
    senderChannel.send(reader.result);
    offset += reader.result.byteLength;
    const pct = Math.min(100, Math.round((offset / total) * 100));
    setProgress(document.getElementById('sendProgressFill'), document.getElementById('sendProgressLabel'), pct);

    if (senderChannel.bufferedAmount > senderChannel.bufferedAmountLowThreshold) {
      senderChannel.onbufferedamountlow = () => {
        senderChannel.onbufferedamountlow = null;
        sendNextChunk();
      };
    } else {
      sendNextChunk();
    }
  };

  sendNextChunk();
}

// ---- Fallback: temp storage upload path ----
function startFallbackUpload() {
  showView('waiting');
  document.getElementById('waitingLine').textContent = 'No one connected yet — saving a backup copy so the link still works later…';

  const xhr = new XMLHttpRequest();
  fallbackUploadXhr = xhr;
  xhr.open('PUT', `/api/upload/${roomCode}`);
  xhr.setRequestHeader('Content-Type', selectedFile.type || 'application/octet-stream');

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    document.getElementById('waitingLine').textContent = `Saving backup copy… ${pct}%`;
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      document.getElementById('doneTitle').textContent = 'Link is ready';
      document.getElementById('doneSub').textContent = 'Your file is saved securely and the link will work for the next 48 hours, even if you close this tab.';
      showView('done');
    } else {
      showError('Could not save the backup copy. Please try again.');
    }
  };
  xhr.onerror = () => showError('Upload failed — check your connection and try again.');

  xhr.send(selectedFile);
}

function showError(message) {
  document.getElementById('errorMsg').textContent = message;
  showView('error');
}

// ============================================================
//  RECEIVER SIDE
// ============================================================

const params = new URLSearchParams(location.search);
const incomingCode = params.get('room');

if (incomingCode) {
  showView('receive');
  initReceive(incomingCode);
}

async function initReceive(code) {
  try {
    const res = await fetch(`/api/meta/${code}`);
    const meta = await res.json();

    if (res.status === 404 || meta.status === 'gone') {
      document.getElementById('receiveTitle').textContent = "This link isn't available";
      document.getElementById('receiveSub').textContent = 'It may have expired, already been used, or the sender closed the page before it finished saving.';
      return;
    }

    if (meta.status === 'stored') {
      // simple, fast path: browser handles the download natively
      document.getElementById('receiveTitle').textContent = 'Your file is ready';
      document.getElementById('receiveSub').textContent = `Available until ${new Date(meta.expiresAt).toLocaleString()}.`;
      const box = document.getElementById('incomingFileBox');
      document.getElementById('ifName').textContent = meta.filename;
      document.getElementById('ifSize').textContent = fmtSize(meta.size);
      box.classList.remove('hidden');

      const btn = document.getElementById('downloadBtn');
      btn.classList.remove('hidden');
      btn.textContent = 'Download file';
      btn.onclick = () => { window.location.href = `/api/download/${code}`; };
      return;
    }

    if (meta.status === 'live') {
      document.getElementById('receiveTitle').textContent = 'Connecting to sender…';
      document.getElementById('receiveSub').textContent = 'Setting up a direct, private connection.';
      connectReceiverWS(code);
      return;
    }
  } catch (e) {
    document.getElementById('receiveTitle').textContent = 'Connection problem';
    document.getElementById('receiveSub').textContent = 'Could not reach the server. Check your connection and reload.';
  }
}

let receiverWs, receiverPC, receivedChunks = [], receivedBytes = 0, incomingMeta = null;

function connectReceiverWS(code) {
  receiverWs = new WebSocket(WS_URL);
  receiverWs.onopen = () => receiverWs.send(JSON.stringify({ type: 'join-room', code }));

  receiverWs.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'error') {
      document.getElementById('receiveTitle').textContent = "This link isn't available";
      document.getElementById('receiveSub').textContent = msg.message;
      return;
    }

    if (msg.type === 'joined') {
      incomingMeta = msg.meta;
      document.getElementById('receiveTitle').textContent = 'Connected';
      document.getElementById('receiveSub').textContent = 'Waiting for the transfer to start…';
      const box = document.getElementById('incomingFileBox');
      document.getElementById('ifName').textContent = incomingMeta.filename;
      document.getElementById('ifSize').textContent = fmtSize(incomingMeta.size);
      box.classList.remove('hidden');
      setupReceiverPeer();
    }

    if (msg.type === 'signal') {
      await handleReceiverSignal(msg.data);
    }

    if (msg.type === 'peer-left') {
      document.getElementById('receiveTitle').textContent = 'Sender disconnected';
      document.getElementById('receiveSub').textContent = 'The transfer was interrupted before it finished.';
    }
  };
}

function setupReceiverPeer() {
  receiverPC = new RTCPeerConnection(ICE_SERVERS);

  receiverPC.onicecandidate = (e) => {
    if (e.candidate) {
      receiverWs.send(JSON.stringify({ type: 'signal', data: { kind: 'ice', candidate: e.candidate } }));
    }
  };

  receiverPC.ondatachannel = (e) => {
    const channel = e.channel;
    channel.binaryType = 'arraybuffer';

    channel.onmessage = (msgEvent) => {
      if (typeof msgEvent.data === 'string') {
        const parsed = JSON.parse(msgEvent.data);
        if (parsed.__header) {
          incomingMeta = parsed;
          document.getElementById('progressWrap').classList.remove('hidden');
        } else if (parsed.__end) {
          finishReceive();
        }
        return;
      }
      receivedChunks.push(msgEvent.data);
      receivedBytes += msgEvent.data.byteLength;
      const pct = Math.min(100, Math.round((receivedBytes / incomingMeta.size) * 100));
      setProgress(document.getElementById('progressFill'), document.getElementById('progressLabel'), pct);
    };
  };
}

async function handleReceiverSignal(data) {
  if (data.kind === 'offer') {
    await receiverPC.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await receiverPC.createAnswer();
    await receiverPC.setLocalDescription(answer);
    receiverWs.send(JSON.stringify({ type: 'signal', data: { kind: 'answer', sdp: answer } }));
  } else if (data.kind === 'ice') {
    try { await receiverPC.addIceCandidate(data.candidate); } catch (e) {}
  }
}

function finishReceive() {
  const blob = new Blob(receivedChunks, { type: incomingMeta.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  document.getElementById('progressWrap').classList.add('hidden');
  const btn = document.getElementById('downloadBtn');
  btn.classList.remove('hidden');
  btn.textContent = 'Download file';
  btn.onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = incomingMeta.name || incomingMeta.filename || 'download';
    a.click();
  };

  document.getElementById('receiveTitle').textContent = 'Transfer complete';
  document.getElementById('receiveSub').textContent = 'The file came straight from the sender\u2019s device.';

  // auto-trigger the download once
  btn.click();
}
