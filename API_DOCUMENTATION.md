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

## 4. ระบบควบคุมหน้าจอและ AI Agent Loop (Screen Control & Agent Loop) — Epic 3

ระบบควบคุมหน้าจอดำเนินการผ่านวงรอบอัจฉริยะ **5-Step Agent Loop** แบบ 2 ทาง (Duplex) ระหว่าง Cloudflare Workers Backend กับ Android Client ผ่าน WebSocket:

```
    ┌───────────┐       observe (screen_tree/screenshot)       ┌──────────────┐
    │           │ <─────────────────────────────────────────── │              │
    │           │                 1. Observe                   │              │
    │  Hollis   │                 2. Decide (Text vs Vision)   │   Android    │
    │  Backend  │                 3. Risk Check                │ Accessibility│
    │(AI Agent) │                                              │   Service    │
    │           │       action / log / confirmation            │              │
    │           │ ───────────────────────────────────────────> │              │
    │           │                 4. Act                       │              │
    │           │ <─────────────────────────────────────────── │              │
    │           │      action_done (new screen_tree)           │              │
    └───────────┘                 5. Verify (DOM Diff)         └──────────────┘
```

---

### 4.1 วงรอบการทำงาน 5 ขั้นตอน (5-Step Agent Loop Cycle)

1. **Observe (สังเกตการณ์)**:
   * Client ส่งข้อมูลหน้าจอปัจจุบันประกอบด้วย Accessibility Hierarchy Tree (`screen_tree`) และภาพหน้าจอ Base64 (`screenshot` เมื่อจำเป็น)
2. **Decide (ตัดสินใจ)**:
   * **Tree Quality Engine (`check_tree_quality`)**: วิเคราะห์จำนวน Clickable Nodes, Text Elements, Total Nodes และระดับความลึก (Hierarchy Depth)
   * **Text Mode (ความเร็วสูง & ประหยัดต้นทุน)**: หาก Accessibility Tree มีความสมบูรณ์เพียงพอ ระบบจะเลือกใช้ Groq Cloud (`gpt-oss-120b`) ในรูปแบบ JSON Structured Output
   * **Vision Mode (วิเคราะห์รูปภาพ)**: หาก Accessibility Tree ว่างเปล่าหรือเป็น Custom Canvas/Game/WebView ระบบจะสลับไปใช้ OpenRouter (`Qwen3-VL`) พร้อมส่งภาพ Screenshot ไปวิเคราะห์
3. **Risk Check (ประเมินความเสี่ยง)**:
   * **Risk Engine (`check_risk`)**: ตรวจสอบคำสั่งและเป้าหมายกับคีย์เวิร์ดที่มีความเสี่ยง (เช่น "ส่ง", "ลบ", "โอน", "ยืนยัน", "จ่าย", "ซื้อ", "pay", "delete", "buy", "confirm", "transfer")
   * หากเข้าข่ายเสี่ยง และผู้ใช้ตั้งค่า `confirmation_mode !== 'none'`: ระบบจะหยุดรอ (Pause) และส่ง event `risk_confirmation_required` เพื่อรอให้ผู้ใช้อนุมัติ
4. **Act (ส่งคำสั่งปฏิบัติการ)**:
   * ส่งกรอบคำสั่ง `action` และข้อความความคืบหน้า `log` ให้ Android Client ดำเนินการกด, แตะ, พิมพ์ หรือเลื่อนหน้าจอ
5. **Verify (ตรวจสอบผลลัพธ์)**:
   * เมื่อ Android ทำงานเสร็จ จะส่ง `action_done` พร้อมโครงสร้างหน้าจอใหม่กลับมา
   * **Structural Diff Engine (`verify_step`)**: เปรียบเทียบความแตกต่างเชิงโครงสร้าง DOM/Node ระหว่างก่อนและหลังทำ action เพื่อคำนวณ `verified_changed` (0 หรือ 1)
   * บันทึกข้อมูลแต่ละขั้นตอนลงตาราง `task_steps` ใน D1 อย่างเป็นอิสระ (Atomic Persistence)

---

### 4.2 เงื่อนไขการสิ้นสุดการทำงานอัตโนมัติ (Termination Conditions)

1. **Goal Completion (`finished`)**:
   * เมื่อ AI บรรลุเป้าหมายคำสั่งของผู้ใช้ (`is_completed: true` หรือ `action_type: 'complete'`)
   * ระบบอัปเดตตาราง `sessions.status = 'completed'` ใน D1 และส่ง event `finished` พร้อมปิดการเชื่อมต่อด้วย Code 1000
