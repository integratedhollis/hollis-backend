# Hollis Backend API Documentation

เอกสารข้อกำหนด API ฉบับสมบูรณ์สำหรับโปรเจกต์ **Hollis (ระบบควบคุมหน้าจอ Android ด้วย AI ผ่าน Accessibility Service)**
เอกสารนี้จัดทำขึ้นเพื่อให้ **คนที่ 1 (Android Developer)** และทีมงานนำไปใช้เชื่อมต่อระหว่าง Android Client กับ Cloudflare Workers Backend ได้อย่างถูกต้อง แม่นยำ

* **Production Base URL**: `https://hollis-backend.integrated-hollis.workers.dev`
* **Production WebSocket URL**: `wss://hollis-backend.integrated-hollis.workers.dev`
* **Local Dev Base URL**: `http://127.0.0.1:8787`
* **Local Dev WebSocket URL**: `ws://127.0.0.1:8787`
* **Content-Type**: `application/json; charset=utf-8`
* **Primary Authentication**: **Firebase ID Token (Google Sign-In)**
  * Android Native App ทำการล็อกอินผ่าน Google ด้วย Firebase Auth SDK
  * ส่ง Firebase ID Token ผ่าน Header `Authorization: Bearer <firebase_id_token>` ในทุกๆ Request
  * สำหรับ WebSocket ส่งผ่าน Query: `wss://.../ws/tasks/{session_id}?token=<firebase_id_token>`
  * ระบบมี **Just-In-Time (JIT) Provisioning** สร้างบัญชีและค่า Setting ในฐานข้อมูล D1 อัตโนมัติเมื่อผู้ใช้ล็อกอินครั้งแรก
* **Fallback Authentication**: Custom JWT Token สำหรับระบบเดิมและการทดสอบ
* **Firebase Project ID**: `hollis-edd21`

---

## สารบัญ API ตามหมวดหมู่

