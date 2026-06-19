# Tarru — Device-to-device file transfer (no storage limit)

Ye tool 2 tareekon se kaam karta hai:

1. **Live P2P (sabse fast, sabse safe)** — Agar dono log (sender + receiver) ek hi waqt online hain, file seedhi ek browser se doosre browser mein WebRTC ke through jaati hai. Server file ko touch tak nahi karta.
2. **Backup storage (agar receiver turant nahi aata)** — Agar 15 second ke andar koi connect nahi hota, file automatically server pe temporarily save ho jaati hai aur link **48 ghante** tak kaam karta hai. 48 ghante baad file khud-ba-khud delete ho jaati hai, isliye storage kabhi bharta nahi.

Dono mode mein file **256KB chunks** mein bhejta hai, isliye chahe video 50GB ka ho, upload/transfer kabhi atakta nahi.

---

## Local pe chalane ke liye

```bash
cd p2p-transfer
npm install
npm start
```

Browser mein kholo: `http://localhost:3000`

Test karne ke liye: ek tab mein file select karo aur "Create link" dabao, link copy karke doosre tab/incognito window mein kholo.

---

## Free hosting pe deploy karna (Render.com — recommended)

1. Is poore folder ko GitHub repo mein push karo
2. [render.com](https://render.com) pe jaake "New Web Service" banao, apna GitHub repo connect karo
3. Build command: `npm install`
4. Start command: `npm start`
5. Deploy hone ke baad tumhe ek public URL milega (jaise `https://tarru.onrender.com`) — wahi link logon ko bhejna hai

> Render ka free tier disk storage restart hone pe reset ho jaata hai — chhote/medium scale ke liye theek hai. Bade scale (hazaaron users) ke liye Step "Production ke liye aage badhana" dekho.

### Alternative: Railway.app
Same steps — repo connect karo, `npm start` set karo, deploy.

---

## Production ke liye aage badhana (jab users badhne lagein)

Abhi backup file disk pe (`/storage` folder) save hoti hai — ye chhote scale ke liye thik hai lekin do cheezein dhyan rakhna:

1. **Server restart hone pe in-memory room data (`rooms` Map) khatam ho jaata hai.** Production ke liye isे Redis ya kisi halki database (SQLite/Postgres) mein move karo.
2. **Bahut zyada users ke liye disk ki jagah bhi khatam ho sakti hai.** Tab `/storage` folder ki jagah ek **object storage** use karo jiska free/cheap tier bahut bada hota hai aur per-account quota nahi hota:
   - **Cloudflare R2** — free egress, $0.015/GB storage
   - **Backblaze B2** — sasta aur reliable
   
   Sirf `app.put('/api/upload/:code', ...)` aur `app.get('/api/download/:code', ...)` ke andar disk read/write ki jagah us provider ka SDK use karna hoga — baaki sara logic (links, 48hr expiry, P2P) same rahega.

---

## File structure

```
p2p-transfer/
├── server.js          → signaling (WebRTC) + REST API (room/upload/download) + auto-cleanup
├── package.json
├── storage/            → backup files yahan temporarily save hote hain (auto-created)
└── public/
    ├── index.html      → saara UI (sender + receiver, ek hi page mein)
    ├── style.css
    └── script.js       → P2P logic + fallback upload logic
```