2. **Loop Detection (`stopped_loop`)**:
   * หากหน้าจอไม่มีการเปลี่ยนแปลงติดต่อกัน 3 ครั้ง (`verified_changed === 0` ต่อเนื่อง 3 steps)
   * ระบบจะตัดวงจรหยุดการทำงานอัตโนมัติ อัปเดต `sessions.status = 'stopped_loop'` ใน D1 และส่ง event `stopped_loop` เพื่อป้องกันการติดลูปไม่รู้จบ
3. **Step Limit Enforcer (`stopped_limit`)**:
   * หากจำนวนขั้นตอนถึงขีดจำกัดสูงสุดของผู้ใช้ (`step_count >= max_step_limit`, ค่าเริ่มต้น 20 ขั้นตอน)
   * ระบบจะหยุดการทำงานอัตโนมัติ อัปเดต `sessions.status = 'stopped_limit'` ใน D1 และส่ง event `stopped_limit`

---

### 4.3 โปรโตคอลข้อความ WebSocket ระหว่าง Android และ Backend

#### 1. Android -> Backend: Event `observe` (ส่งสถานะหน้าจอเริ่มต้นหรือขั้นตอนใหม่)

ส่งเมื่อเริ่มต้น Session หรือเมื่อต้องการให้ Agent วิเคราะห์หน้าจอ:

```json
{
  "event": "observe",
  "screen_tree": {
    "class": "android.widget.FrameLayout",
    "children": [
      {
        "id": "com.linecorp.line:id/chat_search",
        "class": "android.widget.EditText",
        "text": "ค้นหาชื่อเพื่อน",
        "clickable": true
      },
      {
        "id": "com.linecorp.line:id/btn_send",
        "class": "android.widget.Button",
        "text": "ส่งข้อความ",
        "clickable": true
      }
    ]
  },
  "screenshot": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}
```

#### 2. Backend -> Android: Event `action` (คำสั่งที่ให้ Android นำไปปฏิบัติการ)

ส่งเมื่อ Agent ตัดสินใจเลือกขั้นตอนถัดไปเรียบร้อยแล้ว:

```json
{
  "event": "action",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "step_no": 1,
  "step_id": "d1a6b0c2-5e4f-4d32-9c12-87a419ef89ab",
  "action": {
    "action_type": "tap",
    "target": "ปุ่มส่งข้อความ",
    "target_id": "com.linecorp.line:id/btn_send",
    "coordinates": null,
    "text": null,
    "log_message": "กำลังกดปุ่มส่งข้อความ",
    "is_completed": false
  },
  "mode_used": "text",
  "is_risky": false
}
```

*ประเภทของ `action_type`*:
* `"tap"`: สั่งคลิก/แตะที่องค์ประกอบเป้าหมายตาม `target_id` หรือ `coordinates: { "x": 0.5, "y": 0.5 }`
* `"type_text"`: สั่งพิมพ์ข้อความที่ระบุในฟิลด์ `text`
* `"scroll_down"` / `"scroll_up"`: สั่งเลื่อนหน้าจอลงหรือขึ้น
* `"back"` / `"home"`: สั่งกดปุ่ม Back หรือ Home
* `"complete"`: งานเสร็จสิ้นแล้ว

#### 3. Android -> Backend: Event `action_done` (รายงานผลการกระทำ)

ส่งหลังจาก Android ดำเนินการคำสั่งบนหน้าจอเสร็จสิ้น พร้อมส่งโครงสร้างหน้าจอใหม่ที่เปลี่ยนแปลง:

```json
{
  "event": "action_done",
  "step_no": 1,
  "status": "ok",
  "screen_tree": {
    "class": "android.widget.FrameLayout",
    "children": [
      {
        "class": "android.widget.TextView",
        "text": "ส่งข้อความเรียบร้อยแล้ว"
      }
    ]
  },
  "screenshot": null
}
```

#### 4. Backend -> Android: Event `risk_confirmation_required` (ขออนุมัติการกระทำความเสี่ยง)

ส่งเมื่อตรวจพบการกระทำอันตราย (โอนเงิน, ลบข้อมูล, ยืนยันคำสั่งซื้อ ฯลฯ) และระบบกำลังรอการยืนยันจากผู้ใช้:

```json
{
  "event": "risk_confirmation_required",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "step_no": 2,
  "step_id": "89b7fa12-e304-44ac-9701-d7a8c32bc611",
  "action": {
    "action_type": "tap",
    "target": "ปุ่ม ยืนยันการโอนเงิน",
    "target_id": "btn_confirm_transfer",
    "log_message": "กดปุ่มยืนยันการโอนเงิน",
    "is_completed": false
  },
  "matched_keyword": "โอน",
  "confirmation_mode": "popup",
  "message": "การกระทำนี้มีความเสี่ยง (\"โอน\") ต้องการการยืนยันจากผู้ใช้"
}
```