1. [คู่มือการเชื่อมต่อ Firebase Google Login บน Android](#-คู่มือการเชื่อมต่อ-firebase-google-login-บน-android)
2. [กลุ่มการยืนยันตัวตน (Authentication) — Epic 1](#1-กลุ่มการยืนยันตัวตน-authentication)
   * `POST /api/auth/verify-token` (ตรวจสอบ Token สำหรับ Splash Screen / Token Verification)
   * `POST /api/auth/logout` (ออกจากระบบ)
   * `POST /api/auth/login` (Fallback: เข้าสู่ระบบแบบเดิม)
   * `POST /api/auth/register` (Fallback: สมัครสมาชิกแบบเดิม)
3. [กลุ่มผู้ใช้และการตั้งค่า (User & Settings) — Epic 5](#2-กลุ่มผู้ใช้และการตั้งค่า-user--settings)
   * `GET /api/users/me` (ดึงข้อมูลโปรไฟล์และการตั้งค่าปัจจุบัน)
   * `PUT /api/users/settings` (อัปเดตการตั้งค่าการยืนยันความเสี่ยง)
4. [กลุ่มการสื่อสารและงานหลัก (Chat & Tasks) — Epic 2](#3-กลุ่มการสื่อสารและงานหลัก-chat--tasks)
   * `POST /api/tasks/start` (เริ่มสร้าง Session งานใหม่)
   * `GET /api/tasks/{session_id}/status` (Polling Fallback ตรวจสอบสถานะงาน)
   * `WS /ws/tasks/{session_id}` (ช่องทาง WebSocket สตรีม Log แบบ Real-time)
   * `POST /api/tasks/{session_id}/cancel` (ยกเลิกงานกลางคัน)
5. [ระบบควบคุมหน้าจอและ AI Agent Loop (Screen Control & Agent Loop) — Epic 3](#4-ระบบควบคุมหน้าจอและ-ai-agent-loop-screen-control--agent-loop--epic-3)
   * `โครงสร้างวงรอบ 5 ขั้นตอน (5-Step Agent Loop)`
   * `การสลับโหมดอัตโนมัติ (Text Mode vs Vision Mode)`
   * `โปรโตคอล WebSocket: observe, action, action_done, risk_confirmation_required`
   * `การตรวจจับลูป (stopped_loop) และจำกัดขั้นตอน (stopped_limit)`
   * `ตัวอย่างโค้ด Android Kotlin สำหรับ Accessibility Service`

---

## 🔑 คู่มือการเชื่อมต่อ Firebase Google Login บน Android

### 1. การดึง Firebase ID Token บน Android (Kotlin)
เมื่อผู้ใช้กดล็อกอินด้วย Google ผ่าน Firebase สำเร็จ ให้ดึง `idToken` ส่งมายัง Backend ดังนี้:

```kotlin
// ดึง Token ปัจจุบัน (forceRefresh = false เพื่อใช้ Token แคช หรือ true หากหมดอายุ)
FirebaseAuth.getInstance().currentUser?.getIdToken(false)
    ?.addOnCompleteListener { task ->
        if (task.isSuccessful) {
            val idToken = task.result?.token
            // นำ idToken ไปใส่ใน Header Authorization
            // Authorization: Bearer $idToken
        } else {
            // จัดการ Error เมื่อดึง Token ไม่สำเร็จ
        }
    }
```

### 2. การเรียกใช้ API ในทุกๆ Request
ทุก HTTP Request ที่ส่งมายัง Backend (ไม่ว่าจะเป็น `/api/tasks/start`, `/api/users/me` ฯลฯ) ให้แนบ Header:
```http
Authorization: Bearer <firebase_id_token>
```

### 3. การเชื่อมต่อ WebSocket ด้วย Firebase Token
```
wss://hollis-backend.integrated-hollis.workers.dev/ws/tasks/{session_id}?token=<firebase_id_token>
```
*(Backend จะตรวจสอบความถูกต้องของ Token กับ Google JWKS และดึง/สร้าง User ใน D1 ให้ทันที)*

---

## 1. กลุ่มการยืนยันตัวตน (Authentication)

### 1.1 `POST /api/auth/google-login` หรือ `POST /api/auth/verify-token` ⭐ (Endpoint หลักสำหรับ Android)
* **บริบทหน้าจอ Android**: 
  * ใช้เมื่อผู้ใช้กดปุ่ม **"Sign in with Google"** ในหน้า Login
  * ใช้ในหน้า **Splash Screen** เพื่อตรวจสอบว่าผู้ใช้ยังล็อกอินอยู่หรือไม่
* **วัตถุประสงค์**: 
  * ส่ง Firebase ID Token ให้ Backend ตรวจสอบกับ Google
  * Backend จะ**ดึงข้อมูลชื่อ (DisplayName), อีเมล (Gmail), รูปโปรไฟล์ (PhotoURL) และ Firebase UID ออกมาจาก Token โดยอัตโนมัติ**
  * **Auto-Register (JIT Provisioning)**: หากผู้ใช้เพิ่งเข้าใช้งานครั้งแรก ระบบจะบันทึกข้อมูลเข้าสู่ฐานข้อมูล D1 และสร้างค่า Setting เริ่มต้นให้อัตโนมัติทันที โดยที่แอปไม่ต้องส่งข้อมูลชื่อหรืออีเมลมาเอง!
  * หากเคยมีบัญชีแล้ว ระบบจะดึงข้อมูลเดิมขึ้นมา
* **Headers**:
  ```http
  Authorization: Bearer <firebase_id_token>
  ```
* **Request Body**:
  * **ไม่ต้องส่ง Body ใดๆ มา** (ส่ง Body ว่างเปล่า `{}` ได้เลย)
  * *(หรือส่ง `{ "id_token": "<firebase_id_token>" }` มาใน Body หากไม่สะดวกแนบ Header)*
* **Response (Success - 200 OK)**:
  ```json
  {
    "valid": true,
    "user_id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
    "email": "somchai@gmail.com",
    "username": "Somchai Jaidee",
    "picture": "https://lh3.googleusercontent.com/a/...",
    "auth_provider": "firebase"
  }
  ```
* **Response (Invalid / Expired Token - 200 OK)**:
  ```json
  {
    "valid": false
  }
  ```
* **คำแนะนำการทำงานบน Android**:
  1. เมื่อผู้ใช้กดปุ่ม Sign-in with Google ผ่าน Firebase บนแอปสำเร็จ จะได้ `idToken`
  2. ยิง `POST /api/auth/google-login` พร้อม Header `Authorization: Bearer <idToken>`
  3. บันทึกข้อมูล Profile ที่ได้รับกลับมาลงใน Local State / SharedPrefs
  4. นำทางเข้าสู่หน้าหลัก (Home/Chat Screen) ทันที
  5. ในการเรียก API อื่นๆ ทั้งหมดหลังจากนี้ (เช่น สั่งงาน Task หรือคุย WebSocket) **ให้แนบ Header `Authorization: Bearer <idToken>` ไปด้วยเสมอ** ไม่ต้องเรียก API Login ซ้ำ

---

### 1.2 `POST /api/auth/logout`
* **บริบทหน้าจอ Android**: ปุ่ม "ออกจากระบบ" บน Panel ตั้งค่า (Settings Panel)
* **Headers**:
  ```http
  Authorization: Bearer <firebase_id_token>
  ```
* **Response (200 OK)**:
  ```json
  {
    "status": "ok",
    "message": "Successfully logged out."
  }
  ```
* **คำแนะนำสำหรับ Android**:
  * สั่ง `FirebaseAuth.getInstance().signOut()` บน Android
  * ลบ Local cache และสลับกลับไปหน้า Login

---

### 1.3 [ระบบเดิมสำรอง] `POST /api/auth/register` และ `POST /api/auth/login` (Legacy Fallback)
> ⚠️ **หมายเหตุ**: ส่วนนี้เป็นระบบ Email/Password ดั้งเดิมที่เก็บไว้เป็นทางเลือกสำรองสำหรับการทดสอบเท่านั้น **แอปจริงที่ใช้ Google Login ไม่ต้องเรียกใช้ 2 ตัวนี้**
* `POST /api/auth/register` รับ `{ username, email, password }`
* `POST /api/auth/login` รับ `{ email, password }` คืน Custom JWT Token
* **Response (Invalid/Expired Token - 200 OK)**:
  ```json
  {
    "valid": false,
    "reason": "Token expired or signature invalid"
  }
  ```
* **คำแนะนำสำหรับ Android**:
  * ถ้ารับ `valid: true` -> นำทางไปหน้าหลัก (Home Screen)
  * ถ้ารับ `valid: false` หรือไม่มี Token ในเครื่อง -> ลบ Token ทิ้งแล้วนำทางไปหน้าเข้าสู่ระบบ (Login Screen)

---

### 1.4 `POST /api/auth/logout`
* **บริบทหน้าจอ Android**: ปุ่ม "ออกจากระบบ" บน Panel ตั้งค่า (Settings Panel)
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  Content-Type: application/json
  ```
* **Response (200 OK)**:
  ```json
  {
    "status": "ok",
    "message": "Successfully logged out."
  }
  ```
* **คำแนะนำสำหรับ Android**:
  * ลบ Token ออกจากเครื่อง ปิด Panel และสลับกลับไปหน้า Login ทันที

---

## 2. กลุ่มผู้ใช้และการตั้งค่า (User & Settings)

### 2.1 `GET /api/users/me`
* **บริบทหน้าจอ Android**: เมื่อเปิด Overlay Panel ตั้งค่า / ดูโปรไฟล์
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  ```
* **Response (200 OK)**:
  ```json
  {
    "user_id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
    "username": "somchai",
    "email": "somchai@example.com",
    "created_at": "2026-09-08T13:00:00.000Z",
    "settings": {
      "confirmation_mode": "popup",
      "max_step_limit": 20,
      "updated_at": "2026-09-08T13:00:00.000Z"
    }
  }
  ```

---

### 2.2 `PUT /api/users/settings`
* **บริบทหน้าจอ Android**: เมื่อผู้ใช้เปลี่ยนตัวเลือกรูปแบบการขอยืนยันความเสี่ยงบน Panel ตั้งค่า
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  Content-Type: application/json
  ```
* **Request Body**:
  ```json
  {
    "confirmation_mode": "popup", 
    "max_step_limit": 20
  }
  ```
  *(ค่าที่รองรับสำหรับ `confirmation_mode`: `"popup"`, `"push"`, `"none"`)*
* **Response (200 OK)**:
  ```json
  {
    "success": true,
    "message": "Settings updated",
    "settings": {
      "user_id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
      "confirmation_mode": "popup",
      "max_step_limit": 20,
      "updated_at": "2026-09-08T13:10:00.000Z"
    }
  }
  ```
* **คำแนะนำสำหรับ Android**:
  * การบันทึกเกิดขึ้นทันทีที่ผู้ใช้คลิกเปลี่ยน Radio Button โดยไม่ต้องมีปุ่ม "บันทึก" แยก

---

## 3. กลุ่มการสื่อสารและงานหลัก (Chat & Tasks) — Epic 2

### 3.1 `POST /api/tasks/start`
* **บริบทหน้าจอ Android**: เมื่อผู้ใช้พิมพ์คำสั่งในช่อง Free-text Input บนหน้าหลัก แล้วกดปุ่ม "ส่ง" (Send Button)
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  Content-Type: application/json
  ```
* **Request Body**:
  ```json
  {
    "instruction": "เปิดแอป LINE แล้วส่งข้อความหาสมศรีว่า ถึงแล้วนะ"
  }
  ```
* **Response (Success - 201 Created)**:
  ```json
  {
    "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
    "status": "running"
  }
  ```
* **Response (Error - 400 Bad Request)**:
  ```json
  {
    "error": "invalid_input",
    "message": "instruction is required and must be a string."
  }
  ```
* **Response (Error - 401 Unauthorized)**:
  ```json
  {
    "error": "unauthorized",
    "message": "Missing or malformed Authorization header."
  }
  ```
* **คำแนะนำสำหรับ Android**:
  1. เมื่อกดส่ง ให้เพิ่มข้อความคำสั่งของผู้ใช้ลงในหน้าจอแชททันที (ฟองข้อความชิดขวา)
  2. สลับปุ่มส่งข้อความเป็นปุ่ม "หยุดการทำงาน" (Stop / Cancel Button) สีแดง
  3. นำ `session_id` ที่ได้รับไปเปิดการเชื่อมต่อ WebSocket ทันทีตามข้อ 3.3

---

### 3.2 `GET /api/tasks/{session_id}/status` (Polling Fallback)
* **บริบทหน้าจอ Android**: ช่องทางสำรอง (HTTP Polling Fallback) ใช้ตรวจสอบสถานะงานและข้อความ Log ล่าสุด เมื่อเกิดปัญหาเครือข่าย หรือ WebSocket หลุดการเชื่อมต่อ
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  ```
* **Response (Success - 200 OK)**:
  ```json
  {
    "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
    "status": "running",
    "current_step": 2,
    "last_log": "Analyzing UI hierarchy"
  }
  ```
* **Response (Error - 404 Not Found)**:
  ```json
  {
    "error": "task_not_found",
    "message": "Task session not found."
  }
  ```
  *(หมายเหตุ: ระบบแยกสิทธิ์ผู้ใช้อย่างเคร่งครัด หาก Session เป็นของ User อื่น จะตอบกลับด้วย 404 เพื่อป้องกันการสแกนหา Session ID)*

---

### 3.3 `WS /ws/tasks/{session_id}` (Real-Time WebSocket Gateway)
* **บริบทหน้าจอ Android**: การเชื่อมต่อ Real-time Duplex Streaming ระหว่างที่ AI กำลังทำงาน
* **URL (Local Dev)**: `ws://127.0.0.1:8787/ws/tasks/{session_id}?token=<access_token>`
* **URL (Production)**: `wss://<worker-domain>/ws/tasks/{session_id}?token=<access_token>`
* **การส่ง Token ยืนยันตัวตน (Authentication)**:
  * **วิธีที่แนะนำ (Primary)**: ส่งผ่าน Query Parameter `?token=<access_token>` (เข้ากันได้กับไลบรารีทุกภาษา)
  * **วิธีทางเลือก (Secondary)**: ส่งผ่าน Handshake Request Header `Authorization: Bearer <access_token>`
* **HTTP Handshake Response Status Codes**:
  * `101 Switching Protocols`: ยืนยัน Token และ Session ถูกต้อง อัปเกรดเป็น WebSocket สำเร็จ
  * `401 Unauthorized`: ไม่มี Token, Token หมดอายุ หรือไม่ใช่ Access Token
  * `404 Not Found`: ไม่พบ `session_id` หรือ Session นั้นไม่ได้เป็นของผู้ใช้ที่ล็อกอินอยู่
  * `426 Upgrade Required`: ไม่ได้ส่ง Header `Upgrade: websocket`

#### รูปแบบข้อความที่ Backend ส่งให้ Android (Server -> Client)

1. **Event: `connected` (ยืนยันการเชื่อมต่อสำเร็จ)**:
   ส่งทันทีหลัง Handshake 101 สำเร็จ เพื่อแจ้งสถานะเริ่มต้นของ Session
   ```json
   {
     "event": "connected",
     "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
     "status": "running",
     "message": "Connected to task log stream"
   }
   ```

2. **Event: `log` (ความคืบหน้าของขั้นตอนการทำงาน)**:
   ส่งตามลำดับขั้นตอนการทำงานอัตโนมัติ (แต่ละขั้นตอนจะถูกบันทึกลง D1 `task_steps` ด้วย)
   ```json
   {
     "event": "log",
     "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
     "step_no": 1,
     "log_message": "Initializing screen capture",
     "timestamp": "2026-09-28T10:50:00.000Z",
     "is_risky": false,
     "action_type": "init"
   }
   ```
   *คำแนะนำ Android*: นำ `log_message` มาเพิ่มลงใน Bubble ฝั่ง AI (ชิดซ้าย) ในหน้าต่างแชท และสั่ง Auto-scroll ให้เลื่อนลงมาแสดงข้อความล่าสุด

3. **Event: `finished` (งานเสร็จสมบูรณ์เรียบร้อย)**:
   ส่งเมื่อ AI ปฏิบัติงานครบทุกขั้นตอนอย่างสมบูรณ์ และ Backend อัปเดตสถานะใน D1 เป็น `'completed'` แล้ว จากนั้นการเชื่อมต่อ WebSocket จะถูกปิดลงอย่างสุภาพ (Code 1000)
   ```json
   {
     "event": "finished",
     "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
     "status": "completed",
     "total_steps": 5,
     "step_count": 5,
     "summary_message": "งานเสร็จสมบูรณ์เรียบร้อยแล้ว"
   }
   ```
   *คำแนะนำ Android*: แสดง Bubble สรุปสถานะความสำเร็จ และสลับปุ่มหยุดกลับมาเป็นปุ่มส่งตามปกติ

4. **Event: `cancelled` (งานถูกยกเลิก)**:
   ส่งเมื่อมีการยกเลิกงาน (ทั้งจากการเรียก `POST /api/tasks/{session_id}/cancel` หรือส่งข้อความ `{"event": "cancel"}` ใน WebSocket) จากนั้น Socket จะปิดลงอย่างสุภาพ (Code 1000)
   ```json
   {
     "event": "cancelled",
     "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
     "status": "cancelled",
     "summary_message": "งานถูกยกเลิกโดยผู้ใช้"
   }
   ```
   *คำแนะนำ Android*: แสดง Bubble แจ้งผู้ใช้ว่า "งานถูกยกเลิกแล้ว" และสลับปุ่มหยุดกลับมาเป็นปุ่มส่ง

5. **Event: `pong` (ตอบรับ Heartbeat)**:
   ส่งตอบกลับเมื่อ Client ส่ง Ping มา
   ```json
   {
     "event": "pong",
     "timestamp": "2026-09-28T10:50:05.123Z"
   }
   ```

6. **Event: `error` (แจ้งเตือนข้อผิดพลาดของข้อความ / Invalid Message Format)**:
   ส่งเมื่อ Client ส่งข้อความที่ไม่ได้อยู่ในรูปแบบ JSON หรือ payload ไม่ถูกต้อง โดยที่การเชื่อมต่อ WebSocket ยังคงเปิดอยู่ ไม่ถูกตัดการเชื่อมต่อ (Resilient error handling)
   ```json
   {
     "event": "error",
     "message": "Invalid message format"
   }
   ```
   *ฟิลด์ข้อมูล*:
   * `event` (string): ค่าคงที่ `"error"`
   * `message` (string): รายละเอียดของข้อผิดพลาด เช่น `"Invalid message format"`

   *คำแนะนำ Android*: ใช้สำหรับดักจับข้อผิดพลาดในระดับ Application Payload บน WebSocket เมื่อส่งข้อมูลผิดรูปแบบ เพื่อแสดง Log หรือเตือนนักพัฒนา โดยไม่ต้องเริ่มต้นเชื่อมต่อ WebSocket ใหม่

#### รูปแบบข้อความที่ Android ส่งให้ Backend (Client -> Server)

1. **Event: `ping` (Heartbeat รักษาการเชื่อมต่อ)**:
   แนะนำให้ส่งทุก 20-30 วินาที เพื่อป้องกัน NAT/Proxy ตัดการเชื่อมต่อ
   ```json
   {
     "event": "ping"
   }
   ```

2. **Event: `cancel` (การยกเลิกงานผ่าน WebSocket โดยตรง)**:
   Client สามารถส่งข้อความนี้ผ่านช่อง WebSocket ที่เชื่อมต่ออยู่เพื่อยกเลิกงานได้ทันที โดยไม่ต้องยิง REST API แยก
   ```json
   {
     "event": "cancel"
   }
   ```

---

### 3.4 `POST /api/tasks/{session_id}/cancel` (REST Cancellation)
* **บริบทหน้าจอ Android**: เมื่อผู้ใช้กดปุ่ม "หยุดการทำงาน" (Stop Button) บนหน้าจอแชท
* **Headers**:
  ```http
  Authorization: Bearer <access_token>
  ```
* **Response (Success - 200 OK)**:
  ```json
  {
    "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
    "status": "cancelled"
  }
  ```
* **Response (Idempotent - 200 OK กรณีงานสิ้นสุดไปก่อนแล้ว)**:
  ```json
  {
    "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
    "status": "cancelled",
    "message": "Task is already completed or stopped."
  }
  ```
* **Response (Error - 404 Not Found)**:
  ```json
  {
    "error": "task_not_found",
    "message": "Task session not found."
  }
  ```
* **กลไกการทำงานเบื้องหลัง**:
  1. Backend จะอัปเดตสถานะในตาราง `sessions` ใน D1 เป็น `status = 'cancelled'` และบันทึก `ended_at`
  2. Backend จะส่งข้อความ `{ "event": "cancelled", ... }` ไปยัง WebSocket ที่เปิดอยู่ของ Session นั้นทันที และปิดการเชื่อมต่อด้วย Code 1000

---

### 3.5 ตัวอย่างการเชื่อมต่อด้วย OkHttp (Android Kotlin Sample Guide)

```kotlin
val wsUrl = "ws://127.0.0.1:8787/ws/tasks/$sessionId?token=$accessToken"
val request = Request.Builder().url(wsUrl).build()

val client = OkHttpClient.Builder()
    .pingInterval(25, TimeUnit.SECONDS) // หรือใช้ JSON ping heartbeat
    .build()

val webSocket = client.newWebSocket(request, object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.d("HollisWS", "Connected to task stream")
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val json = JSONObject(text)
        when (json.optString("event")) {
            "connected" -> {
                Log.d("HollisWS", "Task running: ${json.optString("session_id")}")
            }
            "log" -> {
                val stepNo = json.optInt("step_no")
                val logMsg = json.optString("log_message")
                // อัปเดตหน้าจอ Chat UI เพิ่ม Bubble ทางฝั่ง AI
                runOnUiThread {
                    chatAdapter.addAiMessage("ขั้นตอนที่ $stepNo: $logMsg")
                    recyclerView.scrollToPosition(chatAdapter.itemCount - 1)
                }
            }
            "finished" -> {
                runOnUiThread {
                    chatAdapter.addAiMessage("✅ งานเสร็จสมบูรณ์เรียบร้อยแล้ว")
                    btnSend.visibility = View.VISIBLE
                    btnStop.visibility = View.GONE
                }
            }
            "cancelled" -> {
                runOnUiThread {
                    chatAdapter.addAiMessage("🛑 งานถูกยกเลิกโดยผู้ใช้")
                    btnSend.visibility = View.VISIBLE
                    btnStop.visibility = View.GONE
                }
            }
            "pong" -> {
                Log.d("HollisWS", "Heartbeat pong received")
            }
            "error" -> {
                val errMsg = json.optString("message")
                Log.w("HollisWS", "Server error warning: $errMsg")
            }
        }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        Log.d("HollisWS", "Connection closed: $code / $reason")
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Log.e("HollisWS", "WebSocket error: ${t.message}")
        // กรณีหลุดการเชื่อมต่อ สามารถสลับไปใช้ GET /api/tasks/$sessionId/status เพื่อ Polling แทนได้
    }
})
```

---

## 4. ระบบควบคุมหน้าจอและ AI Agent Loop (Mobile Agent System) — Epic 3

ระบบควบคุมหน้าจอดำเนินการผ่านวงรอบอัจฉริยะ **ReAct Agent Loop (Observe-Reason-Act-Verify)** แบบ 2 ทาง (Duplex) ระหว่าง Cloudflare Workers Backend กับ Android Client ผ่านช่องทาง WebSocket พร้อมกลไก **Strict Tool Calling (7 Tools มาตรฐาน)** และ **In-Memory Element ID Mapping**:

```
    ┌───────────┐      observe (screen_elements: id: 0, 1, 2)     ┌──────────────┐
    │           │ <─────────────────────────────────────────── │              │
    │           │                 1. Observe                   │              │
    │  Hollis   │                 2. Decide (Groq / OpenRouter)│   Android    │
    │  Backend  │                 3. Risk Check                │ Accessibility│
    │(AI Agent) │                                              │   Service    │
    │           │      action: tool_name + typed parameters    │ (In-Memory   │
    │           │ ───────────────────────────────────────────> │  Cache Map)  │
    │           │                 4. Act (Execution Precedence)│              │
    │           │ <─────────────────────────────────────────── │              │
    │           │      action_done (new screen_elements)       │              │
    └───────────┘                 5. Verify (DOM Diff)         └──────────────┘
```

---

### 4.1 วงรอบการทำงาน (ReAct Loop Lifecycle)

1. **Observe (สังเกตการณ์ & Semantic Pruning)**:
   * ฝั่ง Android ทำการ Prune เฉพาะโหนดที่มีคุณสมบัติ `isVisibleToUser == true` และ Interactive (`isClickable`, `isEditable`, `isCheckable` หรือมี `text`/`contentDescription`) พร้อมกำหนดรหัสลำดับ **`id: 0, 1, 2, ...`** ลงใน In-Memory Cache บนมือถือ
   * ส่ง Array `screen_elements` ขึ้นมายัง Backend
   * **Hybrid Fallback Trigger**: หากพบ Interactive Node รวมกัน **น้อยกว่า 2 ตัว** หรือเป็น Canvas/Game ให้ถ่ายภาพหน้าจอเป็น WebP (720p) ส่งมาในฟิลด์ `screenshot` เพื่อสลับไปใช้สายตา (Vision Mode)
2. **Decide (ตัดสินใจผ่าน Strict Tool Calling)**:
   * **Text Mode (ความเร็วสูง & ประหยัดต้นทุน)**: หากมี Interactive Node >= 2 ตัว ระบบจะแปลงโครงสร้างเป็น **One-line String format** และส่งให้ Groq (`gpt-oss-120b`) ตัดสินใจผ่าน Function Calling
   * **Vision Mode (วิเคราะห์รูปภาพ)**: สลับไปใช้ OpenRouter (`Qwen3-VL`) พร้อมส่งภาพ Screenshot ไปคำนวณพิกัด
   * **Validation Guard**: หากโมเดลคืนผลลัพธ์ไม่ตรง Tool Schema ระบบจะ Auto-Retry 1 ครั้งทันทีด้วย `temperature: 0.0`
3. **Risk Check (ประเมินความเสี่ยง)**:
   * **Risk Engine (`check_risk`)**: ตรวจสอบคำสั่งและพารามิเตอร์กับคีย์เวิร์ดที่มีความเสี่ยง (เช่น "ส่ง", "ลบ", "โอน", "ยืนยัน", "จ่าย", "ซื้อ", "pay", "delete", "buy", "confirm", "transfer")
   * หากเข้าข่ายเสี่ยง และผู้ใช้ตั้งค่า `confirmation_mode !== 'none'`: ระบบจะหยุดรอ (Pause) และส่ง event `risk_confirmation_required` เพื่อรอให้ผู้ใช้อนุมัติ
4. **Act (ส่งคำสั่งปฏิบัติการ 7 Tools)**:
   * ส่ง Event `action` ระบุชื่อ Tool และพารามิเตอร์แบบ Typed ส่งตรงให้ Android ดำเนินการ
5. **Verify (ตรวจสอบผลลัพธ์)**:
   * เมื่อ Android ทำงานเสร็จ จะส่ง `action_done` พร้อมโครงสร้างหน้าจอใหม่กลับมา
   * บันทึกข้อมูลแต่ละขั้นตอนลงตาราง `task_steps` ใน D1

---

### 4.2 สัญญาข้อมูล 8 Tools มาตรฐาน (API Contract)

โมเดล AI ถูกบังคับให้เลือก 1 ใน 8 Tools ต่อไปนี้ในแต่ละขั้นตอน ห้ามส่งข้อความอิสระ (Free-form text) ระหว่างภารกิจ:

| ชื่อ Tool (Function Name) | พารามิเตอร์ที่จำเป็น (Schema) | วัตถุประสงค์และเงื่อนไขการทำงาน |
| :--- | :--- | :--- |
| `open_app` | `app_name: String`, `package_name: String (Optional)` | สั่งเปิดแอปพลิเคชันบนมือถือผ่าน Launch Intent เช่น LINE, YouTube, Shopee, Settings โดยตรงแทนการสไลด์หาไอคอน |
| `click_element` | `element_id: Integer`, `target_description: String` | สั่งกดปุ่มหรือ View ตามรหัส ID จาก UI Tree (แม่นยำสูงสุด $O(1)$) |
| `click_coordinate` | `x: Int`, `y: Int`, `target_description: String` | สั่งแตะพิกัดหน้าจอโดยตรง ใช้เมื่อ UI Tree มองไม่เห็นโหนดหรือทำงานกับ Canvas |
| `input_text` | `element_id: Int`, `text: String` | สั่งกรอกข้อความลงในช่อง EditText ผ่าน Set Text Argument |
| `swipe_screen` | `direction: Enum ["UP", "DOWN", "LEFT", "RIGHT"]` | สั่งปัดหรือเลื่อนหน้าจอตามทิศทางเพื่อค้นหาเนื้อหาที่อยู่นอกจอ |
| `system_navigation` | `action: Enum ["BACK", "HOME", "RECENTS"]` | สั่งกดปุ่มควบคุมระบบปฏิบัติการ เช่น กดย้อนกลับ หรือกลับหน้าโฮม |
| `wait_and_poll` | `duration_ms: Integer` (500 - 3000) | สั่งหยุดรอให้หน้าจอโหลดข้อมูลหรือรอแอนิเมชันเสร็จสิ้น |
| `task_finish` | `status: Enum ["success", "failed"]`, `message: String` | แจ้งสิ้นสุดภารกิจ พร้อมข้อความสรุปผลลัพธ์ภาษาไทยแจ้งผู้ใช้ |

---

### 4.3 โปรโตคอลข้อความ WebSocket ระหว่าง Android และ Backend

#### 1. Android -> Backend: Event `observe` (ส่งสถานะหน้าจอเริ่มต้นหรือขั้นตอนใหม่)

```json
{
  "event": "observe",
  "screen_elements": [
    {
      "id": 0,
      "class": "EditText",
      "text": "ค้นหาเพื่อน",
      "clickable": true,
      "editable": true
    },
    {
      "id": 1,
      "class": "Button",
      "text": "ส่งข้อความ",
      "clickable": true
    }
  ],
  "screenshot": null
}
```
*(กรณีที่หน้าจอมี Interactive Element < 2 ตัว ให้ส่งภาพ WebP Base64 แนบมาในฟิลด์ `"screenshot"`)*

> [!TIP]
> **รูปแบบชื่อ Class (`class`)**:
> - **แนะนำให้ใช้ชื่อสั้น (Short Name)**: เช่น `"Button"`, `"EditText"`, `"TextView"` (ตัด Package Name ด้วย `node.className?.toString()?.substringAfterLast('.') ?: "View"`) เพื่อประหยัดขนาด Payload ของ WebSocket บนเครือข่ายมือถือได้กว่า 30-50%
> - **รองรับชื่อเต็ม (Full Name)**: หากฝั่ง Android ส่งชื่อเต็ม เช่น `"android.widget.Button"` หรือ `"androidx.appcompat.widget.AppCompatEditText"` ทาง Backend มีตัวแปลง `.split('.').pop()` รองรับโดยอัตโนมัติเช่นกัน

#### 2. Backend -> Android: Event `action` (คำสั่งให้ Android นำไปปฏิบัติการ)

```json
{
  "event": "action",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "step_no": 1,
  "step_id": "d1a6b0c2-5e4f-4d32-9c12-87a419ef89ab",
  "tool": "click_element",
  "tool_name": "click_element",
  "parameters": {
    "element_id": 1,
    "target_description": "ปุ่มส่งข้อความ"
  },
  "action": {
    "action_type": "click_element",
    "target": "ปุ่มส่งข้อความ",
    "element_id": 1,
    "log_message": "กดปุ่มหรือโหนด ID [1] (ปุ่มส่งข้อความ)",
    "is_completed": false
  },
  "mode_used": "text",
  "is_risky": false
}
```

#### 3. Android -> Backend: Event `action_done` (รายงานผลการกระทำ)

ส่งหลังจาก Android ดำเนินการคำสั่งบนหน้าจอเสร็จสิ้น พร้อมส่งโครงสร้างหน้าจอใหม่ที่เปลี่ยนแปลง:

```json
{
  "event": "action_done",
  "step_no": 1,
  "status": "ok",
  "screen_elements": [
    {
      "id": 0,
      "class": "TextView",
      "text": "ส่งข้อความเรียบร้อยแล้ว"
    }
  ],
  "screenshot": null
}
```

> [!IMPORTANT]
> **กรณีคำสั่ง `task_finish` (สิ้นสุดภารกิจ)**:
> เมื่อ Android ได้รับ `event: "action"` ที่มี `tool: "task_finish"` **ไม่ต้องส่ง `action_done` กลับมายัง Backend**!
> * เนื่องจากภารกิจเสร็จสิ้นแล้ว Backend จะบันทึกสถานะลงฐานข้อมูล และส่ง `event: "finished"` ตามมาทันที พร้อมปิด WebSocket ด้วย Code 1000
> * สิ่งที่แอปต้องทำคือ: แสดงข้อความสรุปผลลัพธ์ (Toast/TTS) จาก `parameters.message` และรอรับ `event: "finished"` เพื่ออัปเดต UI หน้าจอเป็นเสร็จสิ้นสมบูรณ์

#### 4. Backend -> Android: Event `risk_confirmation_required` (ขออนุมัติการกระทำความเสี่ยง)

ส่งเมื่อตรวจพบการกระทำอันตราย (โอนเงิน, ลบข้อมูล, ยืนยันคำสั่งซื้อ ฯลฯ) และระบบกำลังรอการยืนยันจากผู้ใช้:

```json
{
  "event": "risk_confirmation_required",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "step_no": 2,
  "step_id": "89b7fa12-e304-44ac-9701-d7a8c32bc611",
  "action": {
    "action_type": "click_element",
    "tool_name": "click_element",
    "parameters": {
      "element_id": 3,
      "target_description": "ปุ่ม ยืนยันการโอนเงิน"
    },
    "target": "ปุ่ม ยืนยันการโอนเงิน",
    "log_message": "กดปุ่มยืนยันการโอนเงิน",
    "is_completed": false
  },
  "matched_keyword": "โอน",
  "confirmation_mode": "popup",
  "message": "การกระทำนี้มีความเสี่ยง (\"โอน\") ต้องการการยืนยันจากผู้ใช้"
}
```

*เมื่อผู้ใช้กดปุ่ม*:
* **อนุมัติ**: ส่ง `{"event": "confirm", "approved": true}` ผ่าน WebSocket หรือยิง `POST /api/tasks/{session_id}/confirm` ด้วย body `{"approved": true}`
* **ปฏิเสธ**: ส่ง `{"event": "confirm", "approved": false}` ระบบจะยกเลิกงานทันที

#### 5. Backend -> Android: Event `finished` (งานเสร็จสมบูรณ์)

```json
{
  "event": "finished",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "status": "completed",
  "total_steps": 5,
  "step_count": 5,
  "summary_message": "โอนเงินและส่งสลิปให้เพื่อนเรียบร้อยแล้ว"
}
```

---

### 4.4 แนวทางการปฏิบัติจริงสำหรับ Frontend / Android Developer (Tool Execution & open_app)

#### 1. การตั้งค่า `AndroidManifest.xml` (จำเป็นสำหรับ Android 11+ / API 30+)
เนื่องจาก Android 11 ขึ้นไปมีระบบจำกัดการมองเห็นแพ็กเกจ (Package Visibility Restrictions) เพื่อให้แอป Hollis สามารถตรวจสอบและสั่งเปิดแอปพลิเคชันอื่นบนเครื่องได้ จำเป็นต้องประกาศแท็ก `<queries>` ใน `AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- อนุญาตให้ Hollis มองเห็นและสั่งเปิดแอปพลิเคชัน Launcher ทุกตัวในเครื่อง -->
    <queries>
        <intent>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent>
    </queries>

    <application ...>
        <!-- Service & Activities -->
    </application>
</manifest>
```

---

#### 2. ตัวอย่างโค้ด Kotlin สำหรับ Accessibility Service (8 Tools Handler)

```kotlin
class HollisAccessibilityService : AccessibilityService() {

    // 1. In-Memory Mapping Cache: เก็บความสัมพันธ์ id: Int -> WeakReference<AccessibilityNodeInfo>
    private val elementCache = mutableMapOf<Int, WeakReference<AccessibilityNodeInfo>>()

    // ฟังก์ชัน Prune Node และสร้าง ID แบบลำดับ (0, 1, 2, ...)
    fun pruneAndCacheScreen(): JSONArray {
        elementCache.clear()
        val elementsArray = JSONArray()
        var currentId = 0

        fun traverse(node: AccessibilityNodeInfo?) {
            if (node == null || !node.isVisibleToUser) return

            val isInteractive = node.isClickable || node.isEditable || node.isCheckable
            val text = (node.text ?: node.contentDescription ?: "").toString().trim()

            if (isInteractive || text.isNotEmpty()) {
                val elementId = currentId++
                elementCache[elementId] = WeakReference(node)

                val item = JSONObject().apply {
                    put("id", elementId)
                    put("class", node.className?.toString()?.substringAfterLast('.') ?: "View")
                    put("text", text)
                    put("clickable", node.isClickable)
                    put("editable", node.isEditable)
                    put("checkable", node.isCheckable)
                }
                elementsArray.put(item)
            }

            for (i in 0 until node.childCount) {
                traverse(node.getChild(i))
            }
        }

        traverse(rootInActiveWindow)
        return elementsArray
    }

    // ฟังก์ชันแปลงชื่อแอปเป็น Package Name (มี Built-in Mapping ยอดนิยม + Dynamic Lookup)
    private fun resolvePackageName(appName: String): String? {
        val commonApps = mapOf(
            "line" to "jp.naver.line.android",
            "youtube" to "com.google.android.youtube",
            "facebook" to "com.facebook.katana",
            "chrome" to "com.android.chrome",
            "settings" to "com.android.settings",
            "ตั้งค่า" to "com.android.settings",
            "shopee" to "com.shopee.th",
            "lazada" to "com.lazada.android",
            "tiktok" to "com.zhiliaoapp.musically",
            "gmail" to "com.google.android.gm",
            "maps" to "com.google.android.apps.maps",
            "แผนที่" to "com.google.android.apps.maps"
        )
        val normalized = appName.trim().lowercase()
        commonApps[normalized]?.let { return it }

        // Dynamic search through installed launcher applications
        val pm = applicationContext.packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        val resolveList = pm.queryIntentActivities(mainIntent, 0)
        for (info in resolveList) {
            val label = info.loadLabel(pm).toString().lowercase()
            if (label.contains(normalized)) {
                return info.activityInfo.packageName
            }
        }
        return null
    }

    // 2. การประมวลผลคำสั่ง 8 Tools ที่ได้รับจาก Backend
    fun executeToolAction(toolName: String, params: JSONObject, onDone: (Boolean) -> Unit) {
        when (toolName) {
            "open_app" -> {
                val appName = params.getString("app_name")
                val explicitPkg = params.optString("package_name").takeIf { it.isNotEmpty() }
                val targetPkg = explicitPkg ?: resolvePackageName(appName)

                if (targetPkg != null) {
                    val launchIntent = packageManager.getLaunchIntentForPackage(targetPkg)
                    if (launchIntent != null) {
                        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(launchIntent)
                        // ให้เวลาระบบ Android สลับหน้าต่างและโหลด UI ของแอปใหม่ (~1200ms) ก่อนส่ง action_done
                        Handler(Looper.getMainLooper()).postDelayed({
                            onDone(true)
                        }, 1200L)
                    } else {
                        Toast.makeText(applicationContext, "ไม่สามารถเปิดแอป: $appName ได้", Toast.LENGTH_SHORT).show()
                        onDone(false)
                    }
                } else {
                    Toast.makeText(applicationContext, "ไม่พบแอป: $appName บนเครื่องนี้", Toast.LENGTH_SHORT).show()
                    onDone(false)
                }
            }

            "click_element" -> {
                val elementId = params.getInt("element_id")
                val nodeRef = elementCache[elementId]?.get()
                if (nodeRef != null && nodeRef.refresh()) {
                    val success = nodeRef.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    onDone(success)
                } else {
                    onDone(false) // Fallback ไปใช้ click_coordinate หากโหนดหลุด
                }
            }

            "input_text" -> {
                val elementId = params.getInt("element_id")
                val text = params.getString("text")
                val nodeRef = elementCache[elementId]?.get()
                if (nodeRef != null && nodeRef.refresh()) {
                    val arguments = Bundle().apply {
                        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
                    }
                    val success = nodeRef.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
                    onDone(success)
                } else {
                    onDone(false)
                }
            }

            "click_coordinate" -> {
                val x = params.getInt("x").toFloat()
                val y = params.getInt("y").toFloat()
                dispatchSingleTapGesture(x, y) { success -> onDone(success) }
            }

            "swipe_screen" -> {
                val direction = params.getString("direction")
                dispatchDirectionalSwipe(direction) { success -> onDone(success) }
            }

            "system_navigation" -> {
                val action = params.getString("action")
                val globalAction = when (action) {
                    "BACK" -> GLOBAL_ACTION_BACK
                    "HOME" -> GLOBAL_ACTION_HOME
                    "RECENTS" -> GLOBAL_ACTION_RECENTS
                    else -> GLOBAL_ACTION_BACK
                }
                val success = performGlobalAction(globalAction)
                onDone(success)
            }

            "wait_and_poll" -> {
                val durationMs = params.optLong("duration_ms", 1000L)
                Handler(Looper.getMainLooper()).postDelayed({ onDone(true) }, durationMs)
            }

            "task_finish" -> {
                val msg = params.optString("message", "ภารกิจเสร็จสมบูรณ์")
                Toast.makeText(applicationContext, msg, Toast.LENGTH_LONG).show()
                // จบภารกิจ: ไม่ต้องส่ง action_done กลับไปยัง Backend (ให้รอรับ event: "finished" เพื่ออัปเดตหน้าจอและปิด Socket)
            }
        }
    }
}
```

