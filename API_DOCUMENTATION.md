# Hollis Backend API Documentation

เอกสารข้อกำหนด API ฉบับสมบูรณ์สำหรับโปรเจกต์ **Hollis (ระบบควบคุมหน้าจอ Android ด้วย AI ผ่าน Accessibility Service)**
เอกสารนี้จัดทำขึ้นเพื่อให้ **คนที่ 1 (Android Developer)** และทีมงานนำไปใช้เชื่อมต่อระหว่าง Android Client กับ Cloudflare Workers Backend ได้อย่างถูกต้อง แม่นยำ

* **Base URL (Local Dev)**: `http://127.0.0.1:8787`
* **Base WebSocket URL (Local Dev)**: `ws://127.0.0.1:8787`
* **Content-Type**: `application/json; charset=utf-8`
* **Authentication**: ส่ง JWT Token ผ่าน Header `Authorization: Bearer <access_token>`

---

## สารบัญ API ตามหมวดหมู่

1. [กลุ่มการยืนยันตัวตน (Authentication) — Epic 1](#1-กลุ่มการยืนยันตัวตน-authentication)
   * `POST /api/auth/register` (สมัครสมาชิกใหม่)
   * `POST /api/auth/login` (เข้าสู่ระบบ)
   * `POST /api/auth/verify-token` (ตรวจสอบ Token สำหรับ Splash Screen)
   * `POST /api/auth/logout` (ออกจากระบบ)
2. [กลุ่มผู้ใช้และการตั้งค่า (User & Settings) — Epic 5](#2-กลุ่มผู้ใช้และการตั้งค่า-user--settings)
   * `GET /api/users/me` (ดึงข้อมูลโปรไฟล์และการตั้งค่าปัจจุบัน)
   * `PUT /api/users/settings` (อัปเดตการตั้งค่าการยืนยันความเสี่ยง)
3. [กลุ่มการสื่อสารและงานหลัก (Chat & Tasks) — Epic 2](#3-กลุ่มการสื่อสารและงานหลัก-chat--tasks)
   * `POST /api/tasks/start` (เริ่มสร้าง Session งานใหม่)
   * `GET /api/tasks/{session_id}/status` (Polling Fallback ตรวจสอบสถานะงาน)
   * `WS /ws/tasks/{session_id}` (ช่องทาง WebSocket สตรีม Log แบบ Real-time)
   * `POST /api/tasks/{session_id}/cancel` (ยกเลิกงานกลางคัน)

---

## 1. กลุ่มการยืนยันตัวตน (Authentication)

### 1.1 `POST /api/auth/register`
* **บริบทหน้าจอ Android**: Popup สมัครสมาชิก (Register Popup บนหน้า Login)
* **วัตถุประสงค์**: สร้างบัญชีผู้ใช้ใหม่ พร้อมสร้างค่าเริ่มต้นในตาราง `user_settings` ให้อัตโนมัติ และส่ง `access_token` กลับมาเพื่อให้เข้าสู่หน้าหลักได้ทันที
* **Headers**:
  ```http
  Content-Type: application/json
  ```
* **Request Body**:
  ```json
  {
    "username": "somchai",
    "email": "somchai@example.com",
    "password": "Password123!"
  }
  ```
* **Response (Success - 201 Created)**:
  ```json
  {
    "user_id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
      "username": "somchai",
      "email": "somchai@example.com"
    }
  }
  ```
* **Response (Error - 400 Bad Request)**:
  ```json
  {
    "error": "email_already_exists",
    "message": "Email is already registered."
  }
  ```
* **คำแนะนำสำหรับ Android**:
  * เมื่อได้รับ `access_token` ให้บันทึกลงใน `EncryptedSharedPreferences` หรือ `DataStore` ทันที
  * ปิด Register Popup แล้วเปลี่ยนหน้าไปที่หน้าหลัก (Home/Chat) โดยไม่ต้องบังคับให้ผู้ใช้ล็อกอินซ้ำ

---

### 1.2 `POST /api/auth/login`
* **บริบทหน้าจอ Android**: หน้าเข้าสู่ระบบ (Login Screen)
* **วัตถุประสงค์**: ยืนยันตัวตนด้วยอีเมลและรหัสผ่าน
* **Headers**:
  ```http
  Content-Type: application/json
  ```
* **Request Body**:
  ```json
  {
    "email": "somchai@example.com",
    "password": "Password123!"
  }
  ```
* **Response (Success - 200 OK)**:
  ```json
  {
    "user_id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
      "username": "somchai",
      "email": "somchai@example.com"
    }
  }
  ```
* **Response (Error - 401 Unauthorized)**:
  ```json
  {
    "error": "invalid_credentials",
    "message": "Invalid email or password."
  }
  ```
* **คำแนะนำสำหรับ Android**:
  * หากได้ 401 ให้แสดงข้อความแจ้งเตือนใต้ช่องกรอกรหัสผ่านว่า "อีเมลหรือรหัสผ่านไม่ถูกต้อง" โดยไม่ต้องเปลี่ยนหน้า

---

### 1.3 `POST /api/auth/verify-token`
* **บริบทหน้าจอ Android**: หน้าจอเริ่มต้น (Splash Screen)
* **วัตถุประสงค์**: ตรวจสอบว่า `access_token` ที่เก็บไว้ในเครื่องยังถูกต้องและไม่หมดอายุหรือไม่
* **Headers**:
  ```http
  Content-Type: application/json
  ```
* **Request Body**:
  ```json
  {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```
  *(หรือส่งผ่าน Header `Authorization: Bearer <token>` ได้เช่นกัน)*
* **Response (Valid Token - 200 OK)**:
  ```json
  {
    "valid": true,
    "user_id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
    "user": {
      "id": "8b5d3c87-9bb3-4ff7-b125-103328e1b641",
      "email": "somchai@example.com",
      "username": "somchai"
    }
  }
  ```
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