*คำแนะนำ Android*:
* แสดง Native AlertDialog หรือ BottomSheet แจ้งเตือนผู้ใช้ทันที
* แสดงชื่อเป้าหมาย (`target`) และเหตุผลความเสี่ยง
* เมื่อผู้ใช้กดปุ่ม:
  * หาก **"อนุมัติ"**: ส่ง `{"event": "confirm", "approved": true}` ผ่าน WebSocket หรือยิง `POST /api/tasks/{session_id}/confirm` ด้วย body `{"approved": true}`
  * หาก **"ปฏิเสธ"**: ส่ง `{"event": "confirm", "approved": false}` ระบบจะยกเลิกงานทันที

#### 5. Android -> Backend: Event `confirm` (ส่งผลการอนุมัติความเสี่ยง)

```json
{
  "event": "confirm",
  "approved": true
}
```

#### 6. Backend -> Android: Event `stopped_loop` (หยุดทำงานเนื่องจากตรวจพบลูป)

```json
{
  "event": "stopped_loop",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "status": "stopped_loop",
  "total_steps": 3,
  "step_count": 3,
  "summary_message": "ตรวจพบลูปการทำงานซ้ำซ้อน 3 ครั้งโดยหน้าจอไม่เปลี่ยนแปลง ระบบหยุดการทำงานโดยอัตโนมัติ"
}
```

#### 7. Backend -> Android: Event `stopped_limit` (หยุดทำงานเนื่องจากเกินลิมิตขั้นตอน)

```json
{
  "event": "stopped_limit",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "status": "stopped_limit",
  "total_steps": 20,
  "step_count": 20,
  "summary_message": "จำนวนขั้นตอนถึงขีดจำกัดสูงสุด (20 ขั้นตอน) ระบบหยุดการทำงานอัตโนมัติ"
}
```

---

### 4.4 ตัวอย่างโค้ด Android Kotlin สำหรับการเชื่อมต่อ Epic 3 Agent Loop

```kotlin
// 1. เชื่อมต่อ WebSocket ในโหมด Interactive
val wsUrl = "wss://hollis-backend.integrated-hollis.workers.dev/ws/tasks/$sessionId?token=$token&mode=interactive"
val request = Request.Builder().url(wsUrl).build()

val webSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
        // เมื่อเชื่อมต่อสำเร็จ ส่ง observe แรกของหน้าจอปัจจุบัน
        val screenTreeJson = accessibilityService.captureScreenTreeAsJson()
        val observePayload = JSONObject().apply {
            put("event", "observe")
            put("screen_tree", screenTreeJson)
        }
        webSocket.send(observePayload.toString())
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val json = JSONObject(text)
        when (json.optString("event")) {
            "action" -> {
                val stepNo = json.optInt("step_no")
                val actionObj = json.getJSONObject("action")
                val actionType = actionObj.optString("action_type")
                
                // สั่งให้ Accessibility Service ดำเนินการบนหน้าจอจริง
                accessibilityService.executeAction(actionObj) { success ->
                    // เมื่อทำเสร็จ จับหน้าจอใหม่ส่ง action_done กลับไป
                    val updatedTree = accessibilityService.captureScreenTreeAsJson()
                    val donePayload = JSONObject().apply {
                        put("event", "action_done")
                        put("step_no", stepNo)
                        put("status", if (success) "ok" else "error")
                        put("screen_tree", updatedTree)
                    }
                    webSocket.send(donePayload.toString())
                }
            }

            "risk_confirmation_required" -> {
                val keyword = json.optString("matched_keyword")
                val msg = json.optString("message")
                
                // แสดง Popup Dialog บนหน้าจอผู้ใช้
                runOnUiThread {
                    AlertDialog.Builder(context)
                        .setTitle("⚠️ ยืนยันการกระทำที่มีความเสี่ยง")
                        .setMessage(msg)
                        .setPositiveButton("อนุญาต") { _, _ ->
                            webSocket.send(JSONObject().apply {
                                put("event", "confirm")
                                put("approved", true)
                            }.toString())
                        }
                        .setNegativeButton("ยกเลิก") { _, _ ->
                            webSocket.send(JSONObject().apply {
                                put("event", "confirm")
                                put("approved", false)
                            }.toString())
                        }
                        .setCancelable(false)
                        .show()
                }
            }

            "stopped_loop" -> {
                runOnUiThread {
                    Toast.makeText(context, "ระบบหยุดการทำงาน: ตรวจพบลูปซ้ำซ้อน", Toast.LENGTH_LONG).show()
                }
            }

            "stopped_limit" -> {
                runOnUiThread {
                    Toast.makeText(context, "ระบบหยุดการทำงาน: เกินจำนวนขั้นตอนที่กำหนด", Toast.LENGTH_LONG).show()
                }
            }

            "finished" -> {
                runOnUiThread {
                    Toast.makeText(context, "งานสำเร็จเรียบร้อยแล้ว!", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
})
```

