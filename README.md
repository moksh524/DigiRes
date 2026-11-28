# DigiRes – Smart Restaurant Billing & Table QR Ordering

## Files
`server.js`, `index.html`, `package.json`, `.gitignore`, `.env.example`, `render.yaml`, `README.md`
(Agar download ke baad `.gitignore` ya `.env.example` ka naam `_.gitignore` / `_.env.example` ho gaya ho to rename karke dot (.) se shuru karo. Zip se extract karoge to naam sahi rahenge.)

## VS Code par chalana
1. Node.js 18+ install karo.
2. `.env.example` ko copy karke `.env` banao, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (8+), `ADMIN_PIN` bharo. Testing ke liye `TEST_MODE=1` rakho.
3. Terminal: `npm install` phir `npm start` -> http://localhost:3000

## GitHub
Repo banao, ye files upload/push karo. `.env`, `data/`, `node_modules/` upload NAHI hone chahiye (`.gitignore` inhe rokta hai).

## Render par live
1. Upstash.com par free Redis banao -> REST URL aur REST TOKEN copy karo (data safe rakhne ke liye zaroori).
2. Render -> New -> Web Service -> apna GitHub repo chuno.
   Build Command: `npm install --omit=dev`  |  Start Command: `npm start`
3. Environment variables:
   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_PIN, SESSION_SECRET, APP_SECRET (koi lamba random text),
   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, FORCE_HTTPS=1,
   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (agar Razorpay chalana ho).
   TEST_MODE live par mat lagao.
4. Deploy hone ke baad Render ka link kholo, admin login karo, Payments & Security mein apna UPI ID daalo.

## UTR se auto-verify (live mode)
Customer UPI se pay karke 12-digit UTR daalta hai. Server tab hi bill PAID karta hai jab bank ka asli "credited" SMS (same UTR, rakam >= bill) uske paas aa chuka ho. Sirf UTR type karne se verify nahi hota (koi bhi random number daal sakta hai).
- **SMS pahunchane ke 2 tareeke** (Owner: Settings -> Auto UTR verification, Admin: Payments & Security):
  1. Bank SMS ko box mein paste karo ya `412345678901 420` (UTR rakam) likho -> "Add received payment".
  2. Full auto: phone ka SMS-forwarder app credit SMS ko `POST https://<tumhari-site>/api/utr-feed` par bheje, JSON: `{"owner":"<ID>","key":"<FEED KEY>","text":"<SMS>"}`. Key private rakho.
- Same UTR do bills par use nahi ho sakta. Kam rakam wala payment match nahi hota.
- Match na ho to fallback: owner "UPI received" dabata hai (subscription mein admin "Payment received").
- Razorpay payments pehle ki tarah apne aap verify hote hain.

## Support
hareshfegade@gmail.com
